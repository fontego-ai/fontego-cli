// The coding agents fontego knows about: how to tell that one is running this CLI (for the server's log and for the
// hints written for agents), whether one is installed here, and where each reads its user-level skills from, so
// `fontego setup` can teach them all with one short skill.
//
// Checked in November 2026 against each one's docs and code (Claude Code 2.1, Codex 0.170, Copilot CLI 1.0.114,
// OpenCode 1.19, Cursor 2026.11, Gemini CLI 0.70). Cursor's variable is the only one not documented.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

type Env = Record<string, string | undefined>;

export interface Agent {
  /** What the server's log shows ("Ana, from claude-code") */
  id: string;
  name: string;
  /** Set in the shell commands this agent runs for its model */
  runs: (env: Env) => boolean;
  /** Its own folders or commands: if one is here, the agent is installed */
  homes: (env: Env, home: string) => string[];
  commands: string[];
}

const xdgConfig = (env: Env, home: string) => env.XDG_CONFIG_HOME || join(home, ".config");

export const AGENTS: Agent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    runs: (env) => env.CLAUDECODE === "1",
    homes: (env, home) => [env.CLAUDE_CONFIG_DIR || join(home, ".claude")],
    commands: ["claude"],
  },
  {
    id: "codex",
    name: "Codex",
    runs: (env) => !!env.CODEX_THREAD_ID,
    homes: (env, home) => [env.CODEX_HOME || join(home, ".codex")],
    commands: ["codex"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    runs: (env) => env.COPILOT_CLI === "1",
    homes: (env, home) => [env.COPILOT_HOME || join(home, ".copilot")],
    commands: ["copilot"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    runs: (env) => env.OPENCODE === "1",
    homes: (env, home) => [join(xdgConfig(env, home), "opencode")],
    commands: ["opencode"],
  },
  {
    id: "cursor",
    name: "Cursor",
    runs: (env) => env.CURSOR_AGENT === "1",
    homes: (_env, home) => [join(home, ".cursor")],
    commands: ["cursor-agent", "cursor"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    runs: (env) => env.GEMINI_CLI === "1",
    homes: (env, home) => [join(env.GEMINI_CLI_HOME || home, ".gemini")],
    commands: ["gemini"],
  },
];

/** A folder of user-level skills, and the agents that read it. */
export interface SkillsFolder {
  dir: string;
  agents: Agent[];
}

const byId = (...ids: string[]) => ids.map((id) => AGENTS.find((a) => a.id === id)!);

/**
 * Where to put a user-level skill so that every agent finds it. Most read the shared `~/.agents/skills`; Claude Code
 * reads only its own folder. Each agent's own folder is left alone: Gemini would warn of a conflict, and Codex's is
 * deprecated. OpenCode and Cursor also read Claude Code's folder, so they find the skill twice: OpenCode keeps one,
 * and both copies are the same file.
 */
export function skillsFolders(env: Env = process.env, home = homeOf(env)): SkillsFolder[] {
  const shared = ["codex", "opencode", "cursor"];
  const folders: SkillsFolder[] = [{ dir: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), agents: byId("claude-code") }];
  // Copilot stops reading ~/.agents when COPILOT_HOME is set; Gemini reads it under GEMINI_CLI_HOME instead of HOME.
  if (!env.COPILOT_HOME) shared.push("copilot");
  if (!env.GEMINI_CLI_HOME) shared.push("gemini");
  folders.push({ dir: join(home, ".agents", "skills"), agents: byId(...shared) });
  if (env.COPILOT_HOME) folders.push({ dir: join(env.COPILOT_HOME, "skills"), agents: byId("copilot") });
  if (env.GEMINI_CLI_HOME) folders.push({ dir: join(env.GEMINI_CLI_HOME, ".agents", "skills"), agents: byId("gemini") });
  return folders;
}

export const homeOf = (env: Env = process.env) => env.HOME || env.USERPROFILE || homedir();

function onPath(cmd: string, env: Env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return (env.PATH || "").split(delimiter).some((d) => d && exts.some((x) => existsSync(join(d, cmd + x))));
}

/** Whether an agent is installed on this machine: one of its folders, or its command on the PATH. */
export function installed(a: Agent, env: Env = process.env, home = homeOf(env)): boolean {
  return a.homes(env, home).some((d) => existsSync(d)) || a.commands.some((c) => onPath(c, env));
}

/** Which agent runs this CLI, if any. `FONTEGO_AGENT` names it; otherwise each agent's own variables tell. */
export function agentName(env: Env = process.env): string | null {
  const named = env.FONTEGO_AGENT?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  if (named) return named;
  return AGENTS.find((a) => a.runs(env))?.id ?? null;
}
