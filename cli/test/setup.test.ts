// `fontego setup` and the hints for agents. No server: setup only writes files in the home it is given.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentName } from "../src/agents.ts";
import { SKILL, SKILL_NAME } from "../src/commands/setup.ts";
import { tempDir } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");

/** Runs fontego in a home of its own, with a PATH where no agent is installed unless the test puts one. */
async function fontego(home: string, args: string[], env: Record<string, string> = {}) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CODEX|COPILOT|OPENCODE|CURSOR|GEMINI|FONTEGO|XDG)/.test(k)));
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...clean, HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), FONTEGO_CREDENTIAL_STORE: "file", FONTEGO_BROWSER: "none", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

const claudeSkill = (home: string) => join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
const sharedSkill = (home: string) => join(home, ".agents", "skills", SKILL_NAME, "SKILL.md");

describe("fontego setup", () => {
  test("writes the skill once for each folder the agents here read, and --remove takes it away", async () => {
    const home = tempDir("fontego-setup-");
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));

    const first = await fontego(home, ["setup", "--json"]);
    expect(first.code).toBe(0);
    const r = JSON.parse(first.out);
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(["written", "written"]);
    expect(r.results[0].agents).toEqual(["Claude Code"]);
    expect(r.results[1].agents).toEqual(["Codex"]);
    expect(r.missing).toContain("OpenCode");
    expect(readFileSync(claudeSkill(home), "utf8")).toBe(SKILL);
    expect(readFileSync(sharedSkill(home), "utf8")).toBe(SKILL);

    const again = JSON.parse((await fontego(home, ["setup", "--json"])).out);
    expect(again.results.map((x: { status: string }) => x.status)).toEqual(["unchanged", "unchanged"]);

    const gone = await fontego(home, ["setup", "--remove"]);
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("removed");
    expect(existsSync(join(home, ".claude", "skills", SKILL_NAME))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", SKILL_NAME))).toBe(false);
  });

  test("an agent found by its command on the PATH counts too", async () => {
    const home = tempDir("fontego-setup-");
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    const r = JSON.parse((await fontego(home, ["setup", "--json"])).out);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].agents).toEqual(["OpenCode"]);
    expect(existsSync(claudeSkill(home))).toBe(false);
  });

  test("follows the variables that move an agent's folders", async () => {
    const home = tempDir("fontego-setup-");
    const copilot = join(home, "copilot-home");
    mkdirSync(copilot);
    mkdirSync(join(home, ".codex"));
    const r = JSON.parse((await fontego(home, ["setup", "--json"], { COPILOT_HOME: copilot, CLAUDE_CONFIG_DIR: join(home, "claude-elsewhere") })).out);
    // Copilot skips ~/.agents when COPILOT_HOME is set: the skill goes into its own folder too. No Claude Code here.
    expect(r.results.map((x: { path: string }) => x.path)).toEqual([sharedSkill(home), join(copilot, "skills", SKILL_NAME, "SKILL.md")]);
    expect(r.results[0].agents).toEqual(["Codex"]);
    expect(existsSync(join(copilot, "skills", SKILL_NAME, "SKILL.md"))).toBe(true);
  });

  test("never overwrites or removes a fontego skill it didn't write", async () => {
    const home = tempDir("fontego-setup-");
    mkdirSync(join(home, ".claude", "skills", SKILL_NAME), { recursive: true });
    writeFileSync(claudeSkill(home), "---\nname: fontego\ndescription: mine\n---\n");
    const r = JSON.parse((await fontego(home, ["setup", "--json"])).out);
    expect(r.results[0].status).toBe("kept");
    expect(r.results[0].reason).toContain("move it away");
    expect((await fontego(home, ["setup", "--remove", "--json"])).out).toContain('"kept"');
    expect(readFileSync(claudeSkill(home), "utf8")).toContain("description: mine");
  });

  test("with no agent here it writes nothing and says how to place the skill by hand", async () => {
    const home = tempDir("fontego-setup-");
    const r = await fontego(home, ["setup"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No AI agent found");
    expect(r.out).toContain("fontego setup --print");
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect((await fontego(home, ["setup", "--print"])).out).toBe(SKILL);
  });

  test("the skill follows the Agent Skills format and sends the agent to help --agent", () => {
    const [, front] = SKILL.split("---\n");
    const field = (k: string) => front!.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1] ?? "";
    expect(field("name")).toBe(SKILL_NAME);
    expect(field("name")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(field("description").length).toBeGreaterThan(0);
    expect(field("description").length).toBeLessThanOrEqual(1024);
    expect(SKILL).toContain("fontego help --agent");
  });
});

describe("hints for agents", () => {
  test("each agent is told apart by the variables it sets, and FONTEGO_AGENT names one", () => {
    expect(agentName({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(agentName({ CODEX_THREAD_ID: "019a" })).toBe("codex");
    expect(agentName({ COPILOT_CLI: "1" })).toBe("copilot");
    expect(agentName({ OPENCODE: "1" })).toBe("opencode");
    expect(agentName({ GEMINI_CLI: "1" })).toBe("gemini");
    expect(agentName({ FONTEGO_AGENT: "My Bot!", CLAUDECODE: "1" })).toBe("my-bot-");
    expect(agentName({})).toBeNull();
  });

  test("an agent that gets a command wrong is pointed to help --agent; a person, to the command's help", async () => {
    const home = tempDir("fontego-setup-");
    const agent = await fontego(home, ["setup", "--no-such-flag", "--json"], { CLAUDECODE: "1" });
    expect(agent.code).toBe(1);
    expect(JSON.parse(agent.out).error.hint).toContain("fontego help --agent");
    const person = await fontego(home, ["setup", "--no-such-flag"]);
    expect(person.err).toContain("usage:");
    expect(person.err).toContain("hint: Run: fontego help setup"); // the command's help, not the agents' guide
    expect(person.err).not.toContain("help --agent");
    expect((await fontego(home, ["help"], { CLAUDECODE: "1" })).out).toContain("Running from claude-code: fontego help --agent");
  });
});
