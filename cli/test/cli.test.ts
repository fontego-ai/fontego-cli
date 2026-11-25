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

/** A PNG of one pixel, to make photos from */
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The variables that tell fontego an agent runs it (agents.ts), all off */
const NO_AGENT = { FONTEGO_AGENT: "", CLAUDECODE: "", CODEX_THREAD_ID: "", COPILOT_CLI: "", OPENCODE: "", CURSOR_AGENT: "", GEMINI_CLI: "" };

/** `input`: what comes on stdin, which is then not a terminal. */
async function fontego(args: string[], env: Record<string, string> = {}, input?: string) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    // Never the real keychain or browser: credentials go to a file in the test home, and links are not opened. No
    // agent either, unless a test names one: the tests may run under one, and its name would land in every commit.
    env: { ...process.env, ...NO_AGENT, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", FONTEGO_INSTANCE: "", FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none", ...env },
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

  test("dates come in this machine's time zone and in one form, whatever its language; --json keeps the API's", async () => {
    const madrid = { TZ: "Europe/Madrid", LANG: "es_ES.UTF-8", LC_ALL: "es_ES.UTF-8" };
    const ends = JSON.parse((await fontego(["whoami", "--json"], madrid)).out).credential.expiresAt as string;
    expect(ends).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" }).format(new Date(ends));
    const text = (await fontego(["whoami"], madrid)).out;
    expect(text).toContain(`ends ${local} (in `);
    expect(text).not.toMatch(/UTC|AM|PM|[A-Z][a-z]{2} \d/);
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
  }, 60_000);

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

  test("activity, log --files and ls --last: who made each change and its files, from the same commands as the web", async () => {
    const act = (await fontego(["activity", "--files"])).out.split("\n");
    expect(act[0]).toMatch(/^COMMIT\s+DATE\s+WORKSPACE\s+WHO\s+MESSAGE$/); // no AGENT column: nobody used one
    const seed = act.findIndex((l) => l.includes("Seed"));
    expect(act[seed]).toContain("notes");
    expect(act[seed]).toContain("Ana");
    expect(act.slice(seed + 1, seed + 3)).toEqual(["  A README.md", "  A travel/japan.md"]);
    // A page at a time: the last line says how to go on
    const one = (await fontego(["activity", "--limit", "1"])).out;
    const cursor = /--cursor (\S+)$/m.exec(one)?.[1];
    expect(cursor).toBeTruthy();
    const json = JSON.parse((await fontego(["activity", "--limit", "1", "--cursor", cursor!, "--json"])).out);
    expect(json.commits.length).toBe(1);
    expect(one).not.toContain(json.commits[0].commit.slice(0, 10));
    // An agent's change shows its agent
    expect((await fontego(["write", "notes", "agent.md", "--message", "From the agent"], { FONTEGO_AGENT: "claude-code" }, "by an agent\n")).code).toBe(0);
    const agents = (await fontego(["activity", "--agents"])).out.split("\n");
    expect(agents[0]).toMatch(/^COMMIT\s+DATE\s+WORKSPACE\s+WHO\s+AGENT\s+MESSAGE$/);
    expect(agents.slice(1).join("\n")).toMatch(/Ana\s+claude-code\s+From the agent/);
    expect((await fontego(["activity", "--people"])).out).not.toContain("From the agent");

    const log = (await fontego(["log", "notes", "--files"])).out;
    expect(log).toMatch(/From the agent\n  A agent\.md/);
    const ls = (await fontego(["ls", "notes", "--last"])).out.split("\n");
    expect(ls[0]).toMatch(/^PATH\s+SIZE\s+LAST CHANGE\s+BY\s+MESSAGE$/);
    expect(ls.find((l) => l.startsWith("agent.md"))).toMatch(/Ana\s+From the agent$/);
    // A folder's last change is the newest one below it: the first of its history
    const travel = JSON.parse((await fontego(["log", "notes", "travel", "--limit", "1", "--json"])).out).commits[0];
    expect(ls.find((l) => l.startsWith("travel/"))?.endsWith(`Ana  ${travel.message.split("\n")[0]}`)).toBe(true);
    // Without --last, the same table as before
    expect((await fontego(["ls", "notes"])).out.split("\n")[0]).toMatch(/^PATH\s+SIZE$/);
    const lsJson = JSON.parse((await fontego(["ls", "notes", "--last", "--json"])).out);
    expect(lsJson.lastComplete).toBe(true);
    expect(lsJson.last.subject).toBe("From the agent");
  });

  test("an admin manages workspaces, members, people and tokens from the CLI", async () => {
    const env = asAdmin();
    expect((await fontego(["workspace", "create", "shared", "--name", "Shared", "--category", "team"], env)).out).toContain("Workspace shared created");
    expect((await fontego(["admin", "users", "add", "bea@example.org", "--name", "Bea"], env)).out).toContain("User bea@example.org created");
    const set = await fontego(["members", "set", "shared", "bea@example.org", "reader"], env);
    expect(set.out).toMatch(/bea@example\.org\s+reader\s+no-password\s+-\s+Bea/);
    expect((await fontego(["workspace", "edit", "shared", "--description", "For everyone"], env)).out).toContain("Updated shared.");
    const made = await fontego(["admin", "tokens", "create", "bea@example.org", "Bea's CI", "--workspaces", "shared"], env);
    expect(made.out).toContain(`"Bea's CI" for bea@example.org. It shows only this once: copy it now.`);
    expect(made.out).toMatch(/Workspaces: shared · access: read · ends \d{4}-\d\d-\d\d \d\d:\d\d \(in 90 days\)/);
    const token = /^ {2}(fontego_pat_\S+)$/m.exec(made.out)![1]!;
    const bea = await fontego(["whoami", "--json"], { FONTEGO_URL: s.url, FONTEGO_TOKEN: token });
    expect(JSON.parse(bea.out).credential).toMatchObject({ type: "token", label: "Bea's CI", scope: { workspaces: ["shared"], access: "read" } });
    expect((await fontego(["admin", "tokens", "--user", "bea@example.org"], env)).out).toMatch(/bea@example\.org\s+\d+\s+Bea's CI\s+fontego_pat_\S{6}…\s+shared\s+read/);
    expect((await fontego(["members", "remove", "shared", "bea@example.org"], env)).out).toContain("bea@example.org is no longer in shared.");
    // Ana is no admin: the server says no, with the usual exit codes.
    expect((await fontego(["admin", "users"])).code).toBe(5);
    expect((await fontego(["members", "set", "notes", "nobody@example.org", "reader"])).code).toBe(5);
  });

  test("people: everyone with an account, the workspaces you share, and one person by email or id", async () => {
    const dot = await s.person("dot@example.org", "Dot");
    const list = (await fontego(["people"])).out;
    expect(list.split("\n")[0]).toMatch(/^EMAIL\s+NAME\s+ADMIN\s+WORKSPACES$/);
    expect(list).toMatch(/admin@example\.org\s+Admin\s+yes\s+.*\bnotes\b/);
    expect(list).toMatch(/dot@example\.org\s+Dot\s+-/);
    const json = JSON.parse((await fontego(["people", "--json"])).out);
    expect(json.people.find((p: any) => p.email === "ana@example.org").workspaces).toContainEqual({ slug: "notes", name: "Notes", role: "editor" });
    const one = (await fontego(["people", "show", "admin@example.org"])).out;
    expect(one).toContain("admin@example.org");
    expect(one).toContain("server admin");
    expect(one).toMatch(/^workspaces: .*\bnotes\b/m);
    expect(one).not.toContain("account "); // status and last activity are for server admins
    expect(JSON.parse((await fontego(["people", "show", String(dot.id), "--json"])).out).email).toBe("dot@example.org");
    const none = await fontego(["people", "show", "nobody@example.org", "--json"]);
    expect(none.code).toBe(3);
    expect(JSON.parse(none.out).error.hint).toContain("fontego people");
    const forAdmin = (await fontego(["people", "show", "ana@example.org"], asAdmin())).out;
    expect(forAdmin).toMatch(/account active · last active \d{4}-\d\d-\d\d/);
  });

  test("your account: who you are, your name, your sessions", async () => {
    const eli = await s.person("eli@example.org", "Eli");
    const as = { FONTEGO_URL: s.url, FONTEGO_TOKEN: eli.token };
    expect((await fontego(["account"], as)).out).toContain("name: Eli");
    expect((await fontego(["account", "set", "--name", "Eli Moss"], as)).out).toBe(`Saved your account on ${s.url}.\nname: Eli Moss\nphoto: -\n`);
    expect(JSON.parse((await fontego(["whoami", "--json"], as)).out).user.name).toBe("Eli Moss");
    const empty = await fontego(["account", "set", "--json"], as);
    expect(empty.code).not.toBe(0);
    expect(JSON.parse(empty.out).error.message).toContain("say what to change");
    // Where Eli is signed in: this CLI's session, marked
    expect((await fontego(["account", "sessions"], as)).out).toMatch(/cli\s+test-machine \(this one\)/);
    expect((await fontego(["account", "sessions", "close", "1"], as)).code).toBe(3);
    // A token is no session, and doesn't manage the account: it says how to sign in
    const token = { FONTEGO_URL: s.url, FONTEGO_TOKEN: s.token("eli@example.org") };
    const refused = await fontego(["account", "sessions", "--json"], token);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.out).error).toMatchObject({ code: "token_not_allowed", hint: expect.stringContaining(`fontego login ${s.url}`) });
  });

  test("your photo: from a file, the same for everyone, none removes it; a server admin only removes another's", async () => {
    const gil = await s.person("gil@example.org", "Gil");
    const as = { FONTEGO_URL: s.url, FONTEGO_TOKEN: gil.token };
    const dir = tempDir("fontego-photo-");
    const file = join(dir, "me.jpg");
    writeFileSync(file, await new Bun.Image(Buffer.from(ONE_PIXEL_PNG, "base64")).resize(64, 48, { fit: "fill" }).jpeg().bytes());
    const set = await fontego(["account", "set", "--photo", file], as);
    expect([set.code, set.out]).toEqual([0, `Saved your account on ${s.url}.\nname: Gil\nphoto: yes\n`]);
    expect((await fontego(["account"], as)).out).toContain("photo: yes");
    expect((await fontego(["people", "show", "gil@example.org"])).out).toContain("Gil · has a photo");
    // What anyone gets: the square the server made, in WebP
    const got = JSON.parse((await fontego(["people", "photo", "gil@example.org", "--json"])).out);
    expect([got.type, got.text, got.version]).toEqual(["image/webp", false, expect.stringMatching(/^[0-9a-f]{16}$/)]);
    expect(await new Bun.Image(Buffer.from(got.contentBase64, "base64")).metadata()).toEqual({ width: 256, height: 256, format: "webp" });
    expect((await fontego(["help", "account", "set"])).out).toMatch(/--photo FILE +A PNG, JPEG or WebP .* none removes yours \(a file on this machine, sent to this Fontego\)/);

    // Said before calling the server: no such file, or one too big
    const missing = await fontego(["account", "set", "--photo", join(dir, "nope.jpg"), "--json"], as);
    expect(JSON.parse(missing.out).error).toMatchObject({ code: "usage", message: expect.stringContaining("there is no file") });
    expect(JSON.parse(missing.out).error.message).toContain("--photo none");
    const big = join(dir, "big.jpg");
    writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(JSON.parse((await fontego(["account", "set", "--photo", big, "--json"], as)).out).error.message).toContain("this Fontego takes at most 20 MB");
    // Said by the server: an SVG, with what to do
    const svg = join(dir, "me.svg");
    writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const refused = await fontego(["account", "set", "--photo", svg], as);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("can carry code");
    expect(refused.err).toContain("hint: Save it as a JPEG or a PNG first");

    // A server admin removes it, never puts one
    const put = await fontego(["admin", "users", "edit", "gil@example.org", "--photo", file, "--json"], asAdmin());
    expect(JSON.parse(put.out).error.message).toContain("a server admin can only remove a photo");
    // As its usage shows it, in capitals, or as the word it is
    expect((await fontego(["help", "admin", "users", "edit"], asAdmin())).out).toContain("[--photo NONE]");
    const removed = await fontego(["admin", "users", "edit", "gil@example.org", "--photo", "NONE"], asAdmin());
    expect(removed.out).toBe("Saved: gil@example.org · Gil\nTheir photo is removed; only they can put one again.\n");
    expect((await fontego(["account"], as)).out).toContain("photo: -");
    // And none removes your own
    await fontego(["account", "set", "--photo", file], as);
    expect((await fontego(["account", "set", "--photo", "none", "--json"], as)).out).toContain('"photoUrl": null');
    rmSync(dir, { recursive: true, force: true });
  });

  test("your tokens: what each reaches and how long it lasts; one that only reads can't write; revoked at once", async () => {
    const made = await fontego(["account", "tokens", "create", "CI of notes", "--workspaces", "notes", "--days", "30", "--json"]);
    expect(made.code).toBe(0);
    const t = JSON.parse(made.out);
    expect(t).toMatchObject({ name: "CI of notes", scope: { workspaces: ["notes"], access: "read" } });
    const list = (await fontego(["account", "tokens"])).out;
    expect(list.split("\n")[0]).toMatch(/^ID\s+NAME\s+TOKEN\s+WORKSPACES\s+ACCESS\s+ENDS\s+LAST USED$/);
    expect(list).toMatch(new RegExp(`${t.id}\\s+CI of notes\\s+${t.hint}…\\s+notes\\s+read\\s+\\d{4}-\\d\\d-\\d\\d \\(in 30 days\\)\\s+-`));
    expect(list).not.toContain(t.token);
    const which = await fontego(["account", "tokens", "create", "x", "--json"]);
    expect(which.code).toBe(1);
    expect(JSON.parse(which.out).error.message).toContain("--workspaces A,B) or all of yours (--all)");

    const ci = { FONTEGO_URL: s.url, FONTEGO_TOKEN: t.token };
    expect((await fontego(["cat", "notes", "README.md"], ci)).out).toBe("My notes\n");
    const w = await fontego(["write", "notes", "ci.md", "--json"], ci, "built\n");
    expect(w.code).toBe(5);
    expect(JSON.parse(w.out).error).toMatchObject({ code: "token_scope", hint: expect.stringContaining("--write") });
    // A token makes no tokens
    expect((await fontego(["account", "tokens", "create", "more", "--all"], ci)).code).toBe(5);

    expect((await fontego(["account", "tokens", "revoke", String(t.id)])).out).toBe(`Token ${t.id} revoked: it no longer works.\n`);
    expect((await fontego(["workspaces"], ci)).code).toBe(2);
  });

  test("a token's last week, every command says so where its log shows", async () => {
    const short = { FONTEGO_URL: s.url, FONTEGO_TOKEN: s.token("ana@example.org", { days: 3, read: true }) };
    const r = await fontego(["workspaces"], short);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`The token in use on ${s.url} ends in 3 day(s).`);
    expect(r.err).toContain("fontego account tokens create");
    const calm = await fontego(["workspaces"], { FONTEGO_URL: s.url, FONTEGO_TOKEN: s.token("ana@example.org", { read: true }) });
    expect(calm.err).not.toContain("ends in");
  });

  test("a server admin changes someone's name and email", async () => {
    const fin = await s.person("fin@example.org", "Fin");
    const edited = await fontego(["admin", "users", "edit", "fin@example.org", "--name", "Fin Lee", "--email", "fin@new.example.org"], asAdmin());
    expect(edited.code).toBe(0);
    expect(edited.out).toContain("Saved: fin@new.example.org · Fin Lee");
    expect(edited.out).toContain("It was fin@example.org.");
    expect(edited.out).toContain("Mail to the old address: held (no SMTP is configured)");
    expect(edited.out).toContain("Mail to the new address: held");
    expect((await fontego(["whoami"], { FONTEGO_URL: s.url, FONTEGO_TOKEN: fin.token })).out).toContain("fin@new.example.org on");
    expect((await fontego(["admin", "users", "edit", String(fin.id), "--name", "Fin"], asAdmin())).out).toBe("Saved: fin@new.example.org · Fin\n");
    const taken = await fontego(["admin", "users", "edit", "fin@new.example.org", "--email", "ana@example.org", "--json"], asAdmin());
    expect(JSON.parse(taken.out).error.code).toBe("email_taken");
    expect((await fontego(["admin", "users", "edit", "ana@example.org", "--name", "Ana"])).code).toBe(5);
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
    // A negative number is a value, which the server judges, not an option this command doesn't have.
    const negative = await fontego(["admin", "settings", "set", "sessions.web.idleDays", "-3", "--json"], env);
    expect([negative.code, JSON.parse(negative.out).error.code]).toEqual([1, "invalid_value"]);
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
    expect(refused.code).toBe(5); // an archived workspace takes nothing, whatever is tried again
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
    // A file the server won't take is not allowed (5), from an editor or a token: a protected path, a secret.
    const protectedPath = await fontego(["write", "notes", "AGENTS.md"], agent, "# Mine\n");
    expect([protectedPath.code, protectedPath.err]).toEqual([5, expect.stringContaining('It matches "**/AGENTS.md"')]);
    expect((await fontego(["write", "notes", ".env", "--json"], agent, "KEY=1\n")).code).toBe(5);
    const token = { ...agent, FONTEGO_URL: s.url, FONTEGO_TOKEN: s.token("ana@example.org", { workspaces: ["notes"] }) };
    expect((await fontego(["write", "notes", "AGENTS.md"], token, "# Mine\n")).code).toBe(5);
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
    expect((await fontego(["members", "set", "--help"])).out).toContain("Calls PUT /v1/workspaces/{workspace}/members/{person}");
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
    expect(r.code).toBe(6);
    expect(r.err).toContain("Can't reach");
  });
});

describe("for scripts and agents: --json always parses, never asks, and every failure says what to do", () => {
  const env = () => ({ XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", FONTEGO_INSTANCE: "", FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none" });
  const failed = (r: { out: string; code: number }) => {
    const e = JSON.parse(r.out).error;
    expect(typeof e.message).toBe("string");
    expect(typeof e.hint).toBe("string");
    return { ...e, exit: r.code };
  };

  test("help is JSON too", async () => {
    for (const args of [["help"], ["help", "sync"], ["sync", "--help"], ["workspaces", "--help"]]) {
      const r = await fontego([...args, "--json"]);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 0]);
      expect(typeof JSON.parse(r.out).help).toBe("string");
    }
  });

  test("a command used the wrong way: code usage, exit 1, and the command's help as the hint", async () => {
    const e = failed(await fontego(["status", "one", "two", "three", "--json"]));
    expect([e.code, e.exit]).toEqual(["usage", 1]);
    expect(e.hint).toContain("fontego help status");
  });

  test("a secret left out on a terminal is not asked for with --json", async () => {
    // A real terminal (a pty, through script(1)): without --json it would ask, without echo.
    const cmd = `bun ${MAIN} admin settings set smtp.password --json`;
    const proc = Bun.spawn(["script", "-qec", cmd, "/dev/null"], {
      env: { ...process.env, ...env(), FONTEGO_URL: s.url, FONTEGO_TOKEN: s.adminToken },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 15_000); // if it asked, it would wait here
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    expect(out).not.toContain("(not shown)");
    const e = failed({ out: out.replace(/\r/g, ""), code });
    expect([e.code, e.exit]).toEqual(["usage", 1]);
    expect(e.message).toContain("stdin");
  });

  test("a damaged state: bad_state, exit 1, and how to carry on without losing a file", async () => {
    const parent = tempDir("fontego-cli-state-");
    const dir = join(parent, "notes");
    expect((await fontego(["clone", "notes", dir])).code).toBe(0);
    const state = join(dir, ".fontego/state.json");
    const good = readFileSync(state, "utf8");
    writeFileSync(state, "{ not json");
    let e = failed(await fontego(["status", dir, "--json"]));
    expect([e.code, e.exit]).toEqual(["bad_state", 1]);
    expect(e.hint).toContain("fontego link WORKSPACE");
    writeFileSync(state, JSON.stringify({ ...JSON.parse(good), files: null }));
    e = failed(await fontego(["sync", dir, "--json"]));
    expect(e.code).toBe("bad_state");
    expect(e.hint).toContain(`fontego link notes ${dir}`);
    writeFileSync(state, JSON.stringify({ ...JSON.parse(good), version: 2 }));
    e = failed(await fontego(["status", dir, "--json"]));
    expect(e.message).toContain("newer fontego");
    expect(e.hint).toContain("Update fontego");
    rmSync(parent, { recursive: true, force: true });
  });

  test("the server can't be reached: exit 6", async () => {
    const e = failed(await fontego(["workspaces", "--json"], { FONTEGO_URL: "http://127.0.0.1:9", FONTEGO_TOKEN: ana.token }));
    expect([e.code, e.exit]).toEqual(["unreachable", 6]);
  });

  test("a sync that did only part: exit 7 and complete false, then 0 once it is all through", async () => {
    const parent = tempDir("fontego-cli-partial-");
    const dir = join(parent, "notes");
    expect((await fontego(["clone", "notes", dir])).code).toBe(0);
    writeFileSync(join(dir, ".env"), "API_KEY=1234\n");
    writeFileSync(join(dir, "partial-ok.md"), "this one goes\n");
    const r = await fontego(["sync", dir, "--json"]);
    expect(r.code).toBe(7);
    const report = JSON.parse(r.out);
    expect(report.complete).toBe(false);
    expect(report.skipped.map((x: any) => x.path)).toEqual([".env"]);
    expect(report.pushed.map((p: any) => p.path)).toEqual(["partial-ok.md"]);
    rmSync(join(dir, ".env"));
    const after = await fontego(["sync", dir, "--json"]);
    expect([after.code, JSON.parse(after.out).complete]).toEqual([0, true]);
    rmSync(parent, { recursive: true, force: true });
  });
});

describe("live: who is around, and what happens as it happens", () => {
  // The agent is named, so the tests read the same whether an agent runs them or not.
  const asAna = () => ({ FONTEGO_URL: s.url, FONTEGO_TOKEN: ana.token, FONTEGO_AGENT: "test-agent" });

  test("here shows you in a workspace for a while, who lists everyone, here clear takes you out", async () => {
    const here = await fontego(["here", "notes", "travel/", "--minutes", "20"], asAna());
    expect(here.code).toBe(0);
    expect(here.out).toContain("In notes you show as working in travel/ until");
    expect(here.out).toContain("fontego here clear notes");
    const table = (await fontego(["who", "notes"], asAna())).out.split("\n");
    expect(table[0]).toMatch(/^WORKSPACE\s+WHO\s+AGENT\s+DOING\s+SINCE$/);
    // Ana's own writes show her working too (what she seeded); her agent's announcement is apart
    expect(table.some((l) => /^notes\s+Ana\s+test-agent\s+working in travel\/\s+\d{4}-\d\d-\d\d \d\d:\d\d$/.test(l))).toBe(true);
    const all = JSON.parse((await fontego(["who", "--json"], asAna())).out);
    expect(all.here).toContainEqual(expect.objectContaining({ workspace: "notes", user: expect.objectContaining({ email: "ana@example.org" }), agent: "test-agent", activity: "working", via: "cli" }));
    const reading = JSON.parse((await fontego(["here", "notes", "--doing", "reading", "--json"], asAna())).out);
    expect(reading.you).toMatchObject({ activity: "reading", path: null, doing: "reading" });
    expect((await fontego(["here", "clear", "notes"], asAna())).out).toContain("You no longer show in notes.");
    expect((await fontego(["who", "notes"], asAna())).out).not.toContain("test-agent");
  });

  test("who and here keep to the workspaces you read; bad input says what is wrong", async () => {
    const missing = JSON.parse((await fontego(["who", "secret", "--json"], asAna())).out);
    expect(missing.error.code).toBe("not_found");
    const r = await fontego(["here", "notes", "../x", "--json"], asAna());
    expect([r.code, JSON.parse(r.out).error.code]).toEqual([1, "path_escapes"]);
    expect(JSON.parse((await fontego(["here", "notes", "--minutes", "500", "--json"], asAna())).out).error.code).toBe("invalid_body");
  });

  test("events prints what happens, one line each, or one JSON object per line", async () => {
    const run = (json: boolean) =>
      Bun.spawn(["bun", MAIN, "events", ...(json ? ["--json"] : [])], {
        env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none", FONTEGO_INSTANCE: "", ...asAna() },
        stdout: "pipe",
        stderr: "pipe",
      });
    const lines = (p: ReturnType<typeof run>) => {
      const out: string[] = [];
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of p.stdout) {
          buf += dec.decode(chunk);
          const parts = buf.split("\n");
          buf = parts.pop()!;
          out.push(...parts);
        }
      })();
      return out;
    };
    const until = async (out: string[], test: (l: string) => boolean) => {
      for (let i = 0; i < 300 && !out.some(test); i++) await Bun.sleep(20);
      expect(out.some(test)).toBe(true);
    };
    const text = run(false);
    const json = run(true);
    try {
      const t = lines(text);
      const j = lines(json);
      await until(t, (l) => l.includes("connected;"));
      await until(j, (l) => l.startsWith('{"type":"ready"'));
      await s.call(ana.token, "POST", "/v1/workspaces/notes/changes", { baseCommit: null, message: "Live from a test", ops: [{ op: "put", path: "live.md", content: "now\n", baseHash: null }] });
      await until(t, (l) => /notes {2}Ana: Live from a test \(1 file\)$/.test(l));
      await until(j, (l) => l.includes('"type":"commit"'));
      const commit = JSON.parse(j.find((l) => l.includes('"type":"commit"'))!);
      expect(commit).toMatchObject({ type: "commit", workspace: "notes", message: "Live from a test", changes: [{ status: "put", path: "live.md" }] });
      await s.call(ana.token, "PUT", "/v1/workspaces/notes/presence", { path: "travel/" });
      // Others may be there from earlier tests: what counts is Ana's line
      const hereLine = (l: string) => l.includes("  notes  here now: ") || l.includes("  notes  nobody here now");
      await until(t, (l) => hereLine(l) && l.includes("Ana, working in travel/"));
      await until(j, (l) => l.includes('"type":"presence"'));
      const seen = t.length;
      await s.call(ana.token, "DELETE", "/v1/workspaces/notes/presence");
      await until(t, (l) => t.indexOf(l) >= seen && hereLine(l) && !l.includes("working in travel/"));
      // What only says to read something again: your preferences, and the accounts people see
      expect((await s.call(ana.token, "PUT", "/v1/me/preferences/filesView", { value: "tree" })).status).toBe(200);
      await until(t, (l) => l.endsWith("your preferences changed: fontego preferences"));
      await until(j, (l) => l.startsWith('{"type":"preferences"'));
      const name = (await s.call(ana.token, "GET", "/v1/me")).data.user.name as string;
      await s.call(ana.token, "PATCH", "/v1/me", { name: `${name} Live` });
      await s.call(ana.token, "PATCH", "/v1/me", { name });
      await s.call(ana.token, "DELETE", "/v1/me/preferences/filesView");
      await until(t, (l) => l.endsWith("an account changed (someone new, a name, an email, a photo...): fontego people"));
      await until(j, (l) => l.startsWith('{"type":"people"'));
      text.kill("SIGINT");
      json.kill("SIGINT");
      expect(await text.exited).toBe(0);
      expect(await json.exited).toBe(0);
      // --json: stdout is only events
      expect(j.every((l) => JSON.parse(l).type)).toBe(true);
    } finally {
      // A test that fails half way leaves nothing running: they would try to connect for ever
      for (const p of [text, json]) if (p.exitCode === null) p.kill("SIGKILL");
    }
  }, 30_000);

  test("events closed for having too many streams: it stops and says why, instead of pushing another out", async () => {
    const proc = Bun.spawn(["bun", MAIN, "events", "--json"], {
      env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none", FONTEGO_INSTANCE: "", ...asAna() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let text = "";
    // Connected first; then 8 more streams of Ana's: this one, the oldest, makes room
    while (!text.includes('"type":"ready"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    const others: AbortController[] = [];
    for (let i = 0; i < 8; i++) {
      const ac = new AbortController();
      others.push(ac);
      await fetch(`${s.url}/v1/events`, { headers: { authorization: `Bearer ${ana.token}` }, signal: ac.signal });
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(await proc.exited).toBe(1);
    // One event per line, then the error, as every --json error comes
    const at = text.lastIndexOf('{\n  "error"');
    const events = text.slice(0, at).trim().split("\n").map((l) => JSON.parse(l));
    expect(events[events.length - 1]).toMatchObject({ type: "closed", reason: "too_many_streams" });
    expect(JSON.parse(text.slice(at)).error).toMatchObject({ code: "too_many_streams", hint: expect.stringContaining("Close") });
    for (const ac of others) ac.abort();
  }, 30_000);

  test("events, signed out: it ends with exit 2 and what to do", async () => {
    const r = await fontego(["events", "--json"], { FONTEGO_URL: s.url, FONTEGO_TOKEN: "fontego_wrong" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out).error).toMatchObject({ code: "unauthenticated", hint: expect.any(String) });
  }, 20_000);
});
