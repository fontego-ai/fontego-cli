// Paths every side rejects the same way: nothing that escapes the workspace, and nothing inside the folders a synced
// copy keeps for itself.

import { describe, expect, test } from "bun:test";
import { exactText, isReservedName, normalizePath, PathError, symlinkTarget, textContent, windowsNameProblem } from "../src/paths.ts";

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

  test("the names Windows and macOS take for .git or .fontego are reserved too", () => {
    const aliases = [
      ".git.", ".git ", ".git. . ", ".git::$INDEX_ALLOCATION", ".git:stream", "GIT~1", "git~2/config", "a/Git~1/hooks/x",
      ".fontego.", ".FONTEGO ", ".fontego::$DATA", "FONTEG~1/state.json", "fonteg~3",
      ".g\u200cit/config", "\ufeff.git", ".fon\u200dtego/state.json", ".git\u200e.", ".g\u0131t/config",
    ];
    for (const p of aliases) expect([p, code(p)]).toEqual([p, "reserved_path"]);
    expect(isReservedName("GIT~1")).toBe(true);
    // What only looks like them stays fine: other short names, a colon or a dot elsewhere, other invisible characters.
    for (const p of ["gitx~1", "git~", "git~a", "fontego~1", ".gitx.", "a.git", ".git-notes", "git:hub", "a:b.md", "x.", ".g\u00e9t"]) {
      expect([p, code(p)]).toEqual([p, "ok"]);
    }
  });

  test("control characters are refused, C1 included", () => {
    for (const p of ["a\u0000b", "tab\there", "line\nbreak", "del\u007f", "nel\u0085.md", "csi\u009b[31m.md"]) {
      expect([p, code(p)]).toEqual([p, "invalid_path"]);
    }
    expect(code("caf\u00e9\u00a0menu.md")).toBe("ok"); // from U+00A0 on, ordinary text
  });
});

describe("symlinkTarget", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const why = (path: string, target: string | Uint8Array) => {
    try {
      symlinkTarget(path, typeof target === "string" ? enc(target) : target);
      return "ok";
    } catch (e) {
      return (e as PathError).code;
    }
  };

  test("a target goes up at most to the top, then only down", () => {
    for (const [path, target] of [
      ["start-here.md", "guide.md"],
      ["docs/latest", "2026/plan.md"],
      ["sub/CLAUDE.md", "../AGENTS.md"],
      ["a/b/c", "../../x/y.md"],
      ["docs/up", ".."],
      ["docs/here", "."],
      ["start.md", "./guide.md"],
      ["shared", "notes/"],
    ]) {
      expect([path, target, why(path, target)]).toEqual([path, target, "ok"]);
    }
  });

  test("a chain of links that each land inside on paper can't be made: no .. after a name", () => {
    // a -> . is harmless alone; b -> a/.. would be the folder above the copy, and c -> b/secret.txt a file outside it.
    expect(why("a", ".")).toBe("ok");
    expect(why("b", "a/..")).toBe("path_escapes");
    expect(why("x/b", "../a/../..")).toBe("path_escapes");
    expect(why("c", "b/./../secret.txt")).toBe("path_escapes");
  });

  test("nothing that climbs out, is absolute, or that Windows reads as a separator or a drive", () => {
    for (const [path, target, code] of [
      ["l", "..", "path_escapes"],
      ["docs/l", "../../etc/passwd", "path_escapes"],
      ["l", "/etc/passwd", "invalid_symlink"],
      ["l", "..\\..\\secret", "invalid_symlink"],
      ["l", "C:/Users/ana", "invalid_symlink"],
      ["l", "a:b", "invalid_symlink"],
      ["l", "", "invalid_symlink"],
      ["l", "a\nb", "invalid_symlink"],
      ["l", "a//b", "invalid_symlink"],
      ["l", ".git/hooks/pre-commit", "reserved_path"],
      ["l", "x/.fontego/state.json", "reserved_path"],
      ["l", "GIT~1/config", "reserved_path"],
    ]) {
      expect([path, target, why(path, target)]).toEqual([path, target, code]);
    }
    expect(why("l", new Uint8Array([0x63, 0xe9]))).toBe("invalid_symlink"); // not UTF-8
  });

  test("it returns the target as written", () => {
    expect(symlinkTarget("docs/latest", enc("2026/plan.md"))).toBe("2026/plan.md");
  });
});

describe("windowsNameProblem", () => {
  test("device names, the characters Windows doesn't take, and a trailing dot or space", () => {
    for (const p of ["CON", "aux.md", "docs/nul.txt", "Com1", "lpt9.log", "COM\u00b9", "con .txt", "CONOUT$", "a:b", "what?.md", "x<y", "pipe|d", 'say"hi"', "star*", "notes.", "notes ", "dir./a.md"]) {
      expect([p, windowsNameProblem(p) === null]).toEqual([p, false]);
    }
  });

  test("ordinary names are fine", () => {
    for (const p of ["console.md", "auxiliary/notes.md", "com10", "lpt", "nul-results.csv", ".env.example", "a b.md", "plan (conflict Ana 2026-11-16 10.42.07).md"]) {
      expect([p, windowsNameProblem(p)]).toEqual([p, null]);
    }
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
