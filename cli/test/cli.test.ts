import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CommandsManifest } from "@fontego/core";
import { BUILTIN_NAMES } from "../src/builtins.ts";
import { checkCommand, commandsCachePath } from "../src/declared.ts";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let s: TestServer;
let ana: { token: string; id: number };
let home: string;

/** `input`: what comes on stdin, which is then not a terminal. */
async function fontego(args: string[], env: Record<string, string> = {}, input?: string) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    // Never the real keychain or browser: credentials go to a file in the test home, and links are not opened.
    env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", FONTEGO_INSTANCE: "", FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

beforeAll(async () => {
  s = await startTestServer();
  home = tempDir("fontego-cli-home-");
  ana = await s.person("ana@example.org", "Ana");
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "notes", name: "Notes", category: "personal" });
  await s.call(s.adminToken, "PUT", "/v1/workspaces/notes/members/ana@example.org", { role: "editor" });
  await s.call(ana.token, "POST", "/v1/workspaces/notes/changes", {
    baseCommit: null,
    message: "Seed",
    ops: [
      { op: "put", path: "travel/japan.md", content: "# Japan\nKyoto in April.\n", baseHash: null },
      { op: "put", path: "README.md", content: "My notes\n", baseHash: null },
    ],
  });
});
afterAll(async () => {
  await s.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("fontego CLI", () => {
  test("without login it says what to do", async () => {
    const r = await fontego(["workspaces"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("fontego login");
  });

  test("login verifies the token and saves it 0600", async () => {
    expect((await fontego(["login", s.url, "--token", "fontego_bad"])).code).toBe(2);
    const r = await fontego(["login", s.url, "--token", ana.token, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.user.email).toBe("ana@example.org");
    expect(statSync(out.config).mode & 0o777).toBe(0o600);
  });

  test("explores with --json", async () => {
    const list = JSON.parse((await fontego(["workspaces", "--json"])).out);
    expect(list.workspaces.map((w: any) => [w.slug, w.role, w.category])).toEqual([["notes", "editor", "personal"]]);
    const ls = JSON.parse((await fontego(["ls", "notes", "--json"])).out);
    expect(ls.entries.map((e: any) => e.path).sort()).toEqual(["README.md", "travel"]);
    const lsr = (await fontego(["ls", "notes", "travel"])).out;
    expect(lsr).toContain("travel/japan.md");
    expect((await fontego(["cat", "notes", "travel/japan.md"])).out).toBe("# Japan\nKyoto in April.\n");
    const cat = JSON.parse((await fontego(["cat", "notes", "README.md", "--json"])).out);
    expect(cat).toMatchObject({ text: true, content: "My notes\n" });
    expect(cat.hash).toMatch(/^[0-9a-f]{40}$/);
    // Bytes that wouldn't come back from text go as base64, untouched.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    await s.call(ana.token, "PUT", "/v1/workspaces/notes/files/latin1.txt", { contentBase64: latin1.toString("base64") });
    const raw = JSON.parse((await fontego(["cat", "notes", "latin1.txt", "--json"])).out);
    expect(raw).toMatchObject({ text: false, contentBase64: latin1.toString("base64") });
    await s.call(ana.token, "DELETE", "/v1/workspaces/notes/files/latin1.txt", { baseHash: raw.hash });
    const found = JSON.parse((await fontego(["search", "notes", "kyoto", "--json"])).out);
    expect(found.hits).toEqual([{ path: "travel/japan.md", line: 2, text: "Kyoto in April." }]);
    const log = (await fontego(["log", "notes"])).out;
    expect(log).toContain("Seed");
  });

  test("errors carry a hint and a stable exit code", async () => {
    const r = await fontego(["cat", "notes", "nope.md", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe("not_found");
    expect((await fontego(["info", "secret-ws"])).code).toBe(3);
  });

  test("FONTEGO_URL and FONTEGO_TOKEN work without a saved login", async () => {
    const other = tempDir("fontego-cli-empty-");
    const r = await fontego(["whoami", "--json"], { XDG_CONFIG_HOME: other, FONTEGO_URL: s.url, FONTEGO_TOKEN: ana.token });
    expect(JSON.parse(r.out).user.email).toBe("ana@example.org");
    rmSync(other, { recursive: true, force: true });
  });

  test("clone, edit, status and sync from the command line", async () => {
    const parent = tempDir("fontego-cli-clone-");
    const dir = `${parent}/notes`;
    const cloned = JSON.parse((await fontego(["clone", "notes", dir, "--json"])).out);
    expect(cloned.pulled.length).toBe(2);
    expect((await fontego(["clone", "notes", dir])).code).toBe(1); // not empty
    await Bun.write(`${dir}/travel/japan.md`, "# Japan\nKyoto in April, Osaka in May.\n");
    const st = JSON.parse((await fontego(["status", dir, "--json"])).out);
    expect(st.modified).toEqual(["travel/japan.md"]);
    const synced = JSON.parse((await fontego(["sync", dir, "--json"])).out);
    expect(synced.pushed).toEqual([{ path: "travel/japan.md", status: "put" }]);
    expect((await fontego(["status", `${dir}/travel`])).out).toContain("Nothing to send.");
    expect((await fontego(["cat", "notes", "travel/japan.md"])).out).toContain("Osaka");
    expect((await fontego(["conflicts", dir, "--json"])).out).toContain('"conflicts": []');
    expect((await fontego(["status", parent])).code).toBe(1); // not a synced folder
    rmSync(parent, { recursive: true, force: true });
  });

  test("status counts what the ignore rules keep here, and check-ignore says which rule", async () => {
    const parent = tempDir("fontego-cli-ignore-");
    const dir = `${parent}/notes`;
    expect((await fontego(["clone", "notes", dir])).code).toBe(0);
    await Bun.write(`${dir}/.fontegoignore`, "*.log\ntravel/\n");
    await Bun.write(`${dir}/run.log`, "x\n");
    await Bun.write(`${dir}/cache/a.tmp`, "x\n");
    await Bun.write(`${dir}/.fontego/ignore`, "cache/\n");
    const st = await fontego(["status", dir]);
    expect(st.out).toContain("new       .fontegoignore");
    expect(st.out).toContain("2 ignored here (fontego status --ignored lists them");
    expect(st.out).toMatch(/note: travel\/japan\.md matches \.fontegoignore:2 \(travel\/\), through the folder travel\/ but is in the workspace, so it keeps syncing\. To take it out of the workspace \(the copy here stays\): fontego rm notes travel\/japan\.md --base [0-9a-f]{40}/);
    expect((await fontego(["status", dir, "--ignored"])).out).toContain("ignored   cache/\nignored   run.log");
    const json = JSON.parse((await fontego(["status", dir, "--json"])).out);
    expect(json.ignored).toEqual(["cache/", "run.log"]);
    expect(json.trackedIgnored[0]).toMatchObject({ path: "travel/japan.md", source: ".fontegoignore", line: 2, folder: "travel" });

    const why = await fontego(["check-ignore", `${dir}/run.log`]);
    expect([why.code, why.out.trim()]).toEqual([0, ".fontegoignore:1:*.log\trun.log"]);
    expect((await fontego(["check-ignore", `${dir}/cache/a.tmp`])).out).toContain(".fontego/ignore:1:cache/");
    const not = await fontego(["check-ignore", `${dir}/README.md`]);
    expect([not.code, not.out.trim()]).toEqual([1, "README.md is not ignored."]);
    const tracked = JSON.parse((await fontego(["check-ignore", `${dir}/travel/japan.md`, "--json"])).out);
    expect(tracked).toMatchObject({ path: "travel/japan.md", ignored: true, tracked: true, pattern: "travel/" });
    rmSync(parent, { recursive: true, force: true });
  });

  test("link sends up a folder that already exists, and keeps both on a clash", async () => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "fresh" });
    await s.call(s.adminToken, "PUT", "/v1/workspaces/fresh/members/ana@example.org", { role: "editor" });
    const dir = tempDir("fontego-cli-link-");
    await Bun.write(`${dir}/a.md`, "a\n");
    await Bun.write(`${dir}/sub/b.md`, "b\n");
    const linked = JSON.parse((await fontego(["link", "fresh", dir, "--json"])).out);
    expect(linked.pushed.map((p: any) => p.path).sort()).toEqual(["a.md", "sub/b.md"]);
    expect((await fontego(["link", "fresh", `${dir}/sub`])).code).toBe(1); // already synced
    // A second folder with a clashing file: the server's version wins in place, ours goes to a copy.
    const other = tempDir("fontego-cli-link2-");
    await Bun.write(`${other}/a.md`, "different\n");
    await Bun.write(`${other}/c.md`, "c\n");
    const second = JSON.parse((await fontego(["link", "fresh", other, "--json"])).out);
    expect(second.conflicts).toHaveLength(1);
    expect(await Bun.file(`${other}/a.md`).text()).toBe("a\n");
    expect(await Bun.file(`${other}/${second.conflicts[0].copy}`).text()).toBe("different\n");
    expect(await Bun.file(`${other}/sub/b.md`).text()).toBe("b\n");
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  test("two links of one folder at once: one sends it, the other finds it taken; the state matches the files", async () => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "twice" });
    await s.call(s.adminToken, "PUT", "/v1/workspaces/twice/members/ana@example.org", { role: "editor" });
    const dir = tempDir("fontego-cli-twice-");
    for (let n = 0; n < 300; n++) await Bun.write(`${dir}/f${n}.md`, `file ${n}\n`);
    const [a, b] = await Promise.all([fontego(["link", "twice", dir, "--json"]), fontego(["link", "twice", dir, "--json"])]);
    expect([a.code, b.code].sort()).toEqual([0, 1]);
    const loser = a.code === 1 ? a : b;
    expect(loser.out).toMatch(/already synced|working in this folder/);
    const st = JSON.parse((await fontego(["status", dir, "--json"])).out);
    expect([st.added, st.modified, st.deleted]).toEqual([[], [], []]);
    const state = JSON.parse(readFileSync(join(dir, ".fontego/state.json"), "utf8"));
    expect(Object.keys(state.files)).toHaveLength(300);
    const tree = (await s.call(ana.token, "GET", "/v1/workspaces/twice/tree?recursive=1")).data.entries;
    expect(tree.filter((e: any) => e.type === "blob")).toHaveLength(300);
    expect(readdirSync(join(dir, ".fontego")).filter((f) => f.endsWith(".tmp") || f.startsWith("lock"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sync while watch runs is refused; a lock left behind is taken", async () => {
    const parent = tempDir("fontego-cli-locked-");
    const dir = join(parent, "notes");
    expect((await fontego(["clone", "notes", dir])).code).toBe(0);
    const watch = Bun.spawn(["bun", MAIN, "watch", dir, "--json"], {
      env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", FONTEGO_INSTANCE: "", FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none" },
      stdout: "ignore",
      stderr: "ignore",
    });
    const t0 = Date.now();
    while (!existsSync(join(dir, ".fontego/lock")) && Date.now() - t0 < 10_000) await Bun.sleep(50);
    const refused = await fontego(["sync", dir, "--json"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out).error.code).toBe("locked");
    expect(JSON.parse(refused.out).error.message).toContain("fontego watch");
    watch.kill("SIGTERM");
    await watch.exited;
    expect(existsSync(join(dir, ".fontego/lock"))).toBe(false); // given back on the way out
    // A lock whose process is gone (killed, a crash) doesn't keep the folder locked.
    writeFileSync(join(dir, ".fontego/lock"), JSON.stringify({ pid: Bun.spawnSync(["true"]).pid, host: hostname(), command: "fontego watch" }));
    expect((await fontego(["sync", dir])).code).toBe(0);
    expect(existsSync(join(dir, ".fontego/lock"))).toBe(false);
    rmSync(parent, { recursive: true, force: true });
  });

  test("help for agents is Markdown", async () => {
    const r = await fontego(["help", "--agent"]);
    expect(r.out.startsWith("# Using `fontego` from an agent")).toBe(true);
  });
});

describe("commands the server declares", () => {
  const asAdmin = () => ({ FONTEGO_URL: s.url, FONTEGO_TOKEN: s.adminToken });

  test("this CLI can run every command the server declares, and has every built-in it expects", async () => {
    const m = (await s.call(ana.token, "GET", "/v1/commands")).data as CommandsManifest;
    expect(m.commands.length).toBeGreaterThan(5);
    for (const b of m.builtins) expect(BUILTIN_NAMES).toContain(b);
    expect(m.commands.flatMap((c) => checkCommand(c, BUILTIN_NAMES))).toEqual([]);
    const help = (await fontego(["help"])).out;
    for (const c of m.commands.filter((c) => !c.admin)) expect(help).toContain(`fontego ${c.name}`);
    expect(help).not.toContain("fontego admin users"); // Ana isn't a server admin
    expect((await fontego(["help"], asAdmin())).out).toContain("fontego admin users add EMAIL");
  });

  test("tables and records for people, the API's answer with --json", async () => {
    const list = (await fontego(["workspaces"])).out;
    expect(list.split("\n")[0]).toMatch(/^WORKSPACE\s+ROLE\s+CATEGORY\s+NAME$/);
    expect(list).toContain("notes");
    const info = (await fontego(["info", "notes"])).out; // an alias of workspace info
    expect(info).toContain("Notes (notes)");
    expect(info).toContain("your role: editor");
    expect((await fontego(["whoami"])).out).toContain(`ana@example.org on ${s.url}`);
    expect((await fontego(["ls", "notes", "-r"])).out).toContain("travel/japan.md");
  });

  test("an admin manages workspaces, members, people and tokens from the CLI", async () => {
    const env = asAdmin();
    expect((await fontego(["workspace", "create", "shared", "--name", "Shared", "--category", "team"], env)).out).toContain("Workspace shared created");
    expect((await fontego(["admin", "users", "add", "bea@example.org", "--name", "Bea"], env)).out).toContain("User bea@example.org created");
    const set = await fontego(["members", "set", "shared", "bea@example.org", "reader"], env);
    expect(set.out).toMatch(/bea@example\.org\s+reader\s+Bea/);
    expect((await fontego(["workspace", "edit", "shared", "--description", "For everyone"], env)).out).toContain("Updated shared.");
    const token = JSON.parse((await fontego(["admin", "tokens", "create", "bea@example.org", "--agent", "--label", "Bea's agent", "--json"], env)).out);
    expect(token.kind).toBe("agent");
    const bea = await fontego(["whoami", "--json"], { FONTEGO_URL: s.url, FONTEGO_TOKEN: token.token });
    expect(JSON.parse(bea.out).credential).toMatchObject({ type: "token", kind: "agent", label: "Bea's agent" });
    expect((await fontego(["members", "remove", "shared", "bea@example.org"], env)).out).toContain("bea@example.org is no longer in shared.");
    // Ana is no admin: the server says no, with the usual exit codes.
    expect((await fontego(["admin", "users"])).code).toBe(5);
    expect((await fontego(["members", "set", "notes", "nobody@example.org", "reader"])).code).toBe(5);
  });

  test("an admin starts a workspace from a template, or imports a Git repository the server can reach", async () => {
    const env = asAdmin();
    const templates = await fontego(["workspace", "templates"], env);
    expect(templates.out).toMatch(/demo\s+built-in/);
    const made = await fontego(["workspace", "create", "bakery", "--template", "demo"], env);
    expect(made.code).toBe(0);
    expect(made.out).toContain("Workspace bakery created; you are its admin.");
    expect(made.out).toContain("11 files from the template demo.");
    const files = JSON.parse((await fontego(["ls", "bakery", "--json"], env)).out);
    expect(JSON.stringify(files)).toContain("AGENTS.md");
    // Only https through the API: a path on the server's disk is refused before anything is made.
    const local = await fontego(["workspace", "create", "sneaky", "--git", "/etc", "--json"], env);
    expect(local.code).not.toBe(0);
    expect(JSON.parse(local.out).error.code).toBe("invalid_url");
    expect((await fontego(["workspace", "create", "both", "--branch", "main"], env)).code).not.toBe(0);
  });

  test("an admin invites people from the CLI; without mail, the link to pass on is right there", async () => {
    const env = asAdmin();
    const inv = await fontego(["admin", "users", "invite", "cai@example.org", "--name", "Cai"], env);
    expect(inv.out).toContain("Link for cai@example.org");
    expect(inv.out).toContain("Not sent (no SMTP is configured)");
    const link = /https?:\/\/\S+#\/link\/\S+/.exec(inv.out)?.[0];
    expect(link).toBeTruthy();
    expect((await fontego(["admin", "mail", "outbox"], env)).out).toContain(link!);
    expect((await fontego(["admin", "mail"], env)).out).toContain("No SMTP");
    expect((await fontego(["admin", "users"], env)).out).toMatch(/cai@example\.org\s+invited/);
    expect((await fontego(["admin", "users", "disable", "cai@example.org"], env)).out).toContain("can't sign in any more");
    expect((await fontego(["admin", "users", "enable", "cai@example.org"], env)).out).toContain("they still have to set a password");
    const again = JSON.parse((await fontego(["admin", "users", "resend", "cai@example.org", "--json"], env)).out);
    expect(again.delivery.status).toBe("held");
    expect(again.delivery.link).not.toBe(link);
    // Anyone can ask for a new password; the answer never says whether the address has an account.
    expect((await fontego(["password-reset", "ana@example.org"])).out).toContain("If ana@example.org has an account here");
  });

  test("an admin changes the settings; a secret is asked for, never taken from the command line nor shown", async () => {
    const env = asAdmin();
    expect((await fontego(["admin", "settings", "set", "displayName", "Crumb & Co."], env)).out).toContain("displayName is now Crumb & Co..");
    const list = (await fontego(["admin", "settings"], env)).out;
    expect(list).toMatch(/displayName\s+Crumb & Co\.\s+set here/);
    expect(list).toMatch(/smtp\.password\s+\(not set\)\s+default/);
    expect((await fontego(["help", "admin", "settings", "set"], env)).out).toContain("left out, it is asked for without showing it");

    const pw = await fontego(["admin", "settings", "set", "smtp.password"], env, "s3cret pass\n");
    expect([pw.code, pw.out.trim()]).toEqual([0, "smtp.password is now (set)."]);
    expect(pw.out + pw.err).not.toContain("s3cret");
    expect((await fontego(["admin", "settings", "get", "smtp.password", "--json"], env)).out).not.toContain("s3cret");
    const nothing = await fontego(["admin", "settings", "set", "smtp.password"], env, "");
    expect(nothing.code).toBe(1);
    expect(nothing.err).toContain("Nothing came on stdin");

    const bad = await fontego(["admin", "settings", "set", "smtp.port", "lots"], env);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("smtp.port: it needs a number.");
    expect((await fontego(["admin", "settings", "get", "smtp.port"], env)).out).toContain("From: the default");
    expect((await fontego(["admin", "settings", "reset", "displayName"], env)).out).toContain("displayName is back to Fontego (the default).");
  });

  test("an admin archives a workspace: synced folders keep their changes until it is back; deleting it takes its id", async () => {
    const env = asAdmin();
    await fontego(["workspace", "create", "old"], env);
    const parent = tempDir("fontego-cli-archive-");
    const dir = `${parent}/old`;
    expect((await fontego(["clone", "old", dir], env)).code).toBe(0);
    expect((await fontego(["admin", "workspaces", "archive", "old"], env)).out).toContain("Workspace old archived");
    expect((await fontego(["workspaces"], env)).out).not.toMatch(/^old\s/m);
    expect((await fontego(["admin", "workspaces"], env)).out).toMatch(/^old\s.*\d{4}-\d\d-\d\d/m);

    await Bun.write(`${dir}/later.md`, "written while archived\n");
    const refused = await fontego(["sync", dir], env);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("archived");
    expect((await fontego(["status", dir, "--json"], env)).out).toContain("later.md");
    expect((await fontego(["admin", "workspaces", "unarchive", "old"], env)).out).toContain("Workspace old is back.");
    expect(JSON.parse((await fontego(["sync", dir, "--json"], env)).out).pushed).toEqual([{ path: "later.md", status: "put" }]);

    await fontego(["admin", "workspaces", "archive", "old"], env);
    const unconfirmed = await fontego(["admin", "workspaces", "delete", "old"], env);
    expect(unconfirmed.code).not.toBe(0);
    expect(unconfirmed.err).toContain("--confirm old");
    expect((await fontego(["admin", "workspaces", "delete", "old", "--confirm", "old"], env)).out).toContain("Workspace old deleted for good.");
    rmSync(parent, { recursive: true, force: true });
  });

  test("protected and rejected paths: sync sets a refused file aside and sends the rest; admins change the lists", async () => {
    const env = asAdmin();
    const parent = tempDir("fontego-cli-paths-");
    const dir = `${parent}/notes`;
    expect((await fontego(["clone", "notes", dir])).code).toBe(0);
    await Bun.write(`${dir}/AGENTS.md`, "# My rules\n");
    await Bun.write(`${dir}/.mcp.json`, "{}\n");
    await Bun.write(`${dir}/fine.md`, "fine\n");
    const r = JSON.parse((await fontego(["sync", dir, "--json"])).out);
    expect(r.pushed).toEqual([{ path: "fine.md", status: "put" }]);
    expect(r.skipped.map((x: any) => x.path).sort()).toEqual([".mcp.json", "AGENTS.md"]);
    expect(r.skipped.find((x: any) => x.path === "AGENTS.md").reason).toContain("protected path");
    expect((await fontego(["status", dir])).out).toContain("skipped   AGENTS.md");

    expect((await fontego(["workspace", "paths", "notes"])).out).toMatch(/protected\s+\*\*\/AGENTS\.md\s+instance default/);
    expect((await fontego(["workspace", "paths", "protect", "notes", "travel/**"], env)).out).toContain("travel/** is protected in notes.");
    expect((await fontego(["workspace", "paths", "notes"])).out).toMatch(/protected\s+travel\/\*\*\s+this workspace/);
    await Bun.write(`${dir}/travel/japan.md`, "# Japan, edited by Ana\n");
    expect(JSON.parse((await fontego(["sync", dir, "--json"])).out).skipped.map((x: any) => x.path)).toContain("travel/japan.md");
    const reject = await fontego(["workspace", "paths", "reject", "notes", "**/*.exe"]);
    expect(reject.code).toBe(5); // Ana is no admin
    expect((await fontego(["workspace", "paths", "reset", "notes"], env)).out).not.toContain("this workspace");
    rmSync(parent, { recursive: true, force: true });
  });

  test("an agent writes, moves and deletes one file without a copy, naming the version it starts from", async () => {
    const agent = { FONTEGO_AGENT: "test-agent" };
    const first = await fontego(["write", "notes", "drafts/a.md"], agent, "# Draft\n");
    expect(first.code).toBe(0);
    const hash = JSON.parse((await fontego(["cat", "notes", "drafts/a.md", "--json"])).out).hash;
    expect(first.out.trim()).toBe(`Wrote drafts/a.md. Its hash is now ${hash}`);

    const again = await fontego(["write", "notes", "drafts/a.md"], agent, "# Other\n");
    expect(again.code).toBe(4); // a conflict: it exists, and no --base said which version it edits
    expect(again.err).toContain("--base");
    expect((await fontego(["write", "notes", "drafts/a.md", "--base", hash, "-m", "Second draft"], agent, "# Draft 2\n")).code).toBe(0);
    expect((await fontego(["cat", "notes", "drafts/a.md"])).out).toBe("# Draft 2\n");

    const nothing = await fontego(["write", "notes", "drafts/empty.md"], agent, "");
    expect(nothing.code).toBe(1);
    expect(nothing.err).toContain("Nothing came on stdin");
    expect((await fontego(["write", "notes", "drafts/b.md", "Short text, as an argument."], agent)).code).toBe(0);

    const b = JSON.parse((await fontego(["cat", "notes", "drafts/b.md", "--json"])).out).hash;
    expect((await fontego(["mv", "notes", "drafts/b.md", "drafts/c.md", "--base", b], agent)).out).toContain("Wrote drafts/c.md");
    const noBase = await fontego(["rm", "notes", "drafts/c.md"], agent);
    expect(noBase.err).toContain("fontego cat notes drafts/c.md --json");
    expect((await fontego(["rm", "notes", "drafts/c.md", "--base", b], agent)).out.trim()).toBe("Deleted drafts/c.md");
    expect((await fontego(["write", "notes", "AGENTS.md"], agent, "# Mine\n")).err).toContain("protected path");
    const log = (await fontego(["admin", "audit", "changes", "--workspace", "notes", "--limit", "5"], asAdmin())).out;
    expect(log).toContain("test-agent");
  });

  test("usage mistakes are caught before calling the server", async () => {
    const r = await fontego(["members", "set", "notes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fontego members set WORKSPACE EMAIL ROLE");
    expect((await fontego(["ls", "notes", "--nope"])).err).toContain("has no option --nope");
    expect((await fontego(["log", "notes", "--limit", "many"])).err).toContain("needs a number");
    expect((await fontego(["frobnicate"])).err).toContain('Unknown command "frobnicate"');
    expect((await fontego(["members", "set", "--help"])).out).toContain("Calls PUT /v1/workspaces/{workspace}/members/{email}");
  });

  test("a stale list of commands is refreshed by the next answer", async () => {
    const path = commandsCachePath(s.url, { XDG_CACHE_HOME: home });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...saved, version: "old", commands: saved.commands.filter((c: any) => c.name !== "members") }));
    expect((await fontego(["workspaces"])).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(saved.version);
    // A command missing from the saved list is looked up on the server before giving up.
    writeFileSync(path, JSON.stringify({ ...saved, commands: [] }));
    expect((await fontego(["members", "notes"])).out).toContain("ana@example.org");
  });

  test("a command whose route moved since the list was saved is learned again and run", async () => {
    const path = commandsCachePath(s.url, { XDG_CACHE_HOME: home });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const moved = saved.commands.map((c: any) => (c.name === "members" ? { ...c, request: { ...c.request, path: "/v1/old/{workspace}/members" } } : c));
    writeFileSync(path, JSON.stringify({ ...saved, version: "old", commands: moved }));
    const r = await fontego(["members", "notes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ana@example.org");
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(saved.version);
  });

  test("offline, help still lists the saved commands and calls fail clearly", async () => {
    const offline = "http://127.0.0.1:9";
    const saved = JSON.parse(readFileSync(commandsCachePath(s.url, { XDG_CACHE_HOME: home }), "utf8"));
    const path = commandsCachePath(offline, { XDG_CACHE_HOME: home });
    writeFileSync(path, JSON.stringify({ ...saved, url: offline }));
    const env = { FONTEGO_URL: offline, FONTEGO_TOKEN: ana.token };
    const help = await fontego(["help"], env);
    expect(help.out).toContain("fontego workspaces");
    expect(help.out).toContain("can't be reached");
    const r = await fontego(["workspaces"], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Can't reach");
  });
});
