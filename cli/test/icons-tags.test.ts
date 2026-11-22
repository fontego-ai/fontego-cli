// A workspace's icon and tags from the command line, as a person or an agent would: setting them, listing what there
// is, filtering by tag, and what the errors say.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WORKSPACE_ICONS } from "@fontego/core";
import { rmSync } from "node:fs";
import { join } from "node:path";
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
  for (const slug of ["bakery", "legal", "hidden"]) await s.call(s.adminToken, "POST", "/v1/workspaces", { slug, name: slug[0]!.toUpperCase() + slug.slice(1) });
  for (const slug of ["bakery", "legal"]) await s.call(s.adminToken, "PUT", `/v1/workspaces/${slug}/members/olga@example.org`, { role: "admin" });
  await s.call(s.adminToken, "PATCH", "/v1/workspaces/hidden", { tags: ["secret-deal"] });
  expect((await fontego("login", s.url, "--token", olga.token)).code).toBe(0);
});
afterAll(async () => {
  await s.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("icons", () => {
  test("the list, with what each suits", async () => {
    const r = await fontego("workspace", "icons");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(/^ICON\s+SUITS$/);
    expect(lines).toHaveLength(WORKSPACE_ICONS.length + 1);
    expect(lines).toContain("scales      legal, contracts, compliance");
  });

  test("set with workspace edit --icon, shown by info, taken away with none; a topic gets the icons for it", async () => {
    expect((await fontego("workspace", "edit", "legal", "--icon", "scales")).out.trim()).toBe("Updated legal.");
    expect((await fontego("info", "legal")).out).toContain("icon: scales · tags: -");
    const wrong = await fontego("workspace", "edit", "legal", "--icon", "contracts", "--json");
    expect(wrong.code).not.toBe(0);
    expect(JSON.parse(wrong.out).error).toMatchObject({ code: "invalid_icon", hint: expect.stringContaining("For contracts: scales.") });
    expect((await fontego("workspace", "edit", "bakery", "--icon", "store")).code).toBe(0);
    expect((await fontego("workspace", "edit", "bakery", "--icon", "none")).code).toBe(0);
    expect(JSON.parse((await fontego("info", "bakery", "--json")).out).icon).toBeNull();
  });
});

describe("tags", () => {
  test("the whole list with --tags, written as they are kept; one at a time with tag and untag", async () => {
    expect((await fontego("workspace", "edit", "bakery", "--tags", "Clients, Q4 planning")).code).toBe(0);
    expect((await fontego("info", "bakery")).out).toContain("tags: clients, q4-planning");
    expect((await fontego("workspace", "tag", "bakery", "Shops")).out.trim()).toBe("Tags of bakery: clients, q4-planning, shops");
    expect((await fontego("workspace", "untag", "bakery", "q4-planning")).out.trim()).toBe("Tags of bakery: clients, shops");
    expect((await fontego("workspace", "untag", "bakery", "q4-planning")).code).toBe(0);
    expect((await fontego("workspace", "tag", "legal", "clients")).code).toBe(0);
    const bad = await fontego("workspace", "tag", "bakery", "a/b", "--json");
    expect(JSON.parse(bad.out).error.code).toBe("invalid_tag");
  });

  test("fontego tags lists those of your workspaces, counted among them, and never one you don't see", async () => {
    const r = await fontego("tags");
    expect(r.out).toBe(["TAG      WORKSPACES", "clients  2", "shops    1", ""].join("\n"));
    expect(r.out).not.toContain("secret-deal");
  });

  test("fontego workspaces --tag, with a TAGS column only when some workspace has tags", async () => {
    const all = await fontego("workspaces");
    expect(all.out.split("\n")[0]).toMatch(/^WORKSPACE\s+ROLE\s+CATEGORY\s+NAME\s+TAGS$/);
    expect(all.out).toMatch(/bakery\s+admin\s+-\s+Bakery\s+clients, shops/);
    const two = await fontego("workspaces", "--tag", "Clients");
    expect(two.out.trim().split("\n").slice(1).map((l) => l.split(/\s+/)[0])).toEqual(["bakery", "legal"]);
    const both = await fontego("workspaces", "--tag", "clients,shops", "--json");
    expect(JSON.parse(both.out).workspaces.map((w: { slug: string }) => w.slug)).toEqual(["bakery"]);
    await fontego("workspace", "edit", "bakery", "--tags", "");
    await fontego("workspace", "untag", "legal", "clients");
    expect((await fontego("workspaces")).out.split("\n")[0]).toMatch(/^WORKSPACE\s+ROLE\s+CATEGORY\s+NAME$/);
  });
});
