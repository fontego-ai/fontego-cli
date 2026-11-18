// The local side of sync: scanning the folder, reading and writing files safely.

import { blobHash, normalizePath, PathError } from "@fontego/core";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, posix, sep } from "node:path";
import { BUILT_IN, IgnoreRules, isJunk, STATE_DIR, type IgnoreMatch } from "./ignore.ts";

export { STATE_DIR } from "./ignore.ts";

export interface LocalEntry {
  hash: string;
  mode: string;
  size: number;
  mtimeMs: number;
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

/** Reads one local file (or symlink) as a sync entry; null if it doesn't exist or isn't a file. */
export async function readEntry(root: string, path: string, cached?: LocalEntry): Promise<LocalEntry | null> {
  const full = join(root, path);
  let st;
  try {
    st = await lstat(full);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    const target = await readlink(full);
    const bytes = new TextEncoder().encode(toPosix(target));
    return { hash: blobHash(bytes), mode: "120000", size: bytes.length, mtimeMs: st.mtimeMs };
  }
  if (!st.isFile()) return null;
  const mode = st.mode & 0o111 ? "100755" : "100644";
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.mode === mode) return cached;
  const bytes = new Uint8Array(await readFile(full));
  return { hash: blobHash(bytes), mode, size: st.size, mtimeMs: st.mtimeMs };
}

export async function readBytes(root: string, path: string, mode: string): Promise<Uint8Array> {
  const full = join(root, path);
  if (mode === "120000") return new TextEncoder().encode(toPosix(await readlink(full)));
  return new Uint8Array(await readFile(full));
}

export interface ScanResult {
  files: Map<string, LocalEntry>;
  /** Names that can't exist in a workspace (backslashes, control characters...) */
  invalid: string[];
  /** New files and folders (ending in /) the ignore rules keep from going up */
  ignored: string[];
  /** Files already in the workspace that the ignore rules match: they keep syncing */
  trackedIgnored: Array<{ path: string } & IgnoreMatch>;
}

/** Whether a folder holds a file the workspace doesn't have (junk aside). */
async function holdsUntracked(root: string, dir: string, tracked: Record<string, LocalEntry>): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(root, dir));
  } catch {
    return false;
  }
  for (const name of names) {
    const path = `${dir}/${name}`;
    let st;
    try {
      st = await lstat(join(root, path));
    } catch {
      continue;
    }
    if (st.isDirectory() ? await holdsUntracked(root, path, tracked) : !tracked[path.normalize("NFC")] && !isJunk(name)) return true;
  }
  return false;
}

/**
 * Walks the folder and returns every file to sync with its hash, reusing a known hash when size and mtime match.
 * `tracked` is what the workspace already has here (the sync state): those files are read even when the ignore rules
 * match them, also inside an ignored folder, because an ignore rule only keeps new files back (ignore.ts).
 */
export async function scan(root: string, rules: IgnoreRules, tracked: Record<string, LocalEntry>): Promise<ScanResult> {
  const files = new Map<string, LocalEntry>();
  const invalid: string[] = [];
  const ignored: string[] = [];
  const trackedIgnored: ScanResult["trackedIgnored"] = [];
  const trackedPaths = Object.keys(tracked);

  const add = async (path: string, match?: IgnoreMatch) => {
    const key = path.normalize("NFC");
    const entry = await readEntry(root, path, tracked[key]);
    if (!entry) return;
    files.set(key, entry);
    if (match?.ignored) trackedIgnored.push({ path: key, ...match });
  };

  async function walk(rel: string) {
    await rules.enter(rel);
    let names: string[];
    try {
      names = await readdir(rel ? join(root, rel) : root);
    } catch {
      return;
    }
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(join(root, path));
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      const match = rules.match(path, isDir);
      if (match.ignored) {
        if (match.source === BUILT_IN) continue;
        if (isDir) {
          // Not walked (node_modules can be huge): only what the workspace already has inside is read. Like Git, the
          // folder counts as ignored only if it holds something new.
          const prefix = `${path.normalize("NFC")}/`;
          const inside = trackedPaths.filter((p) => p.startsWith(prefix));
          for (const p of inside) await add(p, rules.match(p, false));
          if (!inside.length || (await holdsUntracked(root, path, tracked))) ignored.push(`${path}/`);
        } else if (tracked[path.normalize("NFC")]) await add(path, match);
        else ignored.push(path);
        continue;
      }
      try {
        normalizePath(path);
      } catch (e) {
        if (e instanceof PathError) {
          invalid.push(path);
          continue;
        }
        throw e;
      }
      if (isDir) await walk(path);
      else await add(path);
    }
  }
  await walk("");
  return { files, invalid, ignored: ignored.sort(), trackedIgnored: trackedIgnored.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Writes a file atomically (temp file + rename) and returns its new entry. */
export async function writeLocal(root: string, path: string, bytes: Uint8Array, mode: string): Promise<LocalEntry> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  const tmpDir = join(root, STATE_DIR, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, randomBytes(8).toString("hex"));
  if (mode === "120000") {
    await symlink(new TextDecoder().decode(bytes), tmp);
  } else {
    await writeFile(tmp, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
  }
  try {
    const st = await lstat(full);
    if (st.isDirectory()) throw new Error(`${path} is a folder here; it can't become a file.`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  await rename(tmp, full);
  return (await readEntry(root, path))!;
}

/** Deletes a file and the folders it leaves empty (never the root). */
export async function removeLocal(root: string, path: string) {
  await rm(join(root, path), { force: true });
  let dir = posix.dirname(path);
  while (dir && dir !== ".") {
    try {
      await rmdir(join(root, dir));
    } catch {
      break; // not empty
    }
    dir = posix.dirname(dir);
  }
}

/** "notes/plan.md" → "notes/plan (conflict Ana 2026-11-16 10.42.07).md" */
export function conflictName(path: string, who: string, date = new Date()): string {
  const dir = posix.dirname(path);
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const safeWho = who.replace(/[/\\\u0000-\u001f]/g, "").slice(0, 40) || "someone";
  const name = `${stem} (conflict ${safeWho} ${stamp})${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

export const isConflictCopy = (path: string) => /\(conflict [^)]*\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\)/.test(posix.basename(path));
