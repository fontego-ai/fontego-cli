import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandOutput, CommandSpec } from "@fontego/core";
import { UsageError } from "../src/args.ts";
import { buildRequest, checkCommand, commandsCachePath, readCommands, renderOutput } from "../src/declared.ts";
import { tempDir } from "./server.ts";

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

describe("what a server can make fontego do", () => {
  const spec = (over: Partial<CommandSpec> = {}): CommandSpec =>
    ({
      name: "rm",
      summary: "Delete a file",
      group: "Files",
      args: [
        { name: "WORKSPACE", to: "path.workspace" },
        { name: "PATH", to: "path.path" },
      ],
      request: { method: "DELETE", path: "/v1/workspaces/{workspace}/files/{+path}" },
      output: { kind: "message", text: "Deleted {$PATH}" },
      ...over,
    }) as CommandSpec;

  test("a request only goes to a plain path under /v1 of the same server", () => {
    expect(checkCommand(spec(), [])).toEqual([]);
    for (const path of ["@127.0.0.1:47999/v1/x", "/v1/../admin", "/v1/a/./b", "//evil.example/v1/x", "/v1/x?y=1", "/v1/x#y", "/v2/x"]) {
      expect(checkCommand(spec({ request: { method: "GET", path } }), []).join()).toContain("plain path under /v1");
    }
  });

  test("names are plain words, so they can't carry anything to the terminal", () => {
    const evil = spec({ args: [{ name: "PASSWORD\u001b[2K\rYour GitHub password", to: "body.pw", secret: true, optional: true }] });
    expect(checkCommand(evil, []).join()).toContain("isn't a plain argument name");
    expect(checkCommand(spec({ name: "rm\u001b]52;c;eA==\u0007" }), []).join()).toContain("isn't a plain command name");
  });

  test("a path argument never leaves its place in the route", () => {
    const run = (path: string) => buildRequest(spec(), { args: { WORKSPACE: "demo", PATH: path }, flags: {} }).path;
    expect(run("notes/a b.md")).toBe("/v1/workspaces/demo/files/notes/a%20b.md");
    for (const bad of ["../members/bob@example.org", "a/../../x", "a//b", "./a", "a/.."]) {
      expect(() => run(bad)).toThrow(UsageError);
    }
    expect(() => buildRequest(spec(), { args: { WORKSPACE: "..", PATH: "a" }, flags: {} })).toThrow('WORKSPACE can\'t be empty or have an empty, "." or ".." part');
  });

  test("the commands a server declares that this fontego won't run are kept apart, with why", () => {
    const home = tempDir("fontego-cache-");
    const url = "http://127.0.0.1:1";
    process.env.XDG_CACHE_HOME = home;
    try {
      const good = spec();
      const bad = spec({ name: "steal", request: { method: "GET", path: "@127.0.0.1:47999/v1/x" } });
      const path = commandsCachePath(url);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: "1", commands: [good, bad], url, fetchedAt: "", me: null }));
      const read = readCommands(url)!;
      expect(read.commands.map((c) => c.name)).toEqual(["rm"]);
      expect(read.refused).toEqual([{ name: "steal", problems: ["fontego steal: the request must go to a plain path under /v1"] }]);
    } finally {
      delete process.env.XDG_CACHE_HOME;
    }
  });
});
