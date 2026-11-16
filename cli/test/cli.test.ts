import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, tempDir, type TestServer } from "../../server/test/helpers.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let s: TestServer;
let ana: { token: string; id: number };
let home: string;

async function ws(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, WS_URL: "", WS_TOKEN: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

beforeAll(async () => {
  s = startTestServer();
  home = tempDir("ws-cli-home-");
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

describe("ws CLI", () => {
  test("without login it says what to do", async () => {
    const r = await ws(["workspaces"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("ws login");
  });

  test("login verifies the token and saves it 0600", async () => {
    expect((await ws(["login", s.url, "--token", "wst_bad"])).code).toBe(2);
    const r = await ws(["login", s.url, "--token", ana.token, "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.user.email).toBe("ana@example.org");
    expect(statSync(out.config).mode & 0o777).toBe(0o600);
  });

  test("explores with --json", async () => {
    const list = JSON.parse((await ws(["workspaces", "--json"])).out);
    expect(list.map((w: any) => [w.slug, w.role, w.category])).toEqual([["notes", "editor", "personal"]]);
    const ls = JSON.parse((await ws(["ls", "notes", "--json"])).out);
    expect(ls.entries.map((e: any) => e.path).sort()).toEqual(["README.md", "travel"]);
    const lsr = (await ws(["ls", "notes", "travel"])).out;
    expect(lsr).toContain("travel/japan.md");
    expect((await ws(["cat", "notes", "travel/japan.md"])).out).toBe("# Japan\nKyoto in April.\n");
    const cat = JSON.parse((await ws(["cat", "notes", "README.md", "--json"])).out);
    expect(cat).toMatchObject({ path: "README.md", text: true, content: "My notes\n" });
    const found = JSON.parse((await ws(["search", "notes", "kyoto", "--json"])).out);
    expect(found).toEqual([{ path: "travel/japan.md", line: 2, text: "Kyoto in April." }]);
    const log = (await ws(["log", "notes"])).out;
    expect(log).toContain("Seed");
  });

  test("errors carry a hint and a stable exit code", async () => {
    const r = await ws(["cat", "notes", "nope.md", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe("not_found");
    expect((await ws(["info", "secret-ws"])).code).toBe(3);
  });

  test("WS_URL and WS_TOKEN work without a saved login", async () => {
    const other = tempDir("ws-cli-empty-");
    const r = await ws(["whoami", "--json"], { XDG_CONFIG_HOME: other, WS_URL: s.url, WS_TOKEN: ana.token });
    expect(JSON.parse(r.out).user.email).toBe("ana@example.org");
    rmSync(other, { recursive: true, force: true });
  });

  test("help for agents is Markdown", async () => {
    const r = await ws(["help", "--agent"]);
    expect(r.out.startsWith("# Using `ws` from an agent")).toBe(true);
  });
});
