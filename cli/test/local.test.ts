// The local side never writes or deletes outside the synced folder, whatever the server sends: no path that escapes,
// no write through a symlinked folder, no symlink that points out.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeLocal, UnsafePathError, writeLocal } from "../src/sync/local.ts";

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
    for (const target of ["../..", "../../etc/passwd", "/etc/passwd", "../../../x"]) {
      await expect(writeLocal(root, "docs/out", text(target), "120000")).rejects.toThrow("points outside");
    }
    expect(existsSync(join(root, "docs/out"))).toBe(false);
  });
});
