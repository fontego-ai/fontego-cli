import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, tempDir, type TestServer } from "../../server/test/helpers.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let s: TestServer;
let ana: { token: string; id: number };
let home: string;

async function fontego(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

beforeAll(async () => {
  s = startTestServer();
  home = tempDir("fontego-cli-home-");
  ana = s.person("ana@example.org", "Ana");
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
afterAll(() => {
  s.stop();
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
    expect(list.map((w: any) => [w.slug, w.role, w.category])).toEqual([["notes", "editor", "personal"]]);
    const ls = JSON.parse((await fontego(["ls", "notes", "--json"])).out);
    expect(ls.entries.map((e: any) => e.path).sort()).toEqual(["README.md", "travel"]);
    const lsr = (await fontego(["ls", "notes", "travel"])).out;
    expect(lsr).toContain("travel/japan.md");
    expect((await fontego(["cat", "notes", "travel/japan.md"])).out).toBe("# Japan\nKyoto in April.\n");
    const cat = JSON.parse((await fontego(["cat", "notes", "README.md", "--json"])).out);
    expect(cat).toMatchObject({ path: "README.md", text: true, content: "My notes\n" });
    const found = JSON.parse((await fontego(["search", "notes", "kyoto", "--json"])).out);
    expect(found).toEqual([{ path: "travel/japan.md", line: 2, text: "Kyoto in April." }]);
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
