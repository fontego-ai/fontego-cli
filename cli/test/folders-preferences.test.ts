// What the server declares for the top-level folders, your preferences and the categories, run as a person or an
// agent would: the text people read, and --json as the API answered.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { checkCommand, renderOutput } from "../src/declared.ts";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
let s: TestServer;
let home: string;

async function fontego(...args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    stdin: "ignore",
    env: { ...process.env, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, FONTEGO_URL: "", FONTEGO_TOKEN: "", FONTEGO_INSTANCE: "", FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

beforeAll(async () => {
  s = await startTestServer();
  home = tempDir("fontego-cli-home-");
  const olga = await s.person("olga@example.org", "Olga");
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "bakery", name: "Bakery", category: "Clients" });
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "hidden" });
  await s.call(s.adminToken, "PUT", "/v1/workspaces/bakery/members/olga@example.org", { role: "admin" });
  await s.call(olga.token, "POST", "/v1/workspaces/bakery/changes", {
    baseCommit: null,
    ops: [
      { op: "put", path: "clients/acme.md", content: "a\n", baseHash: null },
      { op: "put", path: "recipes/bread.md", content: "b\n", baseHash: null },
      { op: "put", path: "README.md", content: "# Bakery\n", baseHash: null },
    ],
  });
  expect((await fontego("login", s.url, "--token", olga.token)).code).toBe(0);
});
afterAll(async () => {
  await s.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("top-level folders", () => {
  test("set, list, show in info and ls, and unset", async () => {
    const set = await fontego("workspace", "folders", "set", "bakery", "clients", "One file per client.");
    expect([set.code, set.out.trim()]).toEqual([0, "clients in bakery now says what goes in it."]);
    expect((await fontego("workspace", "folders", "bakery")).out).toBe(["FOLDER    DESCRIPTION", "clients/  One file per client.", "recipes/  -", ""].join("\n"));

    const info = (await fontego("info", "bakery")).out;
    expect(info).toContain("\n\nTop-level folders:\n  clients/  One file per client.\n  recipes/\n");
    const json = JSON.parse((await fontego("info", "bakery", "--json")).out);
    expect(json.folders).toEqual([
      { path: "clients", description: "One file per client.", exists: true, updatedAt: expect.any(String), updatedBy: "Olga" },
      { path: "recipes", description: null, exists: true },
    ]);

    const ls = (await fontego("ls", "bakery")).out;
    expect(ls).toMatch(/^PATH +SIZE +DESCRIPTION$/m);
    expect(ls).toMatch(/^clients\/ +One file per client\.$/m);

    expect((await fontego("workspace", "folders", "unset", "bakery", "clients")).out.trim()).toBe("clients in bakery has no description now.");
    expect((await fontego("info", "bakery")).out).not.toContain("One file per client.");
  });

  test("a deeper folder is refused with where its description goes, and the exit code says why", async () => {
    const r = await fontego("workspace", "folders", "set", "bakery", "clients/acme", "Acme", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error).toMatchObject({ code: "not_top_folder", hint: expect.stringContaining("README.md") });
    const none = await fontego("workspace", "folders", "set", "bakery", "drafts", "Drafts");
    expect(none.code).toBe(3);
    expect(none.err).toContain("fontego ls bakery");
  });

  test("a folder gone shows its line marked, until it is unset", async () => {
    await fontego("workspace", "folders", "set", "bakery", "recipes", "What we bake.");
    const hash = (await s.call(s.adminToken, "GET", "/v1/workspaces/bakery/files/recipes/bread.md?meta=1")).data.hash;
    await s.call(s.adminToken, "POST", "/v1/workspaces/bakery/changes", { baseCommit: null, ops: [{ op: "delete", path: "recipes/bread.md", baseHash: hash }] });
    expect((await fontego("workspace", "folders", "bakery")).out).toContain("recipes/ (gone)  What we bake.");
    expect((await fontego("info", "bakery")).out).toContain("  recipes/ (gone)  What we bake.");
    await fontego("workspace", "folders", "unset", "bakery", "recipes");
    expect((await fontego("workspace", "folders", "bakery")).out).not.toContain("recipes");
  });
});

describe("your preferences", () => {
  test("pin and unpin, see them all, set and reset one", async () => {
    expect((await fontego("pin", "bakery")).out.trim()).toBe("bakery is pinned.");
    const hidden = await fontego("pin", "hidden");
    expect(hidden.code).toBe(3);
    expect(hidden.err).toContain('No workspace "hidden" for you.');
    expect((await fontego("preferences")).out).toBe(["KEY        VALUE", "pinned     bakery", "filesView  grid (default)", ""].join("\n"));

    expect((await fontego("preferences", "set", "filesView", "tree")).out.trim()).toBe("filesView is now tree.");
    const one = (await fontego("preferences", "get", "filesView")).out;
    expect(one).toStartWith("filesView = tree\nHow a workspace's files show");
    expect(one).toMatch(/\nSet on \d{4}-\d\d-\d\d \d\d:\d\d\n$/);
    expect((await fontego("preferences", "reset", "filesView")).out.trim()).toBe("filesView is back to its default: grid.");
    expect((await fontego("preferences", "get", "filesView")).out).toEndWith("\nThe default.\n");

    const bad = await fontego("preferences", "set", "filesView", "columns", "--json");
    expect(JSON.parse(bad.out).error).toMatchObject({ code: "invalid_value", message: "filesView: is grid or tree." });

    // A list, as text
    const list = JSON.parse((await fontego("preferences", "set", "pinned", "bakery,bakery", "--json")).out);
    expect(list).toMatchObject({ key: "pinned", value: ["bakery"], set: true });
    expect((await fontego("unpin", "bakery")).out.trim()).toBe("bakery is not pinned.");
    expect((await fontego("unpin", "hidden")).code).toBe(0);
    expect(JSON.parse((await fontego("preferences", "--json")).out).preferences[0].value).toEqual([]);
  });
});

describe("categories", () => {
  test("in use, or the instance's list", async () => {
    expect((await fontego("categories")).out).toBe(["Any text can be a category here.", "", "In use (with how many of your workspaces have each):", "  Clients (1)", ""].join("\n"));
    await s.call(s.adminToken, "PUT", "/v1/admin/settings/workspaces.categories", { value: ["Clients", "Internal"] });
    expect((await fontego("categories")).out).toBe(
      ["Each workspace here has one of these categories or none.", "", "Categories (with how many of your workspaces have each):", "  Clients (1)", "  Internal (0)", ""].join("\n"),
    );
    const r = await fontego("workspace", "edit", "bakery", "--category", "Bakeries", "--json");
    expect(JSON.parse(r.out).error).toMatchObject({ code: "invalid_category", details: { categories: ["Clients", "Internal"] } });
    expect((await fontego("workspace", "edit", "bakery", "--category", "internal")).code).toBe(0);
    expect(JSON.parse((await fontego("info", "bakery", "--json")).out).category).toBe("Internal");
  });
});

describe("a record's list", () => {
  const output = { kind: "record" as const, lines: ["{name}"], list: { title: "Items:", rows: "items", line: "{id} {note}" } };

  test("comes after the record, indented, and not at all when empty", () => {
    expect(renderOutput(output, { name: "x", items: [{ id: 1, note: "a" }, { id: 2, note: "" }] }, {})).toBe("x\n\nItems:\n  1 a\n  2");
    expect(renderOutput(output, { name: "x", items: [] }, {})).toBe("x");
    expect(renderOutput(output, { name: "x" }, {})).toBe("x");
  });

  test("its templates are checked like the rest", () => {
    const spec = { name: "thing", summary: "s", group: "g", output: { ...output, list: { ...output.list, line: "{id|nope}" } }, request: { method: "GET", path: "/v1/thing" } };
    expect(checkCommand(spec, [])).toEqual(['fontego thing: unknown filter "nope" in "{id|nope}"']);
  });
});
