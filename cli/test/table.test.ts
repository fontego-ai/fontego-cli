// Tables for a person: as wide as they need, or, on a narrower terminal, with the widest columns wrapped in place.

import { describe, expect, test } from "bun:test";
import { columnWidths, formatTable, wrapCell } from "../src/table.ts";

const HEADER = ["KEY", "VALUE", "FROM"];
const ROWS = [
  ["displayName", "Fontego", "default"],
  ["paths.protected", "**/AGENTS.md, **/CLAUDE.md, **/.agents/**, **/.claude/**, **/.github/copilot-instructions.md", "admin"],
];

describe("a table", () => {
  test("with no width (a pipe, a file), one row per line, as wide as it takes", () => {
    const text = formatTable(HEADER, ROWS);
    expect(text.split("\n")).toEqual([
      "KEY              VALUE                                                                                         FROM",
      "displayName      Fontego                                                                                       default",
      "paths.protected  **/AGENTS.md, **/CLAUDE.md, **/.agents/**, **/.claude/**, **/.github/copilot-instructions.md  admin",
    ]);
  });

  test("on a narrow terminal, the widest column wraps at spaces and every row keeps its other cells on its line", () => {
    const lines = formatTable(HEADER, ROWS, { width: 60 }).split("\n");
    for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(60);
    expect(lines).toEqual([
      "KEY              VALUE                               FROM",
      "displayName      Fontego                             default",
      "paths.protected  **/AGENTS.md, **/CLAUDE.md,         admin",
      "                 **/.agents/**, **/.claude/**,",
      "                 **/.github/copilot-instructions.md",
    ]);
  });

  test("lines under a row stay as they are, and a table that fits is left alone", () => {
    expect(formatTable(["A", "B"], [["1", "x"]], { width: 80, under: () => ["  one.md"] })).toBe("A  B\n1  x\n  one.md");
  });

  test("widths count what a terminal shows: a CJK character takes two columns, an accent none", () => {
    expect(formatTable(["NAME", "X"], [["Lucía", "1"], ["中文", "2"]]).split("\n")).toEqual(["NAME   X", "Lucía  1", "中文   2"]);
  });

  test("the widest columns narrow first, never below their header or 12 columns; a word too long breaks where it must", () => {
    expect(columnWidths([10, 50, 40], [10, 12, 12], 70)).toEqual([10, 28, 28]);
    expect(columnWidths([10, 50, 40], [10, 12, 12], 20)).toEqual([10, 12, 12]); // too narrow anyway: the floors
    expect(columnWidths([10, 50], [10, 12], undefined)).toEqual([10, 50]);
    expect(wrapCell("a https://example.org/a/very/long/path b", 12)).toEqual(["a", "https://exam", "ple.org/a/ve", "ry/long/path", "b"]);
    expect(wrapCell("short", 12)).toEqual(["short"]);
    // What shows as one character is never split: a flag (two code points), a Hangul syllable written in letters, a
    // Devanagari cluster
    expect(wrapCell("🇪🇸🇪🇸🇪🇸", 3)).toEqual(["🇪🇸", "🇪🇸", "🇪🇸"]);
    expect(wrapCell("\u1100\u1161\u11a8\u1100\u1161\u11a8", 3)).toEqual(["\u1100\u1161\u11a8", "\u1100\u1161\u11a8"]);
    expect(wrapCell("नमस्ते", 3)).toEqual(["नम", "स्ते"]);
  });

  test("however many rows there are and however wide a cell is", () => {
    const many = Array.from({ length: 300_000 }, (_, i) => [String(i), "x", "y"]);
    expect(formatTable(HEADER, many, { width: 40 }).split("\n")).toHaveLength(300_001);
    const started = performance.now();
    expect(columnWidths([10, 50_000_000], [10, 12], 80)).toEqual([10, 68]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
