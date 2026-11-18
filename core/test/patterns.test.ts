// Path patterns: the server and every client must agree on which paths a workspace protects or rejects.

import { describe, expect, test } from "bun:test";
import { matchPath, pathPatternError, patternReachesBelow } from "../src/paths.ts";

describe("path patterns", () => {
  test("whole paths from the top; ** for any number of folders, none included", () => {
    expect(matchPath("**/AGENTS.md", "AGENTS.md")).toBe(true);
    expect(matchPath("**/AGENTS.md", "docs/team/AGENTS.md")).toBe(true);
    expect(matchPath("**/AGENTS.md", "docs/AGENTS.md.bak")).toBe(false);
    expect(matchPath("AGENTS.md", "docs/AGENTS.md")).toBe(false);
    expect(matchPath(".claude/**", ".claude/skills/a/SKILL.md")).toBe(true);
    expect(matchPath(".claude/**", "notes/.claude/x")).toBe(false);
    expect(matchPath("**/.claude/**", "notes/.claude/x")).toBe(true);
    expect(matchPath("a/**/b.md", "a/b.md")).toBe(true);
    expect(matchPath("a/**/b.md", "a/x/y/b.md")).toBe(true);
  });

  test("* and ? stay within one name", () => {
    expect(matchPath("**/.claude/settings*.json", ".claude/settings.local.json")).toBe(true);
    expect(matchPath("**/.claude/settings*.json", ".claude/settings/x.json")).toBe(false);
    expect(matchPath("notes/?.md", "notes/a.md")).toBe(true);
    expect(matchPath("notes/?.md", "notes/ab.md")).toBe(false);
    expect(matchPath("notes/a.md", "notes/a+md")).toBe(false); // the dot is a dot
  });

  test("case doesn't count, as on macOS and Windows", () => {
    expect(matchPath("**/AGENTS.md", "docs/Agents.md")).toBe(true);
    expect(matchPath("**/.mcp.json", ".MCP.json")).toBe(true);
  });

  test("a symlink is checked for what it would bring in below it", () => {
    expect(patternReachesBelow("**/.claude/settings*.json", ".claude")).toBe(true);
    expect(patternReachesBelow("**/.claude/settings*.json", "notes/.claude")).toBe(true);
    expect(patternReachesBelow("**/.claude/settings*.json", "notes")).toBe(false);
    expect(patternReachesBelow("**/AGENTS.md", "notes")).toBe(false);
    expect(patternReachesBelow(".opencode/plugins/**", ".opencode")).toBe(true);
    expect(patternReachesBelow(".opencode/plugins/**", ".opencode/plugins")).toBe(true);
  });

  test("bad patterns say why", () => {
    for (const bad of ["", "/AGENTS.md", "docs/", "a//b", "../x", "a/**b", "a\\b"]) expect(pathPatternError(bad)).not.toBeNull();
    expect(pathPatternError("**/.claude/settings*.json")).toBeNull();
  });
});
