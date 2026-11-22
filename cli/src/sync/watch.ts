// `fontego watch`: keeps a folder in step with the server. It syncs a moment after you stop editing, as soon as the
// server announces a commit, and every 30 s as a safety net. Without a connection it keeps watching and catches up
// when the server is back. Only one watcher per folder.

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ClientError, type Client } from "../client.ts";
import type { SyncEngine, SyncReport } from "./engine.ts";
import { IGNORE_FILE, loadIgnoreRules, MACHINE_IGNORE, STATE_DIR } from "./ignore.ts";
import { own } from "./local.ts";

export interface WatchOptions {
  /** Quiet time after a local edit before syncing */
  debounceMs?: number;
  safetyMs?: number;
  onReport?: (report: SyncReport) => void;
  onError?: (error: Error) => void;
  onEvent?: (message: string) => void;
}

/** Whether a process is running here; one of another user still counts (EPERM). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockedError extends Error {}

/** Who holds a folder's lock. */
export interface Holder {
  pid: number;
  host: string;
  command?: string;
}

/**
 * The lock's holder; null if there is no lock. One from an older version (just a pid) counts too. One that can't be
 * read as either has pid -1: being written right now if it is new, else left broken.
 */
async function holderOf(path: string): Promise<Holder | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { pid: -1, host: hostname() };
  }
  try {
    const h = JSON.parse(text) as Holder | number;
    if (typeof h === "number" && Number.isInteger(h) && h > 0) return { pid: h, host: hostname() };
    if (h && typeof h === "object" && typeof h.pid === "number") return { pid: h.pid, host: String(h.host ?? hostname()), command: h.command };
  } catch {
    // not JSON
  }
  return { pid: -1, host: hostname() };
}

const sameHolder = (a: Holder, b: Holder) => a.pid === b.pid && a.host === b.host;

/**
 * Makes a file with this text in one step, already whole: written to a temporary file first, then linked into place
 * (link never overwrites), so nobody ever reads it half written. Where hard links aren't possible, O_EXCL makes it
 * (and a reader may then see it empty for an instant: holderOf gives pid -1, which waits). False if it exists.
 */
async function create(path: string, text: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  try {
    await link(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code)) throw e;
  } finally {
    await rm(tmp, { force: true });
  }
  try {
    const fh = await open(path, "wx", 0o600);
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Removes a lock file only if it still is `holder`'s. It is moved aside in one step and read there, so a lock somebody
 * made in its place meanwhile (while this process stalled after judging the old one stale, say) is never deleted: it
 * goes back where it was, with link, which never overwrites. Only a lock made in that instant, between the move and
 * the link, could still meet another one; then the one moved aside is dropped, and its holder's release, which checks
 * the holder, leaves the other be.
 */
export async function removeIfHeldBy(path: string, holder: Holder): Promise<void> {
  const aside = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.stale`;
  try {
    await rename(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // cleared meanwhile
    throw e;
  }
  try {
    const now = await holderOf(aside);
    if (now && sameHolder(now, holder)) return;
    try {
      await link(aside, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST" || !["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code)) return;
      // No hard links here: put it back by name, if the place is still free.
      if (!(await lstat(path).then(() => true, () => false))) await rename(aside, path);
    }
  } finally {
    await rm(aside, { force: true });
  }
}

const ageOf = (path: string) => stat(path).then((st) => Date.now() - st.mtimeMs, () => 0);
const pause = () => new Promise((r) => setTimeout(r, 10 + Math.random() * 20));

/** A takeover file older than this belongs to a process that died while clearing a lock. */
const TAKEOVER_STALE_MS = 10_000;

/**
 * Takes .fontego/lock for this process, so only one fontego at a time writes a folder and its state (watch, sync, and
 * the first round of clone and link). The lock is made in one step (O_EXCL), so of two processes only one gets it.
 * One left by a process that is gone is cleared only under a second, short lock (lock.takeover, made the same way)
 * and after checking, under it, that it still is that one: nobody can put a new lock in its place meanwhile, because
 * nobody else can clear it. A takeover left for more than 10 s is cleared too, and since its process may only have
 * stalled, every removal (the lock, a takeover, the release) checks the file it moves aside (removeIfHeldBy). One of
 * a live process, or of another machine (a shared folder), is a LockedError.
 */
export async function acquireLock(root: string, command = "fontego"): Promise<() => Promise<void>> {
  const dir = join(root, STATE_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "lock");
  const takeover = `${path}.takeover`;
  const me: Holder = { pid: process.pid, host: hostname(), command };
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await create(path, JSON.stringify(me))) {
      return () => removeIfHeldBy(path, me);
    }
    const holder = await holderOf(path);
    if (!holder) continue; // released meanwhile
    if (holder.pid === -1 && (await ageOf(path)) < TAKEOVER_STALE_MS) {
      await pause(); // being written: look again
      continue;
    }
    const what = `${holder.command ?? "fontego"} (pid ${holder.pid}${holder.host !== me.host ? ` on ${holder.host}` : ""})`;
    if (holder.host !== me.host) {
      throw new LockedError(`${what} is working in this folder. If nothing runs there any more, remove ${path}.`);
    }
    if (holder.pid !== me.pid && alive(holder.pid)) {
      throw new LockedError(`Another ${what} is already working in this folder. Let it finish; a fontego watch keeps it in sync by itself.`);
    }
    // Left by a process that is gone: clear it under the takeover lock, if it still is that one, and try again.
    if (await create(takeover, JSON.stringify(me))) {
      try {
        await removeIfHeldBy(path, holder);
      } finally {
        await removeIfHeldBy(takeover, me);
      }
      continue;
    }
    // Someone else is clearing it. If that takeover was left by a process that died midway (or stalled past the
    // limit), clear it too, if it still is that one.
    const clearing = await holderOf(takeover);
    if (clearing && (await ageOf(takeover)) > TAKEOVER_STALE_MS) await removeIfHeldBy(takeover, clearing);
    await pause();
  }
  throw new LockedError("Other fontego processes keep taking this folder's lock. Try again in a moment.");
}

export class Watcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private safety: ReturnType<typeof setInterval> | undefined;
  private fsw: FSWatcher | undefined;
  private abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly engine: SyncEngine,
    private readonly client: Client,
    private readonly opts: WatchOptions = {},
  ) {}

  private schedule(delay: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.engine.sync().then(
        (r) => this.opts.onReport?.(r),
        (e) => this.opts.onError?.(e as Error),
      );
    }, delay);
  }

  async start() {
    // Without the server (offline, or it is restarting), or signed out (the session ended), keep going: the retries
    // below catch up once it is back, or once the person signs in again. Anything else (a workspace that is gone)
    // won't fix itself, so it stops here.
    try {
      this.opts.onReport?.(await this.engine.sync());
    } catch (e) {
      if (!(e instanceof ClientError && (e.status === 0 || e.status === 401 || e.status >= 500))) throw e;
      this.opts.onError?.(e);
    }
    const root = this.engine.root;
    const debounce = this.opts.debounceMs ?? 1500;
    // Changes to what the rules ignore don't start a round, unless the file is in the workspace already. A changed
    // ignore file brings the rules up to date; the round it starts reads them anew anyway.
    let rules = await loadIgnoreRules(root);
    const reload = async () => {
      rules = await loadIgnoreRules(root);
    };
    this.fsw = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return this.schedule(debounce);
      const path = String(filename).split("\\").join("/");
      if (path === MACHINE_IGNORE || path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`)) void reload();
      if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) return;
      if (rules.match(path, false).ignored && !own(this.engine.state.files, path.normalize("NFC"))) return;
      this.schedule(debounce);
    });
    this.safety = setInterval(() => this.schedule(0), this.opts.safetyMs ?? 30_000);
    void this.listen();
  }

  private async listen() {
    let backoff = 1000;
    while (!this.stopped) {
      const opened = Date.now();
      let tooMany = false;
      try {
        await this.client.events(
          this.engine.state.workspace,
          (type, data) => {
            if (type === "ready") this.opts.onEvent?.("connected to live events");
            if (type === "commit") this.schedule(200);
            if (type === "closed") {
              tooMany = true;
              this.opts.onEvent?.(`live events closed: ${(data as { message?: string }).message ?? "too many streams"}`);
            }
          },
          this.abort.signal,
        );
      } catch (e) {
        if (this.stopped) return;
        this.opts.onEvent?.(`live events lost (${(e as Error).message}); retrying in ${Math.round(backoff / 1000)} s`);
      }
      if (this.stopped) return;
      // The wait starts over only after a stream that lasted. Closed for having too many, coming straight back would
      // close another one: it waits five minutes, syncing every 30 s meanwhile as always.
      if (Date.now() - opened > 60_000) backoff = 1000;
      const wait = tooMany ? 5 * 60_000 : backoff;
      await new Promise<void>((r) => {
        const t = setTimeout(r, wait);
        this.abort.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
      });
      backoff = Math.min(backoff * 2, 30_000);
      this.schedule(0); // catch up on whatever happened while disconnected
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.safety) clearInterval(this.safety);
    this.fsw?.close();
    this.abort.abort();
  }
}
