// `fontego watch`: keeps a folder in step with the server. It syncs a moment after you stop editing, as soon as the
// server announces a commit, and every 30 s as a safety net. Without a connection it keeps watching and catches up
// when the server is back. Only one watcher per folder.

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ClientError, type Client } from "../client.ts";
import type { SyncEngine, SyncReport } from "./engine.ts";
import { IGNORE_FILE, IgnoreRules, MACHINE_IGNORE, STATE_DIR } from "./ignore.ts";

export interface WatchOptions {
  /** Quiet time after a local edit before syncing */
  debounceMs?: number;
  safetyMs?: number;
  onReport?: (report: SyncReport) => void;
  onError?: (error: Error) => void;
  onEvent?: (message: string) => void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class LockedError extends Error {}

/** Takes .fontego/lock for this process; fails if another live watcher holds it. */
export async function acquireLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, STATE_DIR, "lock");
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    if (pid && pid !== process.pid && alive(pid)) {
      throw new LockedError(`Another fontego watch (pid ${pid}) is already syncing this folder.`);
    }
  } catch (e) {
    if (e instanceof LockedError) throw e; // a missing or unreadable lock is a stale one
  }
  await rm(path, { force: true });
  const fh = await open(path, "wx");
  await fh.writeFile(String(process.pid));
  await fh.close();
  return async () => {
    await rm(path, { force: true });
  };
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
    let rules = await IgnoreRules.load(root);
    const reload = async () => {
      rules = await IgnoreRules.load(root);
    };
    this.fsw = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return this.schedule(debounce);
      const path = String(filename).split("\\").join("/");
      if (path === MACHINE_IGNORE || path === IGNORE_FILE || path.endsWith(`/${IGNORE_FILE}`)) void reload();
      if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) return;
      if (rules.match(path, false).ignored && !this.engine.state.files[path.normalize("NFC")]) return;
      this.schedule(debounce);
    });
    this.safety = setInterval(() => this.schedule(0), this.opts.safetyMs ?? 30_000);
    void this.listen();
  }

  private async listen() {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        await this.client.events(
          this.engine.state.workspace,
          (type) => {
            backoff = 1000;
            if (type === "ready") this.opts.onEvent?.("connected to live events");
            if (type === "commit") this.schedule(200);
          },
          this.abort.signal,
        );
      } catch (e) {
        if (this.stopped) return;
        this.opts.onEvent?.(`live events lost (${(e as Error).message}); retrying in ${Math.round(backoff / 1000)} s`);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, backoff));
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
