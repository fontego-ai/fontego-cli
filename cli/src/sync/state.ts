// .fontego/state.json: what the folder looked like after the last sync. Without .git, this is all the client keeps.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isWorkspacePath, STATE_DIR, type Blocker, type LocalEntry } from "./local.ts";

export interface SyncState {
  version: 1;
  url: string;
  workspace: string;
  /** Who this copy belongs to, for conflict copy names */
  user: string;
  /** Last server commit this folder is in step with */
  head: string | null;
  /** Each file as it was at "head" (the base for the next edit) */
  files: Record<string, LocalEntry>;
  /**
   * Files the server refused (policy), by the hash that was refused: retried when the file changes, and, the same
   * content, from `retryAt` on (the rules may have changed), waiting longer after each refusal (`tries`)
   */
  skipped: Record<string, Skipped>;
  /** Set when the server says this person can only read; the role is checked again while changes wait to go up */
  readOnly?: boolean;
}

export interface Skipped {
  hash: string;
  reason: string;
  /** When to send the same content again (ISO time); none (a state from an earlier version): at the next round */
  retryAt?: string;
  /** Refusals of this same content so far */
  tries?: number;
  /**
   * Set when it is a file of the server's that can't be written here as things are (without it, a local file the
   * server refused): its mode and the commit to bring it from, `hash` being its hash there. With `blocker`, what is in
   * its way here, looked at every round: it comes down once that is gone. With `never`, the path itself can't be here
   * (a name this system doesn't take, a link that could lead out): it waits until it changes on the server. With
   * neither, it is tried again from `retryAt`.
   */
  down?: { mode: string; rev: string; blocker?: Blocker; never?: true };
}

export const statePath = (root: string) => join(root, STATE_DIR, "state.json");

export function newState(url: string, workspace: string, user: string): SyncState {
  return { version: 1, url, workspace, user, head: null, files: pathRecord(), skipped: pathRecord() };
}

/**
 * A record by path with no prototype, so that a file named `constructor`, `toString` or `__proto__` is just a key.
 * Only the paths the server would write are kept from `from`: a key with "..", or one a newer rule refuses (a state
 * edited by hand, planted, or written before the rule), is forgotten, so sync never reads or writes there.
 */
function pathRecord<T>(from: Record<string, T> = {}): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [path, value] of Object.entries(from)) if (isWorkspacePath(path)) record[path] = value;
  return record;
}

/** A synced folder's state that can't be used: damaged, or written by a newer fontego. The hint says what to do. */
export class StateError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** What is wrong with a parsed state, or null. */
function stateProblem(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "it isn't an object";
  const o = s as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === "string" && (o[k] as string).length > 0;
  const map = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
  if (!str("url") || !str("workspace") || typeof o.user !== "string") return "url, workspace or user is missing";
  if (o.head !== null && typeof o.head !== "string") return "head is neither a commit nor null";
  if (!map(o.files) || !map(o.skipped)) return "files or skipped is missing";
  for (const [path, f] of Object.entries(o.files as Record<string, unknown>)) {
    const e = f as Record<string, unknown> | null;
    if (!e || typeof e.hash !== "string" || typeof e.mode !== "string" || typeof e.size !== "number" || typeof e.mtimeMs !== "number") {
      return `the entry of ${path} is broken`;
    }
  }
  for (const [path, k] of Object.entries(o.skipped as Record<string, unknown>)) {
    const e = k as Record<string, unknown> | null;
    if (!e || typeof e.hash !== "string" || typeof e.reason !== "string") return `the skipped entry of ${path} is broken`;
  }
  if (o.readOnly !== undefined && typeof o.readOnly !== "boolean") return "readOnly is neither true nor false";
  return null;
}

/** Reads a synced folder's state, checking it is one this fontego can use. */
export async function loadState(root: string): Promise<SyncState> {
  const path = statePath(root);
  // Without the state the files are still all there: link the folder again and only what differs moves.
  const relink = (ws?: string) =>
    `The files are fine. Move ${join(root, STATE_DIR)} aside (keep it until you're sure) and run \`fontego link ${ws ?? "WORKSPACE"} ${root}\`: what is the same as the workspace stays, anything different goes up or into a conflict copy.`;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new StateError(`${path} can't be read: ${(e as Error).message}.`, relink());
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version === "number" && version > 1) {
    throw new StateError(
      `${path} was written by a newer fontego (state version ${version}; this one reads version 1).`,
      "Update fontego (the same way you installed it), then run this again.",
    );
  }
  const problem = version === 1 ? stateProblem(raw) : "it has no version 1";
  if (problem) throw new StateError(`${path} is damaged: ${problem}.`, relink((raw as { workspace?: string } | null)?.workspace));
  const state = raw as SyncState;
  const skipped = pathRecord(state.skipped);
  // A file to bring down whose details don't hold is forgotten: the next change to it on the server brings it again.
  for (const [p, k] of Object.entries(skipped)) if (k.down !== undefined && !validDown(k.down)) delete skipped[p];
  return { ...state, files: pathRecord(state.files), skipped };
}

function validDown(d: unknown): boolean {
  const o = d as Skipped["down"] & object;
  if (!o || typeof o !== "object" || typeof o.mode !== "string" || typeof o.rev !== "string") return false;
  const b = o.blocker;
  return b === undefined || (!!b && isWorkspacePath(b.path) && ["folder", "file", "symlink"].includes(b.is));
}

export async function saveState(root: string, state: SyncState) {
  const path = statePath(root);
  await mkdir(dirname(path), { recursive: true });
  // A temporary file of its own: two writers never write into the same one (and a lock keeps them apart anyway).
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Finds the synced folder that contains "start" by walking up to the first .fontego/state.json of this user's. A state
 * someone else could have put there is never taken (like Git since CVE-2022-24765), since it says which server the
 * commands run here talk to and which files go up: the walk doesn't go up into a folder of another user (the top of
 * /tmp, a shared drive), it passes over a .fontego or a state that isn't this user's, and the top of a disk is never a
 * synced folder. Where files have no owner to compare (Windows), only the last holds: C:\.fontego is never taken.
 * `notes` gets why a state was passed over, for the message that says there is none. `uid` is for tests.
 */
export function findRoot(start: string, opts: { notes?: string[]; uid?: number } = {}): string | null {
  const uid = opts.uid ?? process.getuid?.();
  const mine = (path: string, kind: "dir" | "file") => {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || !(kind === "dir" ? st.isDirectory() : st.isFile())) return null;
    return uid === undefined || st.uid === uid;
  };
  let dir = resolve(start);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    const state = statePath(dir);
    if (existsSync(state)) {
      if (mine(join(dir, STATE_DIR), "dir") && mine(state, "file")) return dir;
      opts.notes?.push(`${state} isn't yours (or isn't a plain file in a folder of yours), so it was left alone`);
    }
    if (mine(parent, "dir") === false) return null;
    dir = parent;
  }
}
