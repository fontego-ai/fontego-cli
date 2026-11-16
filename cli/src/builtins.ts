// Commands written in the CLI itself: the ones that work with this machine or with a synced folder. Everything else
// comes from the server (declared.ts).

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Parsed, Usage } from "./args.ts";
import { UsageError } from "./args.ts";
import { Client, ClientError } from "./client.ts";
import { clearCliConfig, configPath, loadCliConfig, saveCliConfig, type CliConfig } from "./config.ts";
import { forgetCommands, readCommands, refreshCommands, type CachedCommands } from "./declared.ts";
import { agentHelp, commandHelp, generalHelp } from "./help.ts";
import { localStatus, SyncEngine, type SyncReport } from "./sync/engine.ts";
import { isConflictCopy, loadIgnore, scan } from "./sync/local.ts";
import { findRoot, loadState, newState, saveState } from "./sync/state.ts";
import { acquireLock, Watcher } from "./sync/watch.ts";

export const VERSION = "0.1.0";

export interface RunContext {
  parsed: Parsed;
  json: boolean;
  print: (data: unknown, text: () => string) => void;
  /** The signed-in client; fails with "not logged in" if there is no login */
  client: () => { client: Client; config: CliConfig };
}

export interface Builtin extends Usage {
  run(rc: RunContext): Promise<void>;
}

export const notLoggedIn = () =>
  new ClientError(401, "not_logged_in", "You are not logged in.", "Run: fontego login URL --token TOKEN (or set FONTEGO_URL and FONTEGO_TOKEN).");

/** The saved commands of the signed-in server, refreshed if possible (quickly: help must not hang). */
async function commandsForHelp(): Promise<{ cache: CachedCommands | null; stale: boolean }> {
  const cfg = loadCliConfig();
  if (!cfg) return { cache: null, stale: false };
  try {
    return { cache: await refreshCommands(new Client(cfg.url, cfg.token), 3000), stale: false };
  } catch {
    return { cache: readCommands(cfg.url), stale: true };
  }
}

export function describeReport(r: SyncReport): string[] {
  const lines: string[] = [];
  for (const p of r.pulled) lines.push(`↓ ${p.status === "delete" ? "deleted " : ""}${p.path}`);
  for (const p of r.pushed) lines.push(`↑ ${p.status === "delete" ? "deleted " : ""}${p.path}${p.merged ? " (merged with other changes)" : ""}`);
  for (const c of r.conflicts) lines.push(`! ${c.message}`);
  for (const s of r.skipped) lines.push(`skipped ${s.path}: ${s.reason}`);
  for (const p of r.invalid) lines.push(`skipped ${p}: this name can't be synced`);
  if (r.readOnly && r.pending) lines.push(`${r.pending} local change(s) not sent: you can only read this workspace.`);
  return lines;
}

/** The synced folder a command works on, and a client for its server. */
async function folder(rc: RunContext, dirArg: string | undefined) {
  const root = findRoot(dirArg ?? process.cwd());
  if (!root) throw new UsageError(`${dirArg ?? "This folder"} is not a synced workspace. Create one with: fontego clone WORKSPACE [DIR]`);
  const state = await loadState(root);
  const online = () => {
    const { client, config } = rc.client();
    if (config.url.replace(/\/+$/, "") !== state.url.replace(/\/+$/, "")) {
      throw new UsageError(`This folder belongs to ${state.url}, but you are logged in to ${config.url}.`);
    }
    return { engine: new SyncEngine(root, client, state), client };
  };
  return { root, state, online };
}

const DIR = { name: "DIR", optional: true } as const;
const MACHINE = "This machine";
const FOLDERS = "Synced folders";

export const BUILTINS: Builtin[] = [
  {
    name: "login",
    summary: "Save the server and your token (verifies them first)",
    group: MACHINE,
    args: [{ name: "URL" }],
    flags: [{ name: "token", type: "string", value: "TOKEN", description: "Your token (or set FONTEGO_TOKEN)" }],
    async run({ parsed, print }) {
      const url = parsed.args.URL!;
      const token = (parsed.flags.token as string | undefined) ?? process.env.FONTEGO_TOKEN;
      if (!token) throw new UsageError("fontego login URL --token TOKEN");
      const client = new Client(url, token);
      const me = await client.me();
      saveCliConfig({ url, token });
      await refreshCommands(client).catch(() => {});
      print({ ok: true, url, user: me.user, config: configPath() }, () => `Logged in to ${url} as ${me.user.email}.`);
    },
  },
  {
    name: "logout",
    summary: "Forget the saved login",
    group: MACHINE,
    async run({ print }) {
      const cfg = loadCliConfig();
      if (cfg) forgetCommands(cfg.url);
      clearCliConfig();
      print({ ok: true }, () => "Logged out.");
    },
  },
  {
    name: "open",
    summary: "Open the web app, already signed in",
    group: MACHINE,
    args: [{ name: "WORKSPACE", optional: true }],
    flags: [{ name: "print", type: "boolean", description: "Only show the link (it works once, for two minutes)" }],
    async run({ parsed, json, print, client: signedIn }) {
      const { client } = signedIn();
      const ws = parsed.args.WORKSPACE;
      if (ws) await client.workspace(ws); // fails early if it doesn't exist for you
      const link = await client.sessionCode();
      const url = ws ? `${link.url}&next=${encodeURIComponent(`/w/${ws}`)}` : link.url;
      if (parsed.flags.print === true || json) return print({ url, expiresAt: link.expiresAt }, () => url);
      const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
      try {
        Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" }).unref();
        console.log("Opening the web app in your browser (the link works once, for two minutes).");
      } catch {
        console.log(`Open this link in your browser (works once, for two minutes):\n${url}`);
      }
    },
  },
  {
    name: "help",
    summary: "This help; with a command, its details; --agent: how to use fontego, for an AI agent",
    group: MACHINE,
    args: [{ name: "COMMAND", optional: true, rest: true }],
    flags: [{ name: "agent", type: "boolean", description: "Markdown for an AI agent" }],
    async run({ parsed }) {
      const { cache, stale } = await commandsForHelp();
      if (parsed.flags.agent === true) return console.log(agentHelp(BUILTINS, cache, stale));
      if (parsed.args.COMMAND) return console.log(commandHelp(parsed.args.COMMAND.split(" "), BUILTINS, cache));
      console.log(generalHelp(BUILTINS, cache, stale, VERSION));
    },
  },
  {
    name: "version",
    summary: "The version of this CLI",
    group: MACHINE,
    async run() {
      console.log(VERSION);
    },
  },

  {
    name: "clone",
    summary: "Make DIR (default ./WORKSPACE) a synced copy of the workspace",
    group: FOLDERS,
    args: [{ name: "WORKSPACE" }, DIR],
    async run({ parsed, print, client: signedIn }) {
      const { client, config } = signedIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ws);
      if (existsSync(dir) && readdirSync(dir).length > 0) throw new UsageError(`${dir} is not empty. Clone into a new or empty folder.`);
      const [info, me] = await Promise.all([client.workspace(ws), client.me()]);
      const state = newState(config.url, ws, me.user.name || me.user.email.split("@")[0]!);
      await saveState(dir, state);
      const report = await new SyncEngine(dir, client, state).sync();
      print({ dir, workspace: ws, role: info.role, ...report }, () =>
        [`Cloned ${ws} into ${dir} (${report.pulled.length} file(s), you are ${info.role}).`, `Keep it in sync with: fontego watch ${dir}`].join("\n"),
      );
    },
  },
  {
    name: "link",
    summary: "Connect a folder that already has files (default: this one) and send them up",
    group: FOLDERS,
    args: [{ name: "WORKSPACE" }, DIR],
    async run({ parsed, print, client: signedIn }) {
      const { client, config } = signedIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ".");
      if (!existsSync(dir)) throw new UsageError(`${dir} doesn't exist.`);
      const existing = findRoot(dir);
      if (existing) throw new UsageError(`${existing} is already synced with "${(await loadState(existing)).workspace}".`);
      const [info, me] = await Promise.all([client.workspace(ws), client.me()]);
      const state = newState(config.url, ws, me.user.name || me.user.email.split("@")[0]!);
      await saveState(dir, state);
      const report = await new SyncEngine(dir, client, state).sync();
      print({ dir, workspace: ws, role: info.role, ...report }, () =>
        [
          `Linked ${dir} to ${ws}: ${report.pushed.length} file(s) sent, ${report.pulled.length} received.`,
          ...describeReport(report).filter((l) => !l.startsWith("↑") && !l.startsWith("↓")),
          `Keep it in sync with: fontego watch ${dir}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "status",
    summary: "What changed here since the last sync (works offline)",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state } = await folder(rc, rc.parsed.args.DIR);
      const st = await localStatus(root, state);
      rc.print({ root, workspace: state.workspace, head: state.head, ...st }, () => {
        const lines = [
          ...st.added.map((p) => `new       ${p}`),
          ...st.modified.map((p) => `modified  ${p}`),
          ...st.deleted.map((p) => `deleted   ${p}`),
          ...Object.entries(st.skipped).map(([p, s]) => `skipped   ${p}: ${s.reason}`),
        ];
        return `${state.workspace} in ${root}\n${lines.length ? lines.join("\n") : "Nothing to send."}`;
      });
    },
  },
  {
    name: "sync",
    summary: "Sync once: bring down, send up",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, online } = await folder(rc, rc.parsed.args.DIR);
      const { engine } = online();
      const release = await acquireLock(root);
      try {
        const r = await engine.sync();
        rc.print({ root, ...r }, () => describeReport(r).join("\n") || "Up to date.");
      } finally {
        await release();
      }
    },
  },
  {
    name: "watch",
    summary: "Keep syncing: seconds after you edit, and when others commit; waits while offline",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state, online } = await folder(rc, rc.parsed.args.DIR);
      const { engine, client } = online();
      const release = await acquireLock(root);
      const log = (line: string) =>
        rc.json ? console.log(JSON.stringify({ at: new Date().toISOString(), message: line })) : console.log(`${new Date().toLocaleTimeString()}  ${line}`);
      const watcher = new Watcher(engine, client, {
        onReport: (r) => {
          if (rc.json && (r.pulled.length || r.pushed.length || r.conflicts.length || r.skipped.length)) {
            console.log(JSON.stringify({ at: new Date().toISOString(), report: r }));
          } else if (!rc.json) for (const l of describeReport(r)) log(l);
        },
        onError: (e) => log(`sync failed: ${e.message}`),
        onEvent: log,
      });
      const stop = async () => {
        await watcher.stop();
        await release();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      log(`watching ${root} (${state.workspace} on ${state.url}); Ctrl+C to stop`);
      await watcher.start();
    },
  },
  {
    name: "conflicts",
    summary: "Conflict copies waiting to be merged by hand (works offline)",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state } = await folder(rc, rc.parsed.args.DIR);
      const scanned = await scan(root, await loadIgnore(root), state.files);
      const copies = [...scanned.files.keys()].filter(isConflictCopy).sort();
      rc.print({ root, conflicts: copies }, () => (copies.length ? copies.join("\n") : "No conflict copies."));
    },
  },
];

export const BUILTIN_NAMES = BUILTINS.map((b) => b.name);
