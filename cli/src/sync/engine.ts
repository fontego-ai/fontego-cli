// One sync round: bring down what changed on the server, send up what changed here, and never lose an edit.
//
//   pull  — files that changed only on the server are written here
//   push  — files that changed here go up as one change set, each with the hash it started from; the server merges
//           text changed on both sides
//   pull  — again, to pick up our own commit and anything that landed meanwhile
//
// A real conflict keeps both: the server's version stays in place and ours is saved next to it as a conflict copy.

import { blobHash, MAX_OPS, textContent, type ChangeOp, type Conflict, type FileMode } from "@fontego/core";
import { hostname } from "node:os";
import { Client, ClientError } from "../client.ts";
import { loadIgnoreRules } from "./ignore.ts";
import {
  absent,
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
  /**
   * Local changes not sent in this round: with read-only access (readOnly), or because the round gave up (the server
   * kept refusing without saying which file). The next round tries them again.
   */
  pending: number;
  readOnly: boolean;
}

const same = (a: LocalEntry | undefined, b: LocalEntry | undefined) =>
  a === b || (!!a && !!b && a.hash === b.hash && a.mode === b.mode);

/**
 * At most this much JSON per change set: well under the smallest body a server takes (64 MiB). A file bigger than this
 * goes on its own, which always fits: a server takes a body of twice its largest file.
 */
export const BATCH_BYTES = 32 * 1024 * 1024;

/** One local change waiting to go up; its bytes are read only when its batch is made. */
interface Outgoing {
  path: string;
  /** The file here (none: deleted here) */
  local?: LocalEntry;
  /** The file at the last sync, its base */
  base?: LocalEntry;
}

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
    private readonly batchBytes = BATCH_BYTES,
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
    // A refused file (the server names one per answer), a conflict or a stale base sends the round back to scan and
    // try again. It goes on as long as each try gets somewhere, so five refusals in a row don't keep a sixth, valid,
    // file waiting; five tries in a row without progress end it, and what is left shows in `pending`.
    const progress = () => report.pushed.length + report.skipped.length + report.conflicts.length;
    for (let idle = 0, tries = 0; idle < 5 && tries < 10_000; tries++) {
      const before = progress();
      if ((await this.push(report)) !== "retry") break;
      idle = progress() > before ? 0 : idle + 1;
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

  /**
   * Sends what changed here, in batches the server takes: at most MAX_OPS operations and BATCH_BYTES of JSON each,
   * reading the files of one batch at a time. What each batch commits is saved in the state at once, so an interrupted
   * round (a link of thousands of files, a lost connection) goes on from there with the next `fontego sync`.
   */
  private async push(report: SyncReport): Promise<"done" | "retry"> {
    const scanned = await scan(this.root, await loadIgnoreRules(this.root), this.state.files);
    report.invalid = scanned.invalid;
    report.unreadable = scanned.unreadable;
    const local = scanned.files;

    const todo: Outgoing[] = [];
    const paths = new Set([...local.keys(), ...Object.keys(this.state.files)]);
    for (const path of [...paths].sort()) {
      if (insideUnreadable(scanned.unreadable, path)) continue; // unknown here: neither sent nor deleted
      const l = local.get(path);
      const s = this.state.files[path];
      if (same(l, s)) continue;
      const skip = this.state.skipped[path];
      if (skip && skip.hash === (l?.hash ?? "deleted")) continue;
      if (l || s) todo.push({ path, local: l, base: s });
    }
    report.pending = todo.length;
    if (todo.length === 0 || this.state.readOnly) return "done";

    type Ready = { item: Outgoing; op: ChangeOp; size: number };
    let carry: Ready | null = null;
    for (let i = 0; i < todo.length || carry; ) {
      const batch: Array<{ item: Outgoing; op: ChangeOp }> = [];
      let bytes = 0;
      while (batch.length < MAX_OPS) {
        let next: Ready | null = carry;
        carry = null;
        if (!next) {
          if (i >= todo.length) break;
          const item = todo[i++]!;
          const op = await this.opFor(item);
          if (!op) continue; // gone since the scan: the next round sees it
          next = { item, op, size: Buffer.byteLength(JSON.stringify(op)) };
        }
        if (batch.length && bytes + next.size > this.batchBytes) {
          carry = next;
          break;
        }
        batch.push(next);
        bytes += next.size;
      }
      if (!batch.length) break;
      const outcome = await this.send(report, batch, local);
      if (outcome !== "sent") return outcome;
      report.pending = todo.length - i + (carry ? 1 : 0);
      // What the server confirmed stays confirmed, even if a later batch fails or the process is stopped.
      await saveState(this.root, this.state);
    }
    report.pending = 0;
    return "done";
  }

  /** The operation for one local change, with the bytes read now; null if the file is gone since the scan. */
  private async opFor(item: Outgoing): Promise<ChangeOp | null> {
    const { path, local: l, base: s } = item;
    if (!l) return { op: "delete", path, baseHash: s!.hash };
    let bytes: Uint8Array;
    try {
      bytes = await readBytes(this.root, path, l.mode);
    } catch (e) {
      if (absent(e)) return null;
      throw e;
    }
    // Edited between the scan and now: what goes up is what was read, so that is what the state must remember.
    const hash = blobHash(bytes);
    if (hash !== l.hash) item.local = { ...l, hash, size: bytes.length, mtimeMs: -1 };
    const op: ChangeOp = { op: "put", path, baseHash: s?.hash ?? null, mode: l.mode as FileMode };
    const text = textContent(bytes);
    if (text === null) op.contentBase64 = Buffer.from(bytes).toString("base64");
    else op.content = text;
    return op;
  }

  /** Sends one batch as a change set and takes in the answer. */
  private async send(
    report: SyncReport,
    batch: Array<{ item: Outgoing; op: ChangeOp }>,
    local: Map<string, LocalEntry>,
  ): Promise<"sent" | "retry" | "done"> {
    const ops = batch.map((b) => b.op);
    const names = ops.map((o) => (o.op === "move" ? o.to : o.path));
    const message = `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} (from ${hostname()})`;
    let result;
    try {
      result = await this.client.change(this.state.workspace, { baseCommit: this.state.head, message, ops, client: "fontego" });
    } catch (e) {
      if (!(e instanceof ClientError)) throw e;
      if (e.status === 403) {
        this.state.readOnly = true;
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
    for (const { item } of batch) {
      const { path, local: l } = item;
      const change = byPath.get(path);
      if (!l) {
        delete this.state.files[path];
        if (change) report.pushed.push({ path, status: "delete" });
        continue;
      }
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
    return "sent";
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
