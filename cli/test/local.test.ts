// The local side never writes or deletes outside the synced folder, whatever the server sends: no path that escapes,
// no write through a symlinked folder, no symlink that points out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictName, isConflictCopy, readBytes, readEntry, removeLocal, replaceIf, SwappedError, UnsafePathError, writeLocal } from "../src/sync/local.ts";
import { normalizePath } from "@fontego/core";

let outer: string;
let root: string;
const text = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  outer = mkdtempSync(join(tmpdir(), "fontego-local-"));
  root = join(outer, "copy");
  mkdirSync(root);
});
afterEach(() => rmSync(outer, { recursive: true, force: true }));

describe("writing and deleting stay inside the folder", () => {
  test("a plain file and folders below it are written", async () => {
    await writeLocal(root, "notes/2026/plan.md", text("hi"), "100644");
    expect(readFileSync(join(root, "notes/2026/plan.md"), "utf8")).toBe("hi");
  });

  test("paths the server should never send are refused, before anything is created", async () => {
    for (const p of ["../outside.md", "a/../../outside.md", "/tmp/outside.md", ".fontego/state.json", "a//b.md"]) {
      await expect(writeLocal(root, p, text("x"), "100644")).rejects.toBeInstanceOf(UnsafePathError);
    }
    expect(existsSync(join(outer, "outside.md"))).toBe(false);
  });

  test("a chain of harmless-looking symlinks can't carry a write or a delete out", async () => {
    // a -> . and b -> a/.. : each resolves inside on paper, but b is the folder above the copy on disk.
    symlinkSync(".", join(root, "a"));
    symlinkSync("a/..", join(root, "b"));
    writeFileSync(join(outer, "precious.txt"), "keep me");
    await expect(writeLocal(root, "b/evil.sh", text("rm -rf ~"), "100755")).rejects.toThrow("is a symlink here");
    expect(existsSync(join(outer, "evil.sh"))).toBe(false);
    await expect(removeLocal(root, "b/precious.txt")).rejects.toBeInstanceOf(UnsafePathError);
    expect(readFileSync(join(outer, "precious.txt"), "utf8")).toBe("keep me");
  });

  test("a symlink may point inside the folder, never out of it", async () => {
    await writeLocal(root, "docs/latest", text("2026/plan.md"), "120000");
    expect(lstatSync(join(root, "docs/latest")).isSymbolicLink()).toBe(true);
    for (const target of ["../..", "../../etc/passwd", "/etc/passwd", "../../../x", "..\\..\\x", "C:/Users", ".git/hooks/pre-commit"]) {
      await expect(writeLocal(root, "docs/out", text(target), "120000")).rejects.toThrow("could point outside");
    }
    expect(existsSync(join(root, "docs/out"))).toBe(false);
  });

  test("links that each land inside on paper can't chain out: the one that climbs after a name is never made", async () => {
    // What an editor could commit before the rule: a -> ., b -> a/.., notes.md -> b/secret.txt. b would be the folder
    // above the copy, and notes.md a file outside it.
    writeFileSync(join(outer, "secret.txt"), "outside\n");
    await writeLocal(root, "a", text("."), "120000");
    await expect(writeLocal(root, "b", text("a/.."), "120000")).rejects.toBeInstanceOf(UnsafePathError);
    await writeLocal(root, "notes.md", text("b/secret.txt"), "120000");
    expect(existsSync(join(root, "b"))).toBe(false);
    expect(() => realpathSync(join(root, "notes.md"))).toThrow(); // dangling, inside the folder
  });
});

describe("a change here only replaces what was expected", () => {
  const who = { who: "Ana" };
  const put = (p: string, s: string) => {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), s);
  };

  test("the expected file is replaced, and its entry is the new one", async () => {
    put("a.md", "v1\n");
    const expected = (await readEntry(root, "a.md"))!;
    const done = await replaceIf(root, "a.md", { bytes: text("v2\n"), mode: "100644" }, expected, who);
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("v2\n");
    expect(done?.entry?.hash).toBe((await readEntry(root, "a.md"))!.hash);
  });

  test("a file that changed since it was looked at stays as it is", async () => {
    put("a.md", "v1\n");
    const expected = (await readEntry(root, "a.md"))!;
    put("a.md", "edited here\n");
    expect(await replaceIf(root, "a.md", { bytes: text("from the server\n"), mode: "100644" }, expected, who)).toBeNull();
    expect(await replaceIf(root, "a.md", null, expected, who)).toBeNull();
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe("edited here\n");
  });

  test("a file made where none was expected stays", async () => {
    put("new.md", "made here\n");
    expect(await replaceIf(root, "new.md", { bytes: text("from the server\n"), mode: "100644" }, undefined, who)).toBeNull();
    expect(readFileSync(join(root, "new.md"), "utf8")).toBe("made here\n");
  });

  test("a delete takes the empty folders with it, and leaves nothing behind in .fontego", async () => {
    put("deep/er/a.md", "v1\n");
    const expected = (await readEntry(root, "deep/er/a.md"))!;
    expect(await replaceIf(root, "deep/er/a.md", null, expected, who)).toEqual({ entry: null });
    expect(existsSync(join(root, "deep"))).toBe(false);
    expect(readdirSync(join(root, ".fontego/tmp"))).toEqual([]);
  });

  test("in a conflict both stay: what is here goes to the copy, the new one takes its place", async () => {
    put("plan.md", "mine, last saved\n");
    const done = await replaceIf(root, "plan.md", { bytes: text("theirs\n"), mode: "100644" }, undefined, { who: "Ana", keepAs: "plan (conflict).md" });
    expect(done?.keptAs).toBe("plan (conflict).md");
    expect(readFileSync(join(root, "plan (conflict).md"), "utf8")).toBe("mine, last saved\n");
    expect(readFileSync(join(root, "plan.md"), "utf8")).toBe("theirs\n");
    // A copy by that name already there is never overwritten: the next one gets a number.
    put("plan.md", "mine again\n");
    const again = await replaceIf(root, "plan.md", { bytes: text("theirs 2\n"), mode: "100644" }, undefined, { who: "Ana", keepAs: "plan (conflict).md" });
    expect(again?.keptAs).toBe("plan (conflict) 2.md");
    expect(readFileSync(join(root, "plan (conflict).md"), "utf8")).toBe("mine, last saved\n");
  });

  // Every file in this folder but .fontego, with its content: what the person would find.
  const everything = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const p = dir ? `${dir}/${name}` : name;
        if (p === ".fontego") continue;
        if (lstatSync(join(root, p)).isDirectory()) walk(p);
        else out[p] = readFileSync(join(root, p), "utf8");
      }
    };
    walk("");
    return out;
  };

  test("a conflict copy is made whatever the name or who: a long name, one of many bytes, a name in NFD or with DEL", async () => {
    for (const [name, who] of [
      [`${"x".repeat(225)}.md`, "Ana"],
      [`${"é".repeat(115)}.md`, "Ana"], // 230 bytes of UTF-8 in 117 characters
      [`${"中".repeat(80)}.txt`, "Ana"],
      ["plan.md", "Jose\u0301"],
      ["plan.md", "Ana\u007f"],
      [`${"y".repeat(240)}.${"e".repeat(14)}`, "A very long display name that goes on and on"],
    ] as const) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root);
      put(name, "my unsent edit\n");
      const done = await replaceIf(root, name, { bytes: text("theirs\n"), mode: "100644" }, undefined, { who, keepAs: conflictName(name, who) });
      expect(isConflictCopy(done!.keptAs!)).toBe(true);
      expect(Buffer.byteLength(done!.keptAs!)).toBeLessThanOrEqual(255);
      expect(everything()).toEqual({ [name]: "theirs\n", [done!.keptAs!]: "my unsent edit\n" });
    }
  });

  test("a copy that can't be made under any name never costs the edit: it goes back to its place", async () => {
    // A folder so deep that no conflict copy fits in the 1,024 characters of a path, short name included.
    const deep = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(200)).join("/");
    const path = `${deep}/a.md`;
    put(path, "my unsent edit\n");
    for (const keepAs of [conflictName(path, "Ana"), "bad\u0000name.md"]) {
      await expect(replaceIf(root, path, { bytes: text("theirs\n"), mode: "100644" }, undefined, { who: "Ana", keepAs })).rejects.toThrow();
      expect(everything()).toEqual({ [path]: "my unsent edit\n" });
    }
    expect(readdirSync(join(root, ".fontego/tmp"))).toEqual([]);
  });

  test("a conflict copy's name that can't be made falls back to a short one next to the file", async () => {
    put("notes/plan.md", "mine\n");
    const done = await replaceIf(root, "notes/plan.md", { bytes: text("theirs\n"), mode: "100644" }, undefined, { who: "Ana", keepAs: "notes/bad\u0000.md" });
    expect(done!.keptAs).toMatch(/^notes\/\(conflict \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\)\.md$/);
    expect(isConflictCopy(done!.keptAs!)).toBe(true);
    expect(everything()).toEqual({ "notes/plan.md": "theirs\n", [done!.keptAs!]: "mine\n" });
  });
});

describe("conflict copy names", () => {
  const at = new Date(2026, 10, 16, 10, 42, 7);
  test("the usual one", () => {
    expect(conflictName("notes/plan.md", "Ana", at)).toBe("notes/plan (conflict Ana 2026-11-16 10.42.07).md");
    expect(conflictName(".env.local", "Ana", at)).toBe(".env (conflict Ana 2026-11-16 10.42.07).local");
  });

  test("who keeps only letters, digits, spaces and . - _, in NFC", () => {
    expect(conflictName("a.md", "Jose\u0301 / Ana\u007f\u0085 <x>", at)).toBe("a (conflict José Ana x 2026-11-16 10.42.07).md");
    expect(conflictName("a.md", "\u0000/\\", at)).toBe("a (conflict someone 2026-11-16 10.42.07).md");
  });

  test("always a name a workspace and every file system take", () => {
    for (const path of [`${"x".repeat(250)}`, `${"é".repeat(127)}.md`, `d/${"😀".repeat(100)}.md`, `a.${"e".repeat(240)}`, `${"d/".repeat(400)}plan.md`]) {
      const name = conflictName(path, "A name of forty characters, exactly here", at);
      expect(normalizePath(name)).toBe(name);
      expect(Buffer.byteLength(name.slice(name.lastIndexOf("/") + 1))).toBeLessThanOrEqual(250);
      expect(isConflictCopy(name)).toBe(true);
    }
  });
});

describe("what is read to go up is what the scan saw", () => {
  test("a file swapped since the scan for a symlink, a pipe, or a link for a file, is refused, never followed", async () => {
    writeFileSync(join(outer, "secret.txt"), "outside\n");
    symlinkSync(join(outer, "secret.txt"), join(root, "notes.md")); // the scan saw a plain notes.md
    await expect(readBytes(root, "notes.md", "100644")).rejects.toBeInstanceOf(SwappedError);
    expect(Bun.spawnSync(["mkfifo", join(root, "pipe.md")]).exitCode).toBe(0); // nobody ever writes to it
    await expect(readBytes(root, "pipe.md", "100644")).rejects.toBeInstanceOf(SwappedError);
    writeFileSync(join(root, "was-a-link"), "a file now\n");
    await expect(readBytes(root, "was-a-link", "120000")).rejects.toBeInstanceOf(SwappedError);
    writeFileSync(join(root, "plain.md"), "plain\n");
    expect(new TextDecoder().decode(await readBytes(root, "plain.md", "100644"))).toBe("plain\n");
  });
});
