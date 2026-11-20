// Paths every side rejects the same way: nothing that escapes the workspace, and nothing inside the folders a synced
// copy keeps for itself.

import { describe, expect, test } from "bun:test";
import { exactText, normalizePath, PathError, textContent } from "../src/paths.ts";

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

describe("exactText", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("UTF-8 comes back as is, a BOM included", () => {
    expect(exactText(enc("año\n"))).toBe("año\n");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc("hola\n")]);
    expect(new TextEncoder().encode(exactText(bom)!)).toEqual(bom);
  });
  test("bytes that wouldn't come back are not text", () => {
    expect(exactText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBeNull(); // "café" in Latin-1
    expect(exactText(new Uint8Array([0xc0, 0xaf]))).toBeNull(); // an overlong "/"
    expect(textContent(new Uint8Array([0x61, 0, 0x62]))).toBeNull(); // a NUL: binary
    expect(textContent(enc("plain"))).toBe("plain");
  });
});
