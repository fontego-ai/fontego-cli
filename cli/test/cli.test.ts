import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandsManifest } from "@fontego/core";
import { BUILTIN_NAMES } from "../src/builtins.ts";
import { checkCommand, commandsCachePath } from "../src/declared.ts";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let s: TestServer;
let ana: { token: string; id: number };
let home: string;

async function fontego(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", ...env },
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

  test("an admin invites people from the CLI; without mail, the link to pass on is right there", async () => {
    const env = asAdmin();
    const inv = await fontego(["admin", "users", "invite", "cai@example.org", "--name", "Cai"], env);
    expect(inv.out).toContain("Invitation for cai@example.org");
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
