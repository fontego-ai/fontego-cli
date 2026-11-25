// `fontego mcp`: Fontego's MCP (the server's /mcp, every operation as a tool) for the agents of this machine, with
// this machine's session, never a secret written into their config. `add` and `remove` set it up in each agent's own
// file (mcp/configs.ts); `header` gives the agents that can run a program for their headers the session's access token
// at once, renewed when it is about to end; `proxy` is a local MCP server over stdio for the agents that can't.

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { AGENTS, homeOf, installed, type Agent } from "../agents.ts";
import { UsageError, type UsageFlag } from "../args.ts";
import { ClientError } from "../client.ts";
import { connect, type Connection } from "../connect.ts";
import { defaultAlias, instanceByAlias, listInstances, normalizeUrl } from "../config.ts";
import { BUN_ALONE, mcpUrl, placeFor, selfCommand, type Place, type Result, type Scope, type Setup, type Status } from "../mcp/configs.ts";
import { runProxy, stdinLines } from "../mcp/proxy.ts";
import { formatTable, terminalWidth } from "../table.ts";
import { writeStderr } from "../terminal.ts";
import { USER_AGENT } from "../version.ts";
import type { Builtin, RunContext } from "./command.ts";

const GROUP = "Agents";
/** What `fontego mcp header` leaves at least on the access token: agents keep the header until a 401 */
export const HEADER_FRESH_MS = 5 * 60_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

const URL_FLAG: UsageFlag = { name: "url", type: "string", value: "URL", description: "The Fontego to connect to (default: the one in use)" };
const AGENT_FLAG: UsageFlag = { name: "agent", type: "string", value: "NAME", description: "Which agent asks, for the log (claude-code, codex…)" };
const NAME_FLAG: UsageFlag = { name: "name", type: "string", value: "NAME", description: "The server's name in the agents (default fontego)" };
const PROJECT_FLAG: UsageFlag = {
  name: "project",
  type: "boolean",
  description: "In this folder, for everyone who works in it (each with their own sign-in), instead of for you",
};

/**
 * The Fontego a command is for: --url, one this machine is signed in to, whatever the agent's environment says of
 * another (FONTEGO_INSTANCE, or FONTEGO_URL with a token), since the agent runs it with its own environment; else
 * the one in use.
 */
async function connectionFor(rc: RunContext): Promise<Connection> {
  const url = rc.parsed.flags.url;
  if (typeof url !== "string") return rc.connect();
  return connect({ folderUrl: normalizeUrl(url) }, { ...process.env, FONTEGO_INSTANCE: "", FONTEGO_URL: "", FONTEGO_TOKEN: "" });
}

/**
 * The Fontego to look for in the agents' configs, without signing in (removing is this machine's business, also once
 * it is signed out): --url, --instance, FONTEGO_INSTANCE, the synced folder's, or the default one.
 */
function instanceUrlFor(rc: RunContext): string {
  const url = rc.parsed.flags.url;
  if (typeof url === "string") return normalizeUrl(url);
  const alias = rc.instance || process.env.FONTEGO_INSTANCE || defaultAlias() || (listInstances().length === 1 ? listInstances()[0]!.alias : null);
  const instance = alias ? instanceByAlias(alias) : null;
  if (!instance) {
    throw new UsageError(
      alias ? `No instance "${alias}" on this machine.` : "Say which Fontego: --url URL, or --instance ALIAS (fontego sessions lists them).",
    );
  }
  return instance.url;
}

/** The secret of a connection, with at least `minLeftMs` of life when it is a session's. */
const secretOf = (conn: Connection, minLeftMs = 0): Promise<string> => (conn.auth ? conn.auth.token(minLeftMs) : Promise.resolve(process.env.FONTEGO_TOKEN ?? ""));

/**
 * On Linux the keychain is reached through the session's D-Bus. An agent that runs fontego with almost nothing of the
 * environment (Codex's header helper keeps HOME and PATH) leaves it out, and fontego couldn't read its sign-in: then it
 * runs itself again with the bus of this user, which is where systemd always puts it, and exits with its code; or
 * returns, when nothing needs doing.
 */
async function againWithSessionBus(): Promise<void> {
  const env = process.env;
  if (process.platform !== "linux" || env.DBUS_SESSION_BUS_ADDRESS || env.FONTEGO_CREDENTIAL_STORE === "file") return;
  const bus = join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, "bus");
  if (!existsSync(bus)) return;
  // A compiled fontego's argv[1] is its own virtual path; run from the source, it is the script.
  const compiled = /^\/\$bunfs\/|~BUN/.test(process.argv[1] ?? "");
  const child = Bun.spawn([process.execPath, ...(compiled ? process.argv.slice(2) : [...BUN_ALONE, ...process.argv.slice(1)])], {
    env: { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  process.exit(await child.exited);
}

/** Whether that Fontego answers MCP at /mcp: a server older than its MCP doesn't, and nothing is set up then. */
async function checkMcp(conn: Connection): Promise<void> {
  const url = mcpUrl(conn.url);
  const ask = async () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await secretOf(conn)}`, "user-agent": USER_AGENT },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fontego", version: "check" } } }),
      redirect: "manual",
    }).catch((e: Error) => {
      throw new ClientError(0, "unreachable", `Can't reach ${url}: ${e.message}`, "Check that the server is running.");
    });
  let res = await ask();
  if (res.status === 401 && conn.auth) {
    await conn.auth.recover();
    res = await ask();
  }
  if (res.ok) return;
  if (res.status === 401) throw new ClientError(401, "not_logged_in", `${conn.label} didn't accept this machine's sign-in.`, `Sign in again: fontego login ${conn.label}`);
  throw new ClientError(
    res.status,
    "no_mcp",
    `${conn.label} doesn't answer MCP at ${url} (HTTP ${res.status}): its fontego-server is older than its MCP.`,
    "Ask its admin to update it.",
  );
}

/** The agents named (claude-code, codex…, or one name as it shows, "Claude Code"), or every one installed here. */
function chosenAgents(words: string | undefined): Agent[] {
  if (!words?.trim()) return AGENTS.filter((a) => installed(a));
  const whole = AGENTS.find((a) => a.name.toLowerCase() === words.trim().toLowerCase());
  if (whole) return [whole];
  const ids = words.split(/[\s,]+/).filter(Boolean);
  return ids.map((id) => {
    const a = AGENTS.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
    if (!a) throw new UsageError(`fontego doesn't know an agent "${id}". It knows: ${AGENTS.map((x) => x.id).join(", ")}.`);
    return a;
  });
}

/**
 * What is being set up, from the command line and the Fontego in use. Only adding writes the command that runs
 * fontego (finding it asks the one on the PATH whether it knows mcp); removing and looking match entries without it.
 */
function setupOf(rc: RunContext, url: string, adding: boolean): Setup {
  const name = typeof rc.parsed.flags.name === "string" ? rc.parsed.flags.name : "fontego";
  if (!NAME.test(name)) throw new UsageError(`--name takes letters, digits and dashes, 40 at most: "${name}".`);
  return { url, name, self: adding ? selfCommand() : ["fontego"], cwd: process.cwd(), env: process.env };
}

/** Each agent's place, once per file: a project's .mcp.json is both Claude Code's and Copilot's. */
function placesOf(agents: Agent[], scope: Scope, s: Setup): Array<{ place: Place; agents: Agent[] }> {
  const out: Array<{ place: Place; agents: Agent[] }> = [];
  for (const a of agents) {
    const place = placeFor(a, scope, s);
    const same = out.find((o) => o.place.path === place.path);
    if (same) same.agents.push(a);
    else out.push({ place, agents: [a] });
  }
  return out;
}

/** A path as a person reads it: under ~, or from this folder for a project. */
const shown = (path: string, scope: Scope) => {
  if (scope === "project") return relative(process.cwd(), path) || path;
  const home = homeOf();
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
};

const how = (r: Result) => (r.way === "header" ? "with your session, through fontego mcp header" : "with your session, through fontego mcp proxy");

function report(results: Result[], text: { title: string; after: string[]; empty: string }): string {
  if (!results.length) return text.empty;
  const w = Math.max(...results.map((r) => r.path.length)) + 2;
  const lines = results.flatMap((r) => {
    const status = r.status === "kept" ? `kept: ${r.reason}` : r.status;
    const head = `  ${r.path.padEnd(w)}${status} (${r.agents.join(", ")}${r.status === "written" || r.status === "unchanged" ? `, ${how(r)}` : ""})`;
    return r.snippet ? [head, "    By hand:", ...r.snippet.split("\n").map((l) => `      ${l}`)] : [head];
  });
  return [text.title, ...lines, ...(text.after.length ? ["", ...text.after] : [])].join("\n");
}

async function addOrRemove(rc: RunContext, removing: boolean) {
  const scope: Scope = rc.parsed.flags.project === true ? "project" : "user";
  const agents = chosenAgents(rc.parsed.args.AGENT);
  // Adding needs this machine's own sign-in, which renews by itself (FONTEGO_URL with a token is a script's); removing
  // is this machine's alone, so it works signed out too.
  const conn = removing ? null : await rc.connect();
  if (conn && !conn.instance) {
    throw new UsageError("fontego mcp connects your agents with this machine's session: sign in with fontego login URL (FONTEGO_URL and FONTEGO_TOKEN are for scripts). For a token, see https://docs.fontego.ai/guides/mcp/");
  }
  const url = conn ? conn.url : instanceUrlFor(rc);
  const printing = rc.parsed.flags.print === true;
  const s = setupOf(rc, url, !removing);
  if (conn && !printing) await checkMcp(conn);
  const results: Result[] = [];
  for (const { place, agents: theirs } of placesOf(agents, scope, s)) {
    const base = { path: shown(place.path, scope), agents: theirs.map((a) => a.name), scope, way: place.way };
    if (printing) {
      results.push({ ...base, status: "kept", reason: "printed, not written", snippet: place.snippet(s) });
      continue;
    }
    const done: { status: Status; reason?: string } = removing ? place.remove(s) : place.add(s);
    results.push({ ...base, ...done, ...(done.status === "kept" && !removing ? { snippet: place.snippet(s) } : {}) });
  }
  const missing = removing || rc.parsed.args.AGENT ? [] : AGENTS.filter((a) => !agents.includes(a)).map((a) => a.name);
  const data = { ok: true, action: removing ? "remove" : printing ? "print" : "add", url: mcpUrl(url), name: s.name, scope, results, ...(missing.length ? { missing } : {}) };
  rc.print(data, () => {
    if (printing) return report(results, { title: `Fontego's MCP at ${mcpUrl(url)}, to add by hand:`, after: [], empty: noAgents() });
    if (removing) {
      const touched = results.filter((r) => r.status !== "absent");
      return touched.length ? report(touched, { title: `Fontego's MCP (${s.name}):`, after: [], empty: "" }) : `${s.name} wasn't set up ${scope === "project" ? "in this folder" : "for any agent here"}.`;
    }
    const who = scope === "project" ? "for this folder: each person connects with their own sign-in (fontego login " + url + ")" : `as ${conn?.instance?.email ?? "you"}, with this machine's session`;
    return report(results, {
      title: `Fontego's MCP at ${mcpUrl(url)}, ${who}:`,
      after: [
        "Start a new session of each agent to load it.",
        ...(missing.length ? [`Not found here: ${missing.join(", ")}. If you install one later, run fontego mcp add again.`] : []),
        `Undo: fontego mcp remove${scope === "project" ? " --project" : ""}`,
      ],
      empty: noAgents(),
    });
  });
}

const noAgents = () =>
  [`No AI agent found on this machine (looked for ${AGENTS.map((a) => a.name).join(", ")}).`, "Name one (fontego mcp add claude-code), or see the entry to add by hand: fontego mcp add --print AGENT"].join("\n");

export const mcpCommands: Builtin[] = [
  {
    name: "mcp",
    summary: "Where Fontego's MCP is set up for the agents on this machine, for you and for this folder",
    group: GROUP,
    flags: [URL_FLAG, NAME_FLAG],
    async run(rc) {
      const url = instanceUrlFor(rc);
      const s = setupOf(rc, url, false);
      const here = AGENTS.filter((a) => installed(a));
      const rows = (["user", "project"] as const).flatMap((scope) =>
        placesOf(here, scope, s).map(({ place, agents }) => ({
          agents: agents.map((a) => a.name),
          scope,
          path: shown(place.path, scope),
          way: place.way,
          state: place.state(s),
        })),
      );
      const said: Record<string, string> = { ours: "set up", other: `another server named ${s.name}`, none: "not set up", unreadable: "can't be read" };
      rc.print({ url: mcpUrl(url), name: s.name, agents: here.map((a) => a.id), rows }, () => {
        if (!here.length) return noAgents();
        const table = formatTable(
          ["AGENT", "FOR", "WHERE", "STATE"],
          rows.map((r) => [r.agents.join(", "), r.scope === "user" ? "you" : "this folder", r.path, said[r.state]!]),
          { width: terminalWidth() },
        );
        return [`Fontego's MCP: ${mcpUrl(url)}`, table, "", "Set it up: fontego mcp add (for you), fontego mcp add --project (for everyone in this folder)"].join("\n");
      });
    },
  },
  {
    name: "mcp add",
    summary: "Connect the AI agents on this machine to Fontego's MCP, with this machine's session",
    group: GROUP,
    args: [{ name: "AGENT", optional: true, rest: true, description: "Only these (claude-code, codex, copilot, opencode, cursor, gemini); default: every one installed here" }],
    flags: [PROJECT_FLAG, NAME_FLAG, { name: "print", type: "boolean", description: "Print each agent's entry instead, to add it by hand" }],
    run: (rc) => addOrRemove(rc, false),
  },
  {
    name: "mcp remove",
    summary: "Take Fontego's MCP out of the agents on this machine (only what fontego mcp add wrote)",
    group: GROUP,
    args: [{ name: "AGENT", optional: true, rest: true, description: "Only these; default: every one" }],
    flags: [PROJECT_FLAG, NAME_FLAG, { ...URL_FLAG, description: "The Fontego whose entries go (default: the one in use; no need to be signed in)" }],
    run: (rc) => addOrRemove(rc, true),
  },
  {
    name: "mcp header",
    summary: "The HTTP headers for Fontego's MCP, as JSON, with this machine's session: for an agent's header helper",
    group: GROUP,
    flags: [URL_FLAG, AGENT_FLAG],
    async run(rc) {
      await againWithSessionBus();
      const conn = await connectionFor(rc);
      const agent = typeof rc.parsed.flags.agent === "string" ? rc.parsed.flags.agent : null;
      const headers = { Authorization: `Bearer ${await secretOf(conn, HEADER_FRESH_MS)}`, ...(agent ? { "fontego-agent": agent } : {}) };
      // Always JSON: that is what a header helper must print.
      process.stdout.write(`${JSON.stringify(headers)}\n`);
    },
  },
  {
    name: "mcp proxy",
    summary: "Fontego's MCP as a local MCP server over stdio, with this machine's session: for agents that can't run a header helper",
    group: GROUP,
    flags: [URL_FLAG, AGENT_FLAG],
    async run(rc) {
      await againWithSessionBus();
      const conn = await connectionFor(rc);
      const agent = typeof rc.parsed.flags.agent === "string" ? rc.parsed.flags.agent : null;
      await runProxy(
        { url: mcpUrl(conn.url), token: () => secretOf(conn), recover: conn.auth ? () => conn.auth!.recover() : undefined, agent },
        { lines: stdinLines(), write: (m) => process.stdout.write(`${JSON.stringify(m)}\n`), log: (t) => writeStderr(`${t}\n`) },
      );
    },
  },
];
