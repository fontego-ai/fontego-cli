import { existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { UsageError, type UsageArg } from "../args.ts";
import { ClientError } from "../client.ts";
import type { Connection } from "../connect.ts";
import { localStatus, SyncEngine, type SyncReport } from "../sync/engine.ts";
import { loadIgnoreRules, type IgnoreMatch } from "../sync/ignore.ts";
import { isConflictCopy, own, scan } from "../sync/local.ts";
import { findRoot, loadState, newState, saveState, statePath } from "../sync/state.ts";
import { acquireLock, Watcher } from "../sync/watch.ts";
import { EXIT, incomplete } from "../output.ts";
import type { Builtin, RunContext } from "./command.ts";

export function describeReport(r: SyncReport): string[] {
  const lines: string[] = [];
  for (const p of r.pulled) lines.push(`↓ ${p.status === "delete" ? "deleted " : ""}${p.path}`);
  for (const p of r.pushed) lines.push(`↑ ${p.status === "delete" ? "deleted " : ""}${p.path}${p.merged ? " (merged with other changes)" : ""}`);
  return lines.concat(describeSyncIssues(r));
}

function describeSyncIssues(r: SyncReport): string[] {
  const lines: string[] = [];
  for (const c of r.conflicts) lines.push(`! ${c.message}`);
  for (const s of r.skipped) lines.push(`skipped ${s.path}: ${s.reason}`);
  for (const p of r.invalid) lines.push(`skipped ${p}: this name can't be synced`);
  for (const u of r.unreadable) lines.push(`can't read ${u.path} (${u.reason}): left as it was, nothing in it sent or deleted`);
  if (r.readOnly && r.pending) lines.push(`${r.pending} local change(s) not sent: you can only read this workspace.`);
  else if (r.pending) lines.push(`${r.pending} local change(s) not sent yet: run fontego sync again to send them.`);
  return lines;
}

/** The synced folder a command works on. */
function rootOf(dirArg: string | undefined): string {
  const root = findRoot(dirArg ?? process.cwd());
  if (!root) throw new UsageError(`${dirArg ?? "This folder"} is not a synced workspace. Create one with: fontego clone WORKSPACE [DIR]`);
  return root;
}

/** The synced folder a command only reads, and its state. */
async function folder(dirArg: string | undefined) {
  const root = rootOf(dirArg);
  return { root, state: await loadState(root) };
}

/**
 * The synced folder a command changes, with its lock taken before its state is read (so no other fontego changes it
 * meanwhile), and a sync engine signed in to its instance. `release` gives the lock back.
 */
async function lockedFolder(rc: RunContext, dirArg: string | undefined, command: string) {
  const root = rootOf(dirArg);
  const release = await acquireLock(root, command);
  try {
    const state = await loadState(root);
    const conn = await rc.connect({ folderUrl: state.url });
    return { root, state, release, conn, client: conn.client, engine: new SyncEngine(root, conn.client, state) };
  } catch (e) {
    await release();
    throw e;
  }
}

/**
 * The first round of clone and link, under the folder's lock: checked again once the lock is held, so of two at once
 * the second finds the folder already synced instead of starting it over.
 */
async function firstSync({ client, url }: Connection, workspace: string, dir: string, command: string) {
  const [info, me] = await Promise.all([client.workspace(workspace), client.me()]);
  await mkdir(dir, { recursive: true });
  const release = await acquireLock(dir, command);
  try {
    if (existsSync(statePath(dir))) throw alreadySynced(dir, (await loadState(dir)).workspace);
    const state = newState(url, workspace, me.user.name || me.user.email.split("@")[0]!);
    await saveState(dir, state);
    const report = await new SyncEngine(dir, client, state).sync();
    return { role: info.role, report };
  } finally {
    await release();
  }
}

const alreadySynced = (root: string, workspace: string) =>
  new UsageError(`${root} is already synced with "${workspace}". If a link there stopped halfway, carry on with: fontego sync ${root}`);

const DIR = { name: "DIR", optional: true } as const;

/** "build/out.txt matches .fontegoignore:3 (build/)", for the rule that ignores a path. */
const ruleText = (m: IgnoreMatch) => `${m.source}${m.line ? `:${m.line}` : ""} (${m.pattern})${m.folder ? `, through the folder ${m.folder}/` : ""}`;
const FOLDERS = "Synced folders";

/** A workspace, picked from the ones you can see there when left out at a terminal */
const WORKSPACE: UsageArg = {
  name: "WORKSPACE",
  pick: {
    async load(connect) {
      const { workspaces } = await (await connect()).client.workspaces();
      return workspaces.map((w) => ({ value: w.slug, label: [w.name, w.role].filter(Boolean).join(" · ") }));
    },
  },
};

export const folderCommands: Builtin[] = [
  {
    name: "clone",
    summary: "Make DIR (default ./WORKSPACE) a synced copy of the workspace",
    group: FOLDERS,
    args: [WORKSPACE, DIR],
    async run({ parsed, print, connect: signIn }) {
      const conn = await signIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ws);
      if (existsSync(dir) && readdirSync(dir).length > 0) throw new UsageError(`${dir} is not empty. Clone into a new or empty folder.`);
      const { role, report } = await firstSync(conn, ws, dir, "fontego clone");
      if (incomplete(report)) process.exitCode = EXIT.partial;
      print({ dir, workspace: ws, role, complete: !incomplete(report), ...report }, () =>
        [`Cloned ${ws} into ${dir} (${report.pulled.length} file(s), you are ${role}).`, `Keep it in sync with: fontego watch ${dir}`].join("\n"),
      );
    },
  },
  {
    name: "link",
    summary: "Connect a folder that already has files (default: this one) and send them up",
    group: FOLDERS,
    args: [WORKSPACE, DIR],
    async run({ parsed, print, connect: signIn }) {
      const conn = await signIn();
      const ws = parsed.args.WORKSPACE!;
      const dir = resolve(parsed.args.DIR ?? ".");
      if (!existsSync(dir)) throw new UsageError(`${dir} doesn't exist.`);
      const existing = findRoot(dir);
      if (existing) throw alreadySynced(existing, (await loadState(existing)).workspace);
      const { role, report } = await firstSync(conn, ws, dir, "fontego link");
      if (incomplete(report)) process.exitCode = EXIT.partial;
      print({ dir, workspace: ws, role, complete: !incomplete(report), ...report }, () =>
        [
          `Linked ${dir} to ${ws}: ${report.pushed.length} file(s) sent, ${report.pulled.length} received.`,
          ...describeSyncIssues(report),
          `Keep it in sync with: fontego watch ${dir}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "status",
    summary: "What changed here since the last sync, and what the ignore rules keep here (works offline)",
    group: FOLDERS,
    args: [DIR],
    flags: [{ name: "ignored", type: "boolean", description: "List what the ignore rules keep here (--json always does)" }],
    async run(rc) {
      const { root, state } = await folder(rc.parsed.args.DIR);
      const st = await localStatus(root, state);
      // A file in the workspace that the rules match keeps syncing; say so, and how to take it out.
      const trackedIgnored = st.trackedIgnored.map((t) => ({ ...t, hash: own(state.files, t.path)?.hash ?? null }));
      rc.print({ root, workspace: state.workspace, head: state.head, ...st, trackedIgnored }, () => {
        const lines = [
          ...st.added.map((p) => `new       ${p}`),
          ...st.modified.map((p) => `modified  ${p}`),
          ...st.deleted.map((p) => `deleted   ${p}`),
          ...st.unreadable.map((u) => `unreadable ${u.path} (${u.reason}): left as it was, nothing in it counts as deleted`),
          ...Object.entries(st.skipped).map(
            ([p, s]) => `skipped   ${p}: ${s.reason}${s.retryAt ? ` (sent again after ${new Date(s.retryAt).toLocaleString()}, or once it changes)` : ""}`,
          ),
          ...(rc.parsed.flags.ignored ? st.ignored.map((p) => `ignored   ${p}`) : []),
        ];
        const notes = trackedIgnored.map(
          (t) =>
            `note: ${t.path} matches ${ruleText(t)} but is in the workspace, so it keeps syncing. To take it out of the workspace (the copy here stays): fontego rm ${state.workspace} ${t.path} --base ${t.hash}`,
        );
        const rulesNotRead = st.rulesNotRead.map((p) => `note: ${p.source}: ${p.reason}.`);
        const ignored =
          st.ignored.length && !rc.parsed.flags.ignored
            ? [`${st.ignored.length} ignored here (fontego status --ignored lists them; fontego check-ignore PATH says why).`]
            : [];
        return [`${state.workspace} in ${root}`, lines.length ? lines.join("\n") : "Nothing to send.", ...notes, ...rulesNotRead, ...ignored].join("\n");
      });
    },
  },
  {
    name: "check-ignore",
    summary: "Which ignore rule keeps a path from syncing, if any, like git check-ignore -v (works offline)",
    group: FOLDERS,
    args: [{ name: "PATH", description: "A file or folder inside a synced folder" }],
    async run(rc) {
      const given = rc.parsed.args.PATH!;
      const abs = resolve(given);
      const root = findRoot(dirname(abs));
      if (!root) throw new UsageError(`${given} is not inside a synced workspace.`);
      const rel = relative(root, abs).split(sep).join("/");
      if (!rel || rel.startsWith("..")) throw new UsageError(`Give a path inside ${root}.`);
      let isDir = given.endsWith("/");
      try {
        isDir ||= lstatSync(abs).isDirectory();
      } catch {
        // it doesn't exist (yet): check it as a file, or a folder with a trailing /
      }
      const state = await loadState(root);
      const rules = await loadIgnoreRules(root);
      await rules.prepare(rel);
      const m = rules.match(rel, isDir);
      const tracked = !!own(state.files, rel.normalize("NFC"));
      rc.print({ path: rel, folder: isDir, ...m, tracked }, () => {
        if (!m.ignored) return `${rel} is not ignored.`;
        const why = `${m.source}${m.line ? `:${m.line}` : ""}:${m.pattern}\t${rel}${m.folder ? `  (through the folder ${m.folder}/)` : ""}`;
        return tracked ? `${why}\n${rel} is in the workspace, though, so it keeps syncing. To take it out: fontego rm.` : why;
      });
      // As git check-ignore: 1 when the path isn't ignored.
      if (!m.ignored) process.exitCode = 1;
    },
  },
  {
    name: "sync",
    summary: "Sync once: bring down, send up",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, engine, release } = await lockedFolder(rc, rc.parsed.args.DIR, "fontego sync");
      try {
        const r = await engine.sync();
        rc.print({ root, complete: !incomplete(r), ...r }, () => describeReport(r).join("\n") || "Up to date.");
        if (incomplete(r)) process.exitCode = EXIT.partial;
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
      const { root, state, engine, client, conn, release } = await lockedFolder(rc, rc.parsed.args.DIR, "fontego watch");
      const log = (line: string) =>
        rc.json ? console.log(JSON.stringify({ at: new Date().toISOString(), message: line })) : console.log(`${new Date().toLocaleTimeString()}  ${line}`);
      let lastError = "";
      const watcher = new Watcher(engine, client, {
        onReport: (r) => {
          if (lastError) log("carrying on");
          lastError = "";
          if (rc.json && (r.pulled.length || r.pushed.length || r.conflicts.length || r.skipped.length)) {
            console.log(JSON.stringify({ at: new Date().toISOString(), report: r }));
          } else if (!rc.json) for (const l of describeReport(r)) log(l);
        },
        onError: (e) => {
          // Signed out (the session ended, or the token was refused): wait, and say so once.
          const line =
            e instanceof ClientError && e.status === 401
              ? `paused: ${e.message} Sign in again (fontego login ${conn.label}) and it carries on by itself.`
              : `sync failed: ${e.message}`;
          if (line !== lastError) log(line);
          lastError = line;
        },
        onEvent: log,
      });
      const stop = async () => {
        await watcher.stop();
        await release();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      log(`watching ${root} (${state.workspace} on ${conn.label}); Ctrl+C to stop`);
      await watcher.start();
    },
  },
  {
    name: "conflicts",
    summary: "Conflict copies waiting to be merged by hand (works offline)",
    group: FOLDERS,
    args: [DIR],
    async run(rc) {
      const { root, state } = await folder(rc.parsed.args.DIR);
      const scanned = await scan(root, await loadIgnoreRules(root), state.files);
      const copies = [...scanned.files.keys()].filter(isConflictCopy).sort();
      rc.print({ root, conflicts: copies }, () => (copies.length ? copies.join("\n") : "No conflict copies."));
    },
  },
];
