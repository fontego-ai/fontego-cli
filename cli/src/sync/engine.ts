// One sync round: bring down what changed on the server, send up what changed here, and never lose an edit.
//
//   pull  — files that changed only on the server are written here
//   push  — files that changed here go up as one change set, each with the hash it started from; the server merges
//           text changed on both sides
//   pull  — again, to pick up our own commit and anything that landed meanwhile
//
// A real conflict keeps both: the server's version stays in place and ours is saved next to it as a conflict copy.

import { textContent, type ChangeOp, type Conflict, type FileMode } from "@fontego/core";
import { hostname } from "node:os";
import { Client, ClientError } from "../client.ts";
import { loadIgnoreRules } from "./ignore.ts";
import {
  conflictName,
  insideUnreadable,
  readBytes,
  readEntry,
  insideRoot,
  removeLocal,
  UnsafePathError,
  scan,
  writeLocal,
  type LocalEntry,
  type Unreadable,
} from "./local.ts";
import { saveState, type SyncState } from "./state.ts";

export interface SyncReport {
  head: string | null;
  pulled: Array<{ path: string; status: "put" | "delete" }>;
  pushed: Array<{ path: string; status: "put" | "delete"; merged?: boolean }>;
  conflicts: Array<{ path: string; reason: Conflict["reason"]; copy?: string; message: string }>;
  skipped: Array<{ path: string; reason: string }>;
  invalid: string[];
  /**
   * Folders and files here that couldn't be read. Nothing under them is sent or deleted, and the server's changes to
   * them wait: the copy stays at its last full step (state.head) until they can be read again.
   */
  unreadable: Unreadable[];
  /** Local changes that couldn't go up (read-only access) */
  pending: number;
  readOnly: boolean;
}

const same = (a: LocalEntry | undefined, b: LocalEntry | undefined) =>
  a === b || (!!a && !!b && a.hash === b.hash && a.mode === b.mode);

function emptyReport(): SyncReport {
  return { head: null, pulled: [], pushed: [], conflicts: [], skipped: [], invalid: [], unreadable: [], pending: 0, readOnly: false };
}

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private again = false;

  constructor(
    readonly root: string,
    private readonly client: Client,
    readonly state: SyncState,
  ) {}

  /** Runs a round; if one is already running, runs one more right after it. */
  sync(): Promise<SyncReport> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let report: SyncReport;
        do {
          this.again = false;
          report = await this.round();
        } while (this.again);
        return report;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async round(): Promise<SyncReport> {
    const report = emptyReport();
    await this.pull(report);
    for (let attempt = 0; attempt < 5; attempt++) {
      const outcome = await this.push(report);
      if (outcome !== "retry") break;
    }
    if (report.pushed.length) await this.pull(report);
    report.head = this.state.head;
    report.readOnly = !!this.state.readOnly;
    await saveState(this.root, this.state);
    return report;
  }

  private async download(path: string, rev: string): Promise<{ bytes: Uint8Array; mode: string; hash: string }> {
    const f = await this.client.file(this.state.workspace, path, rev);
    return { bytes: f.bytes, mode: f.mode, hash: f.hash };
  }

  /** Writes the server's version of a file here, unless the local file changed since we looked at it. */
  private async writeIfUnchanged(path: string, expected: LocalEntry | undefined, rev: string): Promise<boolean> {
    const now = await readEntry(this.root, path, expected);
    if (!same(now ?? undefined, expected)) return false;
    const f = await this.download(path, rev);
    this.state.files[path] = await writeLocal(this.root, path, f.bytes, f.mode);
    return true;
  }

  private async pull(report: SyncReport) {
    const res = await this.client.sync(this.state.workspace, this.state.head);
    if (!res.head) {
      this.state.head = null;
      return;
    }
    if (!res.reset && res.head === this.state.head) return;

    const rules = await loadIgnoreRules(this.root);
    const scanned = await scan(this.root, rules, this.state.files);
    const local = scanned.files;
    report.unreadable = scanned.unreadable;
    const remote = new Map<string, { hash: string; mode: string } | null>();
    for (const c of res.changes) remote.set(c.path, c.status === "put" ? { hash: c.hash!, mode: c.mode ?? "100644" } : null);
    if (res.reset) {
      // The server doesn't know our base: whatever we track and it doesn't list is gone there.
      for (const path of Object.keys(this.state.files)) if (!remote.has(path)) remote.set(path, null);
    }

    let waiting = false;
    for (const [path, r] of remote) {
      if (insideUnreadable(scanned.unreadable, path)) {
        // Can't see what is here: leave it, keep its base, and don't step past this change (below).
        waiting = true;
        continue;
      }
      try {
        await this.pullOne(report, path, r, local, rules, res.head);
      } catch (e) {
        // A path that would land outside this folder is left alone; the rest goes on.
        if (!(e instanceof UnsafePathError)) throw e;
        report.skipped.push({ path, reason: e.message });
        delete this.state.files[path];
      }
    }
    // A change that had to wait keeps the copy at its last full step, so the server sends it again next round. What
    // was applied meanwhile is in state.files, and comes again as "already identical". (The server only checks that a
    // change set's baseCommit exists; each file merges from its own baseHash.)
    if (!waiting) this.state.head = res.head;
  }

  private async pullOne(
    report: SyncReport,
    path: string,
    r: { hash: string; mode: string } | null,
    local: Map<string, LocalEntry>,
    rules: Awaited<ReturnType<typeof loadIgnoreRules>>,
    head: string,
  ) {
    await insideRoot(this.root, path);
    const s = this.state.files[path];
    const l = local.get(path);
    const changedHere = !same(l, s);
    if (!r) {
      if (!changedHere && l) {
        // Gone from the workspace. A file the rules here ignore stays, as one of this copy's own; any other goes.
        await rules.prepare(path);
        if (!rules.match(path, false).ignored) {
          await removeLocal(this.root, path);
          report.pulled.push({ path, status: "delete" });
        }
      }
      // Deleted there: forget it. If it was edited here, the push step sends it back as a new file.
      delete this.state.files[path];
      return;
    }
    if (l && l.hash === r.hash && l.mode === r.mode) {
      this.state.files[path] = l; // already identical
      return;
    }
    if (!changedHere) {
      if (await this.writeIfUnchanged(path, l, head)) report.pulled.push({ path, status: "put" });
    }
    // else: changed on both sides; push sends ours with its original base and the server merges
  }

  private async push(report: SyncReport): Promise<"done" | "retry"> {
    const scanned = await scan(this.root, await loadIgnoreRules(this.root), this.state.files);
    report.invalid = scanned.invalid;
    report.unreadable = scanned.unreadable;
    const local = scanned.files;

    const ops: ChangeOp[] = [];
    const paths = new Set([...local.keys(), ...Object.keys(this.state.files)]);
    for (const path of [...paths].sort()) {
      if (insideUnreadable(scanned.unreadable, path)) continue; // unknown here: neither sent nor deleted
      const l = local.get(path);
      const s = this.state.files[path];
      if (same(l, s)) continue;
      const skip = this.state.skipped[path];
      if (skip && skip.hash === (l?.hash ?? "deleted")) continue;
      if (l) {
        const bytes = await readBytes(this.root, path, l.mode);
        const op: ChangeOp = { op: "put", path, baseHash: s?.hash ?? null, mode: l.mode as FileMode };
        const text = textContent(bytes);
        if (text === null) op.contentBase64 = Buffer.from(bytes).toString("base64");
        else op.content = text;
        ops.push(op);
      } else if (s) {
        ops.push({ op: "delete", path, baseHash: s.hash });
      }
    }
    if (ops.length === 0) return "done";
    if (this.state.readOnly) {
      report.pending = ops.length;
      return "done";
    }

    const names = ops.map((o) => (o.op === "move" ? o.to : o.path));
    const message = `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} (from ${hostname()})`;
    let result;
    try {
      result = await this.client.change(this.state.workspace, { baseCommit: this.state.head, message, ops, client: "fontego" });
    } catch (e) {
      if (!(e instanceof ClientError)) throw e;
      if (e.status === 403) {
        this.state.readOnly = true;
        report.pending = ops.length;
        return "done";
      }
      if (e.code === "unknown_base") {
        this.state.head = null;
        await this.pull(report);
        return "retry";
      }
      if (e.status === 422) {
        // The server won't take one file (too big, a secret, a path only admins write...): set it aside, send the
        // rest, and try it again once it changes here. A refused delete is set aside too: the file stays there.
        const path = (e.details as { path?: string } | undefined)?.path;
        if (!path || !ops.some((o) => o.op !== "move" && o.path === path)) throw e;
        this.state.skipped[path] = { hash: local.get(path)?.hash ?? "deleted", reason: e.message };
        report.skipped.push({ path, reason: e.message });
        return "retry";
      }
      if (e.code === "conflict") {
        const details = e.details as { head: string | null; conflicts: Conflict[] };
        const rev = details.head ?? undefined;
        for (const c of details.conflicts) {
          const op = ops.find((o) => (o.op === "move" ? o.to === c.path || o.from === c.path : o.path === c.path));
          const l = local.get(c.path);
          if (op?.op === "put" && c.reason === "missing") {
            // Deleted on the server, edited here: keep the edit as a new file.
            delete this.state.files[c.path];
            report.conflicts.push({ path: c.path, reason: c.reason, message: `${c.path} was deleted on the server; your edited copy is kept.` });
            continue;
          }
          if (op?.op === "put" && l && c.currentHash && rev) {
            const copy = conflictName(c.path, this.state.user);
            const bytes = await readBytes(this.root, c.path, l.mode);
            await writeLocal(this.root, copy, bytes, l.mode);
            const f = await this.download(c.path, rev);
            this.state.files[c.path] = await writeLocal(this.root, c.path, f.bytes, f.mode);
            report.conflicts.push({ path: c.path, reason: c.reason, copy, message: `${c.message} Your version is in "${copy}".` });
            continue;
          }
          if (op?.op === "delete" && c.currentHash && rev) {
            const f = await this.download(c.path, rev);
            this.state.files[c.path] = await writeLocal(this.root, c.path, f.bytes, f.mode);
            report.conflicts.push({ path: c.path, reason: c.reason, message: `${c.path} changed on the server, so it was not deleted; it's back with the new version.` });
            continue;
          }
          // Can't be resolved by keeping both (e.g. a file where a folder is): leave it out until it changes.
          this.state.skipped[c.path] = { hash: l?.hash ?? "deleted", reason: c.message };
          report.conflicts.push({ path: c.path, reason: c.reason, message: c.message });
        }
        return "retry";
      }
      throw e;
    }

    const byPath = new Map(result.changes.map((c) => [c.path, c]));
    for (const op of ops) {
      if (op.op === "move") continue;
      const path = op.path;
      const change = byPath.get(path);
      const l = local.get(path);
      if (op.op === "delete") {
        delete this.state.files[path];
        if (change) report.pushed.push({ path, status: "delete" });
        continue;
      }
      if (!l) continue;
      if (change?.merged && result.commit) {
        // The server merged our edit with someone else's: bring the merged text here.
        // If it changed again meanwhile, keep the original base: the next round merges once more.
        await this.writeIfUnchanged(path, l, result.commit);
        report.pushed.push({ path, status: "put", merged: true });
        continue;
      }
      this.state.files[path] = l;
      delete this.state.skipped[path];
      if (change) report.pushed.push({ path, status: "put" });
    }
    return "done";
  }
}

/** Local changes compared with the last sync, without talking to the server. */
export async function localStatus(root: string, state: SyncState) {
  const scanned = await scan(root, await loadIgnoreRules(root), state.files);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, l] of scanned.files) {
    const s = state.files[path];
    if (!s) added.push(path);
    else if (!same(l, s)) modified.push(path);
  }
  for (const path of Object.keys(state.files)) {
    if (!scanned.files.has(path) && !insideUnreadable(scanned.unreadable, path)) deleted.push(path);
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    invalid: scanned.invalid,
    /** Folders and files that couldn't be read: nothing under them counts as deleted */
    unreadable: scanned.unreadable,
    skipped: state.skipped,
    /** New files and folders the ignore rules keep here */
    ignored: scanned.ignored,
    /** Files in the workspace that the rules match: they keep syncing */
    trackedIgnored: scanned.trackedIgnored,
  };
}
