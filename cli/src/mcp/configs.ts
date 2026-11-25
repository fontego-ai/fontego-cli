// Where each agent keeps its MCP servers, and the entry `fontego mcp add` writes there. Checked in November 2026
// against each one's docs and the versions on a test machine (Claude Code 2.1, Codex 0.170, Copilot CLI 1.0.114,
// OpenCode 1.19, Cursor 2026.11, Gemini CLI 0.70).
//
// Two ways in, both with this machine's session and no secret in the agent's config:
// - "header": the agent runs `fontego mcp header` for its headers when it connects, and again after a 401 (Claude
//   Code's headersHelper, Codex's http_headers_helper), and talks to /mcp itself;
// - "proxy": the agent runs `fontego mcp proxy` as a local MCP server over stdio, which forwards to /mcp (everyone
//   else, and every project file, since one entry there must work for every agent that reads it and for every person
//   with their own session).

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AGENTS, findOnPath, homeOf, type Agent } from "../agents.ts";

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;

export type Scope = "user" | "project";
export type Way = "header" | "proxy";

/** What is being set up: which Fontego, under which name, and the command that runs this fontego. */
export interface Setup {
  /** The instance's URL (its /mcp is next to its /v1) */
  url: string;
  name: string;
  /** This fontego, as an agent runs it: its absolute path (or bun and its script, from the source) */
  self: string[];
  /** Where a project's files go */
  cwd: string;
  env: Env;
}

export const mcpUrl = (url: string) => `${url.replace(/\/+$/, "")}/mcp`;

/**
 * What Bun is given to run fontego from its source as the executable runs: with nothing of the folder it runs in, no
 * bunfig.toml and no .env files (scripts/build.ts). An agent runs it in folders whose files other people write.
 */
export const BUN_ALONE = ["--no-env-file", `--config=${process.platform === "win32" ? "NUL" : "/dev/null"}`];

/**
 * How this fontego is run from another program: by its absolute path on the PATH (it stays when fontego is updated),
 * when that one knows `fontego mcp`; else this very executable (or bun with its script, from the source).
 */
export function selfCommand(env: Env = process.env): string[] {
  const found = findOnPath("fontego", env);
  if (found) {
    const path = resolve(found);
    const knows = spawnSync(path, ["mcp", "header", "--help", "--json"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 15_000 });
    if (knows.status === 0 && knows.stdout.includes("mcp header")) return [path];
  }
  if (/^fontego(\.exe)?$/i.test(basename(process.execPath))) return [process.execPath];
  return [process.execPath, ...BUN_ALONE, resolve(process.argv[1]!)];
}

/** A word as a POSIX shell reads it back: as it is when it is plain, else in single quotes. */
export const shellWord = (w: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/**
 * The command an agent runs for the headers. Codex runs it with almost nothing of the environment (HOME and PATH): a
 * config folder of its own (XDG_CONFIG_HOME) goes in front, so fontego finds the sign-in; the session bus the
 * keychain needs, fontego finds by itself (commands/mcp.ts).
 */
function headerCommand(s: Setup, agent: string, keepEnv: boolean): string {
  const env = keepEnv ? [] : ["XDG_CONFIG_HOME", "FONTEGO_CREDENTIAL_STORE"].filter((k) => s.env[k]).map((k) => `${k}=${s.env[k]}`);
  const words = [...(env.length ? ["env", ...env] : []), ...s.self, "mcp", "header", "--url", s.url, "--agent", agent];
  return words.map(shellWord).join(" ");
}

/** The proxy's command line: for a person (this fontego, this agent) or for a project (whoever's fontego). */
function proxyCommand(s: Setup, scope: Scope, agent: string): string[] {
  return scope === "project" ? ["fontego", "mcp", "proxy", "--url", s.url] : [...s.self, "mcp", "proxy", "--url", s.url, "--agent", agent];
}

/** Whether an entry is one fontego mcp add wrote: it runs `fontego mcp header` or `fontego mcp proxy`. */
export function isOurs(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Json;
  for (const helper of [e.headersHelper, e.http_headers_helper]) if (typeof helper === "string" && /\bmcp header\b/.test(helper)) return true;
  const words = [...(Array.isArray(e.command) ? e.command : [e.command]), ...(Array.isArray(e.args) ? e.args : [])].map(String);
  return words.some((w, i) => w === "mcp" && words[i + 1] === "proxy");
}

/** Which Fontego an entry of ours connects: the URL after --url. */
export function urlOf(entry: unknown): string | null {
  const e = (entry ?? {}) as Json;
  const helper = [e.headersHelper, e.http_headers_helper].find((h) => typeof h === "string") as string | undefined;
  if (helper) return /--url '?([^' ]+)'?/.exec(helper)?.[1] ?? null;
  const words = [...(Array.isArray(e.command) ? e.command : [e.command]), ...(Array.isArray(e.args) ? e.args : [])].map(String);
  const i = words.indexOf("--url");
  return i >= 0 ? (words[i + 1] ?? null) : null;
}

export type Status = "written" | "unchanged" | "removed" | "absent" | "kept";
export type State = "ours" | "other" | "none" | "unreadable";

/** An entry's state for this setup: ours only when it is fontego's and for this Fontego. */
const stateOf = (existing: unknown, s: Setup): State => (existing === undefined ? "none" : blocker(existing, s) ? "other" : "ours");

export interface Result {
  /** Where it is, as a person reads it */
  path: string;
  agents: string[];
  scope: Scope;
  way: Way;
  status: Status;
  reason?: string;
  /** What to put there by hand, when fontego left it alone (or --print) */
  snippet?: string;
}

/** A place where an agent keeps its servers, and the entry for this Fontego. */
export interface Place {
  path: string;
  way: Way;
  /** The entry as it would be added by hand: the JSON for a JSON file, the table for TOML, a command for Claude Code */
  snippet(s: Setup): string;
  /** Whether this Fontego is set up there: by fontego (ours), by something else under that name (other), or not */
  state(s: Setup): State;
  add(s: Setup): { status: Status; reason?: string };
  remove(s: Setup): { status: Status; reason?: string };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes a file in one step (a new name, then renamed over it), keeping its permissions. A config kept as a link (into
 * a dotfiles repository) is written where it leads, so the link stays. The new name can't be guessed and is never one
 * that is there already: in a folder whose files others put there, a link with that name would be written through.
 */
function writeAtomic(path: string, text: string) {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true });
  const mode = existsSync(real) ? statSync(real).mode & 0o777 : 0o644;
  const tmp = `${real}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, text, { mode, flag: "wx" });
  renameSync(tmp, real);
}

/**
 * Why a project's file can't be written, or null: the file, or a folder on its way, is a link that leads out of the
 * project. What is in a project's folder may come from someone else (a synced workspace, a cloned repository), so its
 * links say nothing about where this person keeps their configs, as those of their own home do.
 */
function leadsOut(root: string, path: string): string | null {
  let at = path;
  // The nearest part of it that is there, links included: one that leads nowhere would be made where it points
  while (!lstatSync(at, { throwIfNoEntry: false }) && at !== root) at = dirname(at);
  let real: string;
  try {
    real = realpathSync(at);
  } catch {
    return "a link on its way leads nowhere";
  }
  const from = relative(realpathSync(root), real);
  return from === ".." || from.startsWith("../") || from.startsWith("..\\") || isAbsolute(from) ? "it is a link, or goes through one, that leads out of this folder" : null;
}

/** A place in a project, which nothing is read from or written to when it leads out of it (leadsOut). */
function inProject(root: string, place: Place): Place {
  const guarded = <T>(inside: () => T, outside: (why: string) => T): T => {
    const why = leadsOut(root, place.path);
    return why ? outside(why) : inside();
  };
  const kept = (why: string) => ({ status: "kept" as const, reason: `${why}: fontego leaves it alone` });
  return {
    ...place,
    state: (s) => guarded<State>(() => place.state(s), () => "unreadable"),
    add: (s) => guarded<{ status: Status; reason?: string }>(() => place.add(s), kept),
    remove: (s) => guarded<{ status: Status; reason?: string }>(() => place.remove(s), kept),
  };
}

/** Why an entry of that name stays as it is, or null when it can be written. */
function blocker(existing: unknown, s: Setup): string | null {
  if (existing === undefined) return null;
  if (!isOurs(existing)) return `there is already an MCP server named ${s.name} there that fontego mcp add didn't write: choose another name (--name), or take it out first`;
  const other = urlOf(existing);
  if (other && other.replace(/\/+$/, "") !== s.url.replace(/\/+$/, "")) {
    return `it connects ${s.name} to another Fontego (${other}): give this one another name (--name), or fontego mcp remove the other first`;
  }
  return null;
}

/** Why an entry of that name isn't taken out: someone else's, or this name for another Fontego. */
function removalBlocker(existing: unknown, s: Setup): string | null {
  if (!isOurs(existing)) return `its ${s.name} wasn't written by fontego mcp add`;
  const other = urlOf(existing);
  if (other && other.replace(/\/+$/, "") !== s.url.replace(/\/+$/, "")) return `its ${s.name} connects another Fontego (${other}): take it out with --instance for that one`;
  return null;
}

/** A JSON file with the servers under `key` (mcpServers, or OpenCode's mcp). One with comments is left alone. */
function jsonPlace(path: string, key: string, way: Way, entry: Json): Place {
  const read = (): { doc: Json; error?: string } => {
    if (!existsSync(path)) return { doc: {} };
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return { doc: {} };
    try {
      const doc = JSON.parse(text) as unknown;
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { doc: {}, error: "it isn't a JSON object" };
      return { doc: doc as Json };
    } catch {
      return { doc: {}, error: "it isn't plain JSON (it may have comments), and rewriting it would lose them: add the entry below by hand" };
    }
  };
  const serversOf = (doc: Json): Json | null => {
    const v = doc[key];
    return v === undefined ? {} : v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  };
  return {
    path,
    way,
    snippet: (s) => JSON.stringify({ [key]: { [s.name]: entry } }, null, 2),
    state(s) {
      const { doc, error } = read();
      const servers = error ? null : serversOf(doc);
      return servers ? stateOf(servers[s.name], s) : "unreadable";
    },
    add(s) {
      const { doc, error } = read();
      if (error) return { status: "kept", reason: error };
      const servers = serversOf(doc);
      if (!servers) return { status: "kept", reason: `its "${key}" isn't an object` };
      if (sameJson(servers[s.name], entry)) return { status: "unchanged" };
      const why = blocker(servers[s.name], s);
      if (why) return { status: "kept", reason: why };
      writeAtomic(path, JSON.stringify({ ...doc, [key]: { ...servers, [s.name]: entry } }, null, 2) + "\n");
      return { status: "written" };
    },
    remove(s) {
      const { doc, error } = read();
      if (error) return existsSync(path) ? { status: "kept", reason: error } : { status: "absent" };
      const servers = serversOf(doc);
      if (!servers || servers[s.name] === undefined) return { status: "absent" };
      const why = removalBlocker(servers[s.name], s);
      if (why) return { status: "kept", reason: why };
      const { [s.name]: _, ...rest } = servers;
      writeAtomic(path, JSON.stringify({ ...doc, [key]: rest }, null, 2) + "\n");
      return { status: "removed" };
    },
  };
}

/** TOML's basic string, which takes JSON's escapes. */
const tomlString = (v: string) => JSON.stringify(v);

/**
 * Codex's config.toml: a table `[mcp_servers.NAME]` between two comments that mark it as fontego's, so it can be
 * rewritten or taken out without touching anything else in the file (comments and all).
 */
function tomlPlace(path: string, way: Way, fields: Record<string, string | string[]>): Place {
  const begin = (name: string) => `# >>> fontego mcp add: ${name} (fontego mcp remove takes it away)`;
  const end = (name: string) => `# <<< fontego mcp add: ${name} (end)`;
  const block = (name: string) =>
    [
      begin(name),
      `[mcp_servers.${name}]`,
      ...Object.entries(fields).map(([k, v]) => `${k} = ${Array.isArray(v) ? `[${v.map(tomlString).join(", ")}]` : tomlString(v)}`),
      end(name),
    ].join("\n");
  const find = (text: string, name: string): { from: number; to: number } | null => {
    const from = text.indexOf(begin(name));
    if (from < 0) return null;
    const stop = text.indexOf(end(name), from);
    return stop < 0 ? null : { from, to: stop + end(name).length };
  };
  const parse = (text: string): Json | null => {
    try {
      return Bun.TOML.parse(text) as Json;
    } catch {
      return null;
    }
  };
  const theirs = (doc: Json, name: string) => ((doc.mcp_servers ?? {}) as Json)[name];
  return {
    path,
    way,
    snippet: (s) => block(s.name),
    state(s) {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const doc = parse(text);
      if (!doc) return "unreadable";
      return find(text, s.name) ? stateOf(theirs(doc, s.name), s) : theirs(doc, s.name) !== undefined ? "other" : "none";
    },
    add(s) {
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const doc = parse(text);
      if (!doc) return { status: "kept", reason: "it isn't valid TOML now: fix it first" };
      const mine = find(text, s.name);
      const wanted = block(s.name);
      if (mine) {
        if (text.slice(mine.from, mine.to) === wanted) return { status: "unchanged" };
        const why = blocker(theirs(doc, s.name), s);
        if (why) return { status: "kept", reason: why };
      } else if (theirs(doc, s.name) !== undefined) {
        return { status: "kept", reason: `there is already [mcp_servers.${s.name}] there that fontego mcp add didn't write: choose another name (--name)` };
      }
      const next = mine ? text.slice(0, mine.from) + wanted + text.slice(mine.to) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text.trim() ? "\n" : ""}${wanted}\n`;
      if (!parse(next)) return { status: "kept", reason: "adding the table would leave it invalid TOML: add the entry below by hand" };
      writeAtomic(path, next);
      return { status: "written" };
    },
    remove(s) {
      if (!existsSync(path)) return { status: "absent" };
      const text = readFileSync(path, "utf8");
      const mine = find(text, s.name);
      const doc = parse(text);
      if (!mine) return doc && theirs(doc, s.name) !== undefined ? { status: "kept", reason: `its ${s.name} wasn't written by fontego mcp add` } : { status: "absent" };
      const why = doc ? removalBlocker(theirs(doc, s.name), s) : null;
      if (why) return { status: "kept", reason: why };
      const next = (text.slice(0, mine.from).replace(/\n\n$/, "\n") + text.slice(mine.to).replace(/^\n/, "")).replace(/^\n+/, "");
      writeAtomic(path, next);
      return { status: "removed" };
    },
  };
}

/**
 * Claude Code at the person's level: its servers live in ~/.claude.json, a file Claude Code itself rewrites while it
 * runs, so the entry goes in through its own command (`claude mcp add-json -s user`), never by editing the file.
 */
function claudeUserPlace(entry: Json, env: Env): Place {
  const file = join(env.CLAUDE_CONFIG_DIR || homeOf(env), ".claude.json");
  const existing = (name: string): unknown => {
    try {
      return ((JSON.parse(readFileSync(file, "utf8")) as Json).mcpServers as Json | undefined)?.[name];
    } catch {
      return undefined;
    }
  };
  const claude = () => findOnPath("claude", env);
  const run = (args: string[]) => {
    const r = spawnSync(claude()!, args, { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
    return r.status === 0 ? null : (r.stderr || r.stdout || r.error?.message || `claude exited with ${r.status}`).trim().split("\n")[0]!;
  };
  return {
    path: file,
    way: "header",
    snippet: (s) => `claude mcp add-json -s user ${s.name} ${shellWord(JSON.stringify(entry))}`,
    state: (s) => stateOf(existing(s.name), s),
    add(s) {
      const had = existing(s.name);
      if (sameJson(had, entry)) return { status: "unchanged" };
      const why = blocker(had, s);
      if (why) return { status: "kept", reason: why };
      if (!claude()) return { status: "kept", reason: "the claude command isn't on the PATH: add the entry below with claude mcp add-json -s user" };
      if (had !== undefined) {
        const failed = run(["mcp", "remove", "-s", "user", s.name]);
        if (failed) return { status: "kept", reason: `claude mcp remove: ${failed}` };
      }
      const failed = run(["mcp", "add-json", "-s", "user", s.name, JSON.stringify(entry)]);
      if (!failed) return { status: "written" };
      return {
        status: "kept",
        reason:
          had !== undefined
            ? `the old entry was taken out to be replaced, and adding the new one failed (claude mcp add-json: ${failed}): add the entry below by hand`
            : `claude mcp add-json: ${failed}`,
      };
    },
    remove(s) {
      const had = existing(s.name);
      if (had === undefined) return { status: "absent" };
      const why = removalBlocker(had, s);
      if (why) return { status: "kept", reason: why };
      if (!claude()) return { status: "kept", reason: "the claude command isn't on the PATH: claude mcp remove -s user takes it out" };
      const failed = run(["mcp", "remove", "-s", "user", s.name]);
      return failed ? { status: "kept", reason: `claude mcp remove: ${failed}` } : { status: "removed" };
    },
  };
}

const xdgConfig = (env: Env) => env.XDG_CONFIG_HOME || join(homeOf(env), ".config");

/** OpenCode's config: opencode.json, or opencode.jsonc when that is the one there. */
function opencodeFile(dir: string, names = ["opencode.json", "opencode.jsonc"]): string {
  return names.map((n) => join(dir, n)).find((p) => existsSync(p)) ?? join(dir, names[0]!);
}

/** The place each agent keeps its servers, for a person or for a project, with the entry for this Fontego. */
export function placeFor(agent: Agent, scope: Scope, s: Setup): Place {
  const place = placeOf(agent, scope, s);
  return scope === "project" ? inProject(s.cwd, place) : place;
}

function placeOf(agent: Agent, scope: Scope, s: Setup): Place {
  const home = homeOf(s.env);
  const proxy = proxyCommand(s, scope, agent.id);
  const stdio = (type?: string): Json => ({ ...(type ? { type } : {}), command: proxy[0]!, args: proxy.slice(1) });
  const at = (p: string) => join(s.cwd, p);
  switch (agent.id) {
    case "claude-code":
      return scope === "user"
        ? claudeUserPlace({ type: "http", url: mcpUrl(s.url), headersHelper: headerCommand(s, agent.id, true) }, s.env)
        : jsonPlace(at(".mcp.json"), "mcpServers", "proxy", stdio("stdio"));
    case "codex":
      return scope === "user"
        ? tomlPlace(join(s.env.CODEX_HOME || join(home, ".codex"), "config.toml"), "header", { url: mcpUrl(s.url), http_headers_helper: headerCommand(s, agent.id, false) })
        : tomlPlace(at(".codex/config.toml"), "proxy", { command: proxy[0]!, args: proxy.slice(1) });
    case "copilot":
      // A project's .mcp.json is Claude Code's too: one entry for both.
      return scope === "user"
        ? jsonPlace(join(s.env.COPILOT_HOME || join(home, ".copilot"), "mcp-config.json"), "mcpServers", "proxy", { type: "local", command: proxy[0]!, args: proxy.slice(1), tools: ["*"] })
        : jsonPlace(at(".mcp.json"), "mcpServers", "proxy", stdio("stdio"));
    case "opencode":
      return jsonPlace(scope === "user" ? opencodeFile(join(xdgConfig(s.env), "opencode")) : opencodeFile(s.cwd), "mcp", "proxy", { type: "local", command: proxy, enabled: true });
    case "cursor":
      return jsonPlace(scope === "user" ? join(home, ".cursor", "mcp.json") : at(".cursor/mcp.json"), "mcpServers", "proxy", stdio("stdio"));
    case "gemini":
      return jsonPlace(
        scope === "user" ? join(s.env.GEMINI_CLI_HOME || home, ".gemini", "settings.json") : at(".gemini/settings.json"),
        "mcpServers",
        "proxy",
        stdio(),
      );
    default:
      throw new Error(`no MCP setup for ${agent.id}`);
  }
}

/** The agents fontego mcp add knows: all of agents.ts. */
export const MCP_AGENTS = AGENTS;
