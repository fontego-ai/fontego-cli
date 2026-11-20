import { describe, expect, test } from "bun:test";
import type { CommandOutput, CommandSpec } from "@fontego/core";
import { checkCommand, renderOutput } from "../src/declared.ts";

const commits = {
  commits: [
    { commit: "aaaaaaaaaaaa", who: "Ana", agent: "", files: [{ s: "A", p: "one.md" }, { s: "D", p: "two.md" }], total: 2 },
    { commit: "bbbbbbbbbbbb", who: "Bo", agent: "", files: [{ s: "M", p: "big.md" }], total: 5000 },
  ],
  next: "c2",
};

const table: CommandOutput = {
  kind: "table",
  rows: "commits",
  columns: [
    { header: "COMMIT", value: "{commit|short}" },
    { header: "WHO", value: "{who}" },
    { header: "AGENT", value: "{agent}", optional: true },
  ],
  details: { rows: "files", line: "{s} {p}", total: "total" },
  footer: ["{next|if:Older: --cursor }{next}", "{missing|if:Some are missing.}"],
};

describe("printing what a declared command answers", () => {
  test("lines under each row, how many more when the list was cut, and the footer lines that have something to say", () => {
    expect(renderOutput(table, commits, {})).toBe(
      ["COMMIT      WHO", "aaaaaaaaaa  Ana", "  A one.md", "  D two.md", "bbbbbbbbbb  Bo", "  M big.md", "  … 4999 more", "", "Older: --cursor c2"].join("\n"),
    );
  });

  test("an optional column stays when one row fills it; without a next page there is no footer", () => {
    const data = { commits: [{ ...commits.commits[0]!, agent: "codex", files: [], total: 0 }], next: null };
    expect(renderOutput(table, data, {})).toBe(["COMMIT      WHO  AGENT", "aaaaaaaaaa  Ana  codex"].join("\n"));
    expect(renderOutput({ ...table, details: undefined }, { commits: [], next: null }, {})).toBe("(none)");
  });

  test("lines get their details too", () => {
    const lines: CommandOutput = { kind: "lines", rows: "commits", line: "{commit|short} {who}", details: { rows: "files", line: "{p}" } };
    expect(renderOutput(lines, { commits: commits.commits.slice(0, 1) }, {})).toBe("aaaaaaaaaa Ana\n  one.md\n  two.md");
  });

  test("a declaration whose details don't name a field, or whose footer is broken, can't run", () => {
    const spec: CommandSpec = { name: "x", summary: "x", group: "x", request: { method: "GET", path: "/v1/x" }, output: { ...table, details: { rows: "files[0]", line: "{p" } } };
    expect(checkCommand(spec, [])).toEqual(['fontego x: "files[0]" doesn\'t name a field', 'fontego x: unbalanced braces in "{p"']);
  });
});
