// Paths every side rejects the same way: nothing that escapes the workspace, and nothing inside the folders a synced
// copy keeps for itself.

import { describe, expect, test } from "bun:test";
import { normalizePath, PathError } from "../src/paths.ts";

const code = (p: string) => {
  try {
    normalizePath(p);
    return "ok";
  } catch (e) {
    return (e as PathError).code;
  }
};

describe("normalizePath", () => {
  test("Git's folder and each copy's .fontego are reserved at any depth, whatever the case", () => {
    for (const p of [".git/config", ".fontego/state.json", ".FONTEGO/ignore", "team/.fontego/state.json", "a/.Git/hooks/post-checkout"]) {
      expect([p, code(p)]).toEqual([p, "reserved_path"]);
    }
  });

  test("names that only start like them are fine", () => {
    for (const p of [".fontegoignore", "docs/.fontegoignore", ".fontego-notes.md", ".gitignore", "a/.github/workflows/ci.yml"]) {
      expect([p, code(p)]).toEqual([p, "ok"]);
    }
  });

  test("nothing escapes", () => {
    for (const p of ["../x", "a/../../x", "/etc/passwd", "a\\\\b", "a//b", "./a"]) expect([p, code(p)]).not.toEqual([p, "ok"]);
  });
});
