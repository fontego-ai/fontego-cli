// Ignore rules: .gitignore's syntax, in three levels (built-in, per machine, shared), deepest file winning.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_RULES_BYTES } from "@fontego/core";
import { localStatus } from "../src/sync/engine.ts";
import { loadIgnoreRules } from "../src/sync/ignore.ts";
import { newState } from "../src/sync/state.ts";
import { scan } from "../src/sync/local.ts";
import { tempDir } from "./server.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const root = tempDir("fontego-ignore-");
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function rulesFor(root: string, path: string, isDir = false) {
  const rules = await loadIgnoreRules(root);
  await rules.prepare(path);
  return rules.match(path, isDir);
}

describe("ignore rules", () => {
  test(".gitignore's syntax: globs, **, a leading / to anchor, a trailing / for folders, ! to take back", async () => {
    const root = folder({ ".fontegoignore": "# comment\n*.log\n!keep.log\n/top.txt\nbuild/\n**/tmp/**\ndocs/*.draft\n" });
    expect(await rulesFor(root, "a/b/x.log")).toMatchObject({ ignored: true, source: ".fontegoignore", line: 2, pattern: "*.log" });
    expect((await rulesFor(root, "a/keep.log")).ignored).toBe(false);
    expect((await rulesFor(root, "top.txt")).ignored).toBe(true);
    expect((await rulesFor(root, "sub/top.txt")).ignored).toBe(false);
    expect((await rulesFor(root, "build", true)).ignored).toBe(true);
    expect((await rulesFor(root, "build")).ignored).toBe(false); // a file named build is not a folder
    expect((await rulesFor(root, "x/tmp/y/z.md")).ignored).toBe(true);
    expect((await rulesFor(root, "docs/a.draft")).ignored).toBe(true);
    expect((await rulesFor(root, "docs/more/a.draft")).ignored).toBe(false);
  });

  test("nothing below an ignored folder comes back, and the answer names the folder", async () => {
    const root = folder({ ".fontegoignore": "build/\n!build/keep.md\n" });
    expect(await rulesFor(root, "build/keep.md")).toMatchObject({ ignored: true, pattern: "build/", folder: "build" });
  });

  test("a deeper .fontegoignore wins; it speaks of paths from its own folder", async () => {
    const root = folder({ ".fontegoignore": "*.csv\n", "data/.fontegoignore": "!*.csv\n/raw/\n" });
    expect((await rulesFor(root, "a.csv")).ignored).toBe(true);
    expect((await rulesFor(root, "data/a.csv")).ignored).toBe(false);
    expect(await rulesFor(root, "data/raw", true)).toMatchObject({ ignored: true, source: "data/.fontegoignore", line: 2 });
    expect((await rulesFor(root, "raw", true)).ignored).toBe(false);
  });

  test("the machine's own rules, in .fontego/ignore, under the shared ones", async () => {
    const root = folder({ ".fontego/ignore": "*.mine\nshared.mine\n", ".fontegoignore": "!shared.mine\n" });
    expect(await rulesFor(root, "notes.mine")).toMatchObject({ ignored: true, source: ".fontego/ignore", line: 1 });
    expect((await rulesFor(root, "shared.mine")).ignored).toBe(false);
  });

  test("built in: .git, .fontego and the junk systems and editors leave", async () => {
    const root = folder({});
    for (const [path, isDir] of [[".git", true], ["sub/.git", true], [".fontego", true], ["a/.DS_Store", false], ["x.md~", false], [".x.swp", false]] as const) {
      expect(await rulesFor(root, path, isDir)).toMatchObject({ ignored: true, source: "built-in" });
    }
    expect((await rulesFor(root, "sub/.fontego", true)).ignored).toBe(false);
  });

  test("an ignore file is read only from a plain file: a link to /dev/zero or a pipe is left out, and named", async () => {
    const root = folder({ "inside.txt": "*.log\n" });
    symlinkSync("/dev/zero", join(root, ".fontegoignore"));
    mkdirSync(join(root, "a"));
    symlinkSync("../inside.txt", join(root, "a/.fontegoignore")); // to a file in the folder, still a link
    mkdirSync(join(root, "b"));
    expect(Bun.spawnSync(["mkfifo", join(root, "b/.fontegoignore")]).exitCode).toBe(0); // nobody ever writes to it
    const rules = await loadIgnoreRules(root);
    await rules.prepare("a/x.log");
    await rules.prepare("b/x.log");
    expect(rules.match("a/x.log", false).ignored).toBe(false);
    expect(rules.problems.map((p) => [p.source, p.reason])).toEqual([
      [".fontegoignore", "it is a symlink, and ignore rules are read only from a plain file, so its rules don't count"],
      ["a/.fontegoignore", "it is a symlink, and ignore rules are read only from a plain file, so its rules don't count"],
      ["b/.fontegoignore", "it isn't a plain file, so its rules don't count"],
    ]);
    // fontego status names them.
    const st = await localStatus(root, newState("http://localhost", "ws", "Ana"));
    expect(st.rulesNotRead.map((p) => p.source)).toEqual([".fontegoignore", "a/.fontegoignore", "b/.fontegoignore"]);
  });

  test("only the first MiB of an ignore file counts", async () => {
    const filler = "# a comment line that rules nothing\n".repeat(Math.ceil(MAX_RULES_BYTES / 36));
    const root = folder({ ".fontegoignore": `*.tmp\n${filler}*.late\n` });
    const rules = await loadIgnoreRules(root);
    expect(rules.match("a.tmp", false).ignored).toBe(true);
    expect(rules.match("a.late", false).ignored).toBe(false);
    expect(rules.problems).toEqual([{ source: ".fontegoignore", reason: "it is over 1 MiB, so only its first MiB counts" }]);
  });

  test("scanning sends files the workspace has even when ignored, also inside an ignored folder, and lists the rest", async () => {
    const root = folder({ ".fontegoignore": "node_modules/\n*.log\n", "node_modules/pkg/index.js": "x", "node_modules/kept.js": "k", "a.log": "a", "b.log": "b", "c.md": "c" });
    const tracked = { "node_modules/kept.js": { hash: "", mode: "100644", size: -1, mtimeMs: 0 }, "a.log": { hash: "", mode: "100644", size: -1, mtimeMs: 0 } };
    const r = await scan(root, await loadIgnoreRules(root), tracked);
    expect([...r.files.keys()].sort()).toEqual([".fontegoignore", "a.log", "c.md", "node_modules/kept.js"]);
    expect(r.ignored).toEqual(["b.log", "node_modules/"]);
    expect(r.trackedIgnored.map((t) => [t.path, t.pattern])).toEqual([
      ["a.log", "*.log"],
      ["node_modules/kept.js", "node_modules/"],
    ]);
  });
});
