// One sync round: bring down what changed on the server, send up what changed here, and never lose an edit.
//
//   pull  — files that changed only on the server are written here
//   push  — files that changed here go up as one change set, each with the hash it started from; the server merges
//           text changed on both sides
//   pull  — again, to pick up our own commit and anything that landed meanwhile
//
// A real conflict keeps both: the server's version stays in place and ours is saved next to it as a conflict copy.

import { blobHash, MAX_OPS, roleAtLeast, symlinkProblem, textContent, type ChangeOp, type Conflict, type FileMode, type Role } from "@fontego/core";
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
  own,
  reasonOf,
  replaceIf,
  UnsafePathError,
  scan,
  stillInTheWay,
  SwappedError,
  type LocalEntry,
  type Unreadable,
} from "./local.ts";
import { saveState, type Skipped, type SyncState } from "./state.ts";

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
  /** Symlinks here that could point outside the folder: not sent (nor their target), and not taken for deleted */
  unsentLinks: Array<{ path: string; reason: string }>;
  /**
   * Local changes not sent in this round: with read-only access (readOnly), or because the round gave up (the server
   * kept refusing without saying which file). The next round tries them again.
   */
  pending: number;
  readOnly: boolean;
}

const same = (a: LocalEntry | undefined, b: LocalEntry | undefined) =>
  a === b || (!!a && !!b && a.hash === b.hash && a.mode === b.mode);

/** A download whose bytes aren't the ones the server listed: damaged on the way, or a server that is wrong. */
class DamagedDownload extends Error {
  constructor(path: string) {
    super(`what came down for ${path} isn't what the server lists; it is tried again next round`);
  }
}

/**
 * Errors that say a path can't be written here as things are (a name this file system doesn't take, a folder or a
 * file in the way, a link that could lead out), not that it failed this once (no space, no permission, a damaged
 * download).
 */
const LASTING = ["ENAMETOOLONG", "EINVAL", "EISDIR", "ENOTDIR", "EEXIST", "ENOTEMPTY", "ELOOP", "EILSEQ"];
const lasting = (e: unknown) => e instanceof UnsafePathError || LASTING.includes((e as NodeJS.ErrnoException)?.code ?? "");
/** Of those, the ones that say the name itself can't be here: too long, or not one this file system takes. */
const BAD_NAME = ["ENAMETOOLONG", "EINVAL", "EILSEQ"];

/** What it takes for a file of the server's that can't be here to come down, in words. */
export function whatItTakes(k: Skipped): string {
  const d = k.down;
  if (!d) return "";
  if (d.blocker) return `It comes down once ${d.blocker.path} is no longer a ${d.blocker.is} here.`;
  if (d.never) return "It stays on the server, and comes down only once it changes there (renamed, say).";
  return `It is tried again${k.retryAt ? ` after ${new Date(k.retryAt).toLocaleString()}` : ""}.`;
}

/** Why one path failed, in words: our own errors say it; a file system's has its code. */
function whyNot(e: unknown): string {
  if (e instanceof UnsafePathError || e instanceof DamagedDownload) return e.message;
  const code = (e as NodeJS.ErrnoException)?.code;
  if (!code) return reasonOf(e);
  return lasting(e) ? `it can't be written in this folder (${code})` : `it couldn't be written here this time (${code}); it is tried again next round`;
}

/**
 * The server's changes in its order, except that a delete which clears the way for a put goes first: a file that
 * became a folder (or the other way round), or a name that only changes case, which a system that ignores case sees
 * as the same file.
 */
function clearingFirst<T>(changes: Map<string, T | null>): Array<[string, T | null]> {
  const names = new Set<string>();
  const folders = new Set<string>();
  for (const [path, r] of changes) {
    if (!r) continue;
    const parts = path.toLowerCase().split("/");
    names.add(parts.join("/"));
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const inTheWay = (path: string) => {
    const parts = path.toLowerCase().split("/");
    return names.has(parts.join("/")) || folders.has(parts.join("/")) || parts.some((_, i) => i > 0 && names.has(parts.slice(0, i).join("/")));
  };
  const all = [...changes];
  const first = all.filter(([path, r]) => !r && inTheWay(path));
  return [...first, ...all.filter(([path, r]) => r || !inTheWay(path))];
}

/** Notes one path left out of this round, once, however many times the round goes past it. */
function noteSkipped(report: SyncReport, path: string, reason: string) {
  if (!report.skipped.some((s) => s.path === path && s.reason === reason)) report.skipped.push({ path, reason });
}

/**
 * At most this much JSON per change set: well under the smallest body a server takes (64 MiB). A file bigger than this
 * goes on its own, which always fits: a server takes a body of twice its largest file.
 */
export const BATCH_BYTES = 32 * 1024 * 1024;

/** How long a refused file waits before the same content goes again: 5 min, doubling up to 6 h. */
export const retryDelay = (tries: number) => Math.min(5 * 60_000 * 2 ** (tries - 1), 6 * 3_600_000);
/** How long a copy that can only read waits before asking the server for its role again: 1 min, doubling up to 1 h. */
export const roleDelay = (tries: number) => Math.min(60_000 * 2 ** (tries - 1), 3_600_000);

export interface EngineOptions {
  /** Most JSON in one change set (BATCH_BYTES) */
  batchBytes?: number;
  /** The clock, for tests */
  now?: () => number;
}

/** One local change waiting to go up; its bytes are read only when its batch is made. */
interface Outgoing {
  path: string;
  /** The file here (none: deleted here) */
  local?: LocalEntry;
  /** The file at the last sync, its base */
  base?: LocalEntry;
}

function emptyReport(): SyncReport {
  return { head: null, pulled: [], pushed: [], conflicts: [], skipped: [], invalid: [], unreadable: [], unsentLinks: [], pending: 0, readOnly: false };
}

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private again = false;

  private readonly batchBytes: number;
  private readonly now: () => number;
  /** When a copy that can only read asks for its role again, and how many times it asked in vain */
  private roleCheckAt = 0;
  private roleTries = 0;

  constructor(
    readonly root: string,
    private readonly client: Client,
    readonly state: SyncState,
    opts: EngineOptions = {},
  ) {
    this.batchBytes = opts.batchBytes ?? BATCH_BYTES;
    this.now = opts.now ?? Date.now;
  }

  /** Sets a file aside after a refusal of this content, with when to try it again. */
  private skip(path: string, hash: string, reason: string) {
    const before = own(this.state.skipped, path);
    const tries = before && before.hash === hash ? (before.tries ?? 0) + 1 : 1;
    const entry: Skipped = { hash, reason, retryAt: new Date(this.now() + retryDelay(tries)).toISOString(), tries };
    this.state.skipped[path] = entry;
  }

  /**
   * A copy that can only read, with changes waiting: asks the server whether it may write now (a reader made an
   * editor, or a refusal that was a one-off), at most once per roleDelay, so a lasting refusal costs few calls.
   */
  private async mayWriteAgain(): Promise<boolean> {
    if (this.now() < this.roleCheckAt) return false;
    let role: Role | null;
    try {
      role = (await this.client.workspace(this.state.workspace)).role;
    } catch (e) {
      if (e instanceof ClientError && (e.status === 0 || e.status >= 500)) return false; // offline: next round
      throw e;
    }
    if (roleAtLeast(role, "editor")) {
      this.state.readOnly = false;
      this.roleTries = 0;
      this.roleCheckAt = 0;
      return true;
    }
    this.roleCheckAt = this.now() + roleDelay(++this.roleTries);
    return false;
  }

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
    await this.bringDown(report);
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

  /** A file at a commit, checked against the hash the server listed for it. */
  private async download(path: string, rev: string, hash: string): Promise<{ bytes: Uint8Array; mode: string; hash: string }> {
    const f = await this.client.file(this.state.workspace, path, rev);
    if (blobHash(f.bytes) !== hash) throw new DamagedDownload(path);
    return { bytes: f.bytes, mode: f.mode, hash };
  }

  /**
   * Writes the server's version of a file here, unless the local file changed since we looked at it: checked before
   * downloading, and again, without a gap, when the new version goes in (replaceIf), so an edit saved during the
   * download stays and goes up next.
   */
  private async writeIfUnchanged(path: string, expected: LocalEntry | undefined, rev: string, hash: string): Promise<boolean> {
    const now = await readEntry(this.root, path, expected);
    if (!same(now ?? undefined, expected)) return false;
    const f = await this.download(path, rev, hash);
    const done = await replaceIf(this.root, path, { bytes: f.bytes, mode: f.mode }, expected, { who: this.state.user });
    if (!done) return false;
    this.state.files[path] = done.entry!;
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
    for (const [path, r] of clearingFirst(remote)) {
      if (insideUnreadable(scanned.unreadable, path)) {
        // Can't see what is here: leave it, keep its base, and don't step past this change (below).
        waiting = true;
        continue;
      }
      // Listed again: what was set aside for it is superseded by what happens now.
      if (own(this.state.skipped, path)?.down) delete this.state.skipped[path];
      try {
        await this.pullOne(report, path, r, local, rules, res.head);
      } catch (e) {
        // One path that can't be written here never stops the rest, nor what goes up. One that can't be as things
        // are here (a name this system doesn't take, a folder in the way, a link that could lead out) is set aside
        // with what it takes (notHere); one that failed this once waits, like a folder that can't be read.
        if (e instanceof ClientError) throw e;
        if (!lasting(e)) {
          noteSkipped(report, path, whyNot(e));
          waiting = true;
          continue;
        }
        delete this.state.files[path];
        if (r) this.notHere(report, path, r, res.head, e);
        else noteSkipped(report, path, whyNot(e));
      }
    }
    // A change that had to wait keeps the copy at its last full step, so the server sends it again next round. What
    // was applied meanwhile is in state.files, and comes again as "already identical". (The server only checks that a
    // change set's baseCommit exists; each file merges from its own baseHash.)
    if (!waiting) this.state.head = res.head;
  }

  /**
   * Sets aside a file of the server's that can't be written here as things are, in state.skipped, so that status
   * keeps naming it and a later round brings it down: once what is in its way is gone (bringDown looks every round),
   * or, when that isn't known, after a growing wait. A path that can't be here at all waits until it changes there.
   */
  private notHere(report: SyncReport, path: string, r: { hash: string; mode: string }, rev: string, e: unknown) {
    const blocker = e instanceof UnsafePathError ? e.blocker : undefined;
    const never = !blocker && (e instanceof UnsafePathError || BAD_NAME.includes((e as NodeJS.ErrnoException)?.code ?? ""));
    const k: Skipped = { hash: r.hash, reason: whyNot(e), down: { mode: r.mode, rev, ...(blocker ? { blocker } : never ? { never: true } : {}) } };
    if (!blocker && !never) {
      const before = own(this.state.skipped, path);
      k.tries = before?.down && before.hash === r.hash ? (before.tries ?? 0) + 1 : 1;
      k.retryAt = new Date(this.now() + retryDelay(k.tries)).toISOString();
    }
    this.state.skipped[path] = k;
    noteSkipped(report, path, `${k.reason} ${whatItTakes(k)}`);
  }

  /**
   * Brings down the files of the server's set aside by notHere whose way is clear now: a blocker that one lstat finds
   * gone, or a wait that is over. Each round, also when nothing changed on the server, so a folder moved out of the
   * way lets the file come at the next sync.
   */
  private async bringDown(report: SyncReport) {
    for (const [path, k] of Object.entries(this.state.skipped)) {
      const d = k.down;
      if (!d || d.never || report.skipped.some((s) => s.path === path)) continue;
      if (d.blocker ? await stillInTheWay(this.root, d.blocker) : k.retryAt && Date.parse(k.retryAt) > this.now()) continue;
      delete this.state.skipped[path];
      try {
        await insideRoot(this.root, path);
        // Nothing there is expected: a file made here meanwhile stays, and goes up as a new one (a conflict, if so).
        if (await this.writeIfUnchanged(path, undefined, d.rev, k.hash)) report.pulled.push({ path, status: "put" });
      } catch (e) {
        if (e instanceof ClientError) {
          if (e.status === 404) continue; // not there any more
          this.state.skipped[path] = k;
          throw e;
        }
        if (lasting(e)) this.notHere(report, path, { hash: k.hash, mode: d.mode }, d.rev, e);
        else {
          this.state.skipped[path] = k;
          noteSkipped(report, path, whyNot(e));
        }
      }
    }
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
    const s = own(this.state.files, path);
    const l = local.get(path);
    const changedHere = !same(l, s);
    if (!r) {
      if (!changedHere && l) {
        // Gone from the workspace. A file the rules here ignore stays, as one of this copy's own; any other goes.
        await rules.prepare(path);
        // Only if it is still what we scanned: an edit saved since then stays, and goes back up as a new file.
        if (!rules.match(path, false).ignored && (await replaceIf(this.root, path, null, l, { who: this.state.user }))) {
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
      if (await this.writeIfUnchanged(path, l, head, r.hash)) report.pulled.push({ path, status: "put" });
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
    report.unsentLinks = scanned.unsentLinks;
    const local = scanned.files;
    const unsent = new Set(scanned.unsentLinks.map((u) => u.path));

    const todo: Outgoing[] = [];
    const paths = new Set([...local.keys(), ...Object.keys(this.state.files)]);
    for (const path of [...paths].sort()) {
      if (insideUnreadable(scanned.unreadable, path)) continue; // unknown here: neither sent nor deleted
      if (unsent.has(path)) continue; // a link that can't go up as it is: neither sent nor deleted
      const l = local.get(path);
      const s = own(this.state.files, path);
      if (same(l, s)) continue;
      // Refused before with this same content: it waits until its retryAt (the rules may have changed by then).
      const skip = own(this.state.skipped, path);
      if (skip && skip.hash === (l?.hash ?? "deleted") && skip.retryAt && Date.parse(skip.retryAt) > this.now()) continue;
      if (l || s) todo.push({ path, local: l, base: s });
    }
    report.pending = todo.length;
    if (todo.length === 0) return "done";
    if (this.state.readOnly && !(await this.mayWriteAgain())) return "done";

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
      if (absent(e) || e instanceof SwappedError) return null; // changed since the scan: the next round sees it
      throw e;
    }
    // A link changed since the scan to point outside: it waits for the next scan, which lists it, target unsent.
    if (l.mode === "120000" && symlinkProblem(path, bytes)) return null;
    // Edited between the scan and now: what goes up is what was read, so that is what the state must remember.
    const hash = blobHash(bytes);
    if (hash !== l.hash) item.local = { ...l, hash, size: bytes.length, mtimeMs: -1 };
    const op: ChangeOp = { op: "put", path, baseHash: s?.hash ?? null, mode: l.mode as FileMode };
    const text = textContent(bytes);
    if (text === null) op.contentBase64 = Buffer.from(bytes).toString("base64");
    else op.content = text;
    return op;
  }

  /** Settles one conflict the server answered, keeping both sides when it can. */
  private async resolve(report: SyncReport, c: Conflict, ops: ChangeOp[], local: Map<string, LocalEntry>, rev: string | undefined) {
    const op = ops.find((o) => (o.op === "move" ? o.to === c.path || o.from === c.path : o.path === c.path));
    const l = local.get(c.path);
    if (op?.op === "put" && c.reason === "missing") {
      // Deleted on the server, edited here: keep the edit as a new file.
      delete this.state.files[c.path];
      report.conflicts.push({ path: c.path, reason: c.reason, message: `${c.path} was deleted on the server; your edited copy is kept.` });
      return;
    }
    if (op?.op === "put" && l && c.currentHash && rev) {
      // The server's version first; then, in one go, the file here (as it is at that moment, with any edit saved
      // meanwhile) moves to the conflict copy and the server's takes its place.
      const f = await this.download(c.path, rev, c.currentHash);
      const done = await replaceIf(this.root, c.path, { bytes: f.bytes, mode: f.mode }, undefined, {
        who: this.state.user,
        keepAs: conflictName(c.path, this.state.user),
      });
      if (done) this.state.files[c.path] = done.entry!;
      const copy = done?.keptAs;
      report.conflicts.push({ path: c.path, reason: c.reason, copy, message: copy ? `${c.message} Your version is in "${copy}".` : c.message });
      return;
    }
    if (op?.op === "delete" && c.currentHash && rev) {
      const f = await this.download(c.path, rev, c.currentHash);
      const done = await replaceIf(this.root, c.path, { bytes: f.bytes, mode: f.mode }, undefined, { who: this.state.user });
      if (done) this.state.files[c.path] = done.entry!;
      report.conflicts.push({ path: c.path, reason: c.reason, message: `${c.path} changed on the server, so it was not deleted; it's back with the new version.` });
      return;
    }
    // Can't be resolved by keeping both (e.g. a file where a folder is): leave it out until it changes.
    this.skip(c.path, l?.hash ?? "deleted", c.message);
    report.conflicts.push({ path: c.path, reason: c.reason, message: c.message });
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
        // Can only read here (or so it says now): the changes wait, and the role is asked again later (mayWriteAgain).
        this.state.readOnly = true;
        this.roleCheckAt = this.now() + roleDelay(++this.roleTries);
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
        this.skip(path, local.get(path)?.hash ?? "deleted", e.message);
        report.skipped.push({ path, reason: e.message });
        return "retry";
      }
      if (e.code === "conflict") {
        const details = e.details as { head: string | null; conflicts: Conflict[] };
        for (const c of details.conflicts) {
          try {
            await this.resolve(report, c, ops, local, details.head ?? undefined);
          } catch (err) {
            // A conflict that can't be settled here (its copy or the server's version can't be written) waits like a
            // refused file; the rest goes on.
            if (err instanceof ClientError) throw err;
            this.skip(c.path, local.get(c.path)?.hash ?? "deleted", whyNot(err));
            noteSkipped(report, c.path, whyNot(err));
          }
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
      if (change?.merged && result.commit && change.hash) {
        // The server merged our edit with someone else's: bring the merged text here (checked against its hash).
        // If it changed again meanwhile, or can't be written now, keep the original base: the next round merges once
        // more.
        try {
          await this.writeIfUnchanged(path, l, result.commit, change.hash);
        } catch (e) {
          if (e instanceof ClientError) throw e;
          noteSkipped(report, path, whyNot(e));
        }
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
  const rules = await loadIgnoreRules(root);
  const scanned = await scan(root, rules, state.files);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, l] of scanned.files) {
    const s = own(state.files, path);
    if (!s) added.push(path);
    else if (!same(l, s)) modified.push(path);
  }
  const unsent = new Set(scanned.unsentLinks.map((u) => u.path));
  for (const path of Object.keys(state.files)) {
    if (!scanned.files.has(path) && !insideUnreadable(scanned.unreadable, path) && !unsent.has(path)) deleted.push(path);
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    invalid: scanned.invalid,
    /** Folders and files that couldn't be read: nothing under them counts as deleted */
    unreadable: scanned.unreadable,
    /** Symlinks here that could point outside the folder: never sent */
    unsentLinks: scanned.unsentLinks,
    skipped: state.skipped,
    /** New files and folders the ignore rules keep here */
    ignored: scanned.ignored,
    /** Files in the workspace that the rules match: they keep syncing */
    trackedIgnored: scanned.trackedIgnored,
    /** Ignore files that couldn't be read (a symlink, not a plain file), or only in part: the rest doesn't count */
    rulesNotRead: rules.problems,
  };
}
