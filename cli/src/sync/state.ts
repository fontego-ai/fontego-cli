// .fontego/state.json: what the folder looked like after the last sync. Without .git, this is all the client keeps.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { STATE_DIR, type LocalEntry } from "./local.ts";

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
}

export const statePath = (root: string) => join(root, STATE_DIR, "state.json");

export function newState(url: string, workspace: string, user: string): SyncState {
  return { version: 1, url, workspace, user, head: null, files: {}, skipped: {} };
}

export async function loadState(root: string): Promise<SyncState> {
  return JSON.parse(await readFile(statePath(root), "utf8")) as SyncState;
}

export async function saveState(root: string, state: SyncState) {
  const path = statePath(root);
  await mkdir(dirname(path), { recursive: true });
  // A temporary file of its own: two writers never write into the same one (and a lock keeps them apart anyway).
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/** Finds the synced folder that contains "start" by walking up to the first .fontego/state.json. */
export function findRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(statePath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
