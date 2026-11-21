// The local side of sync: scanning the folder, reading and writing files safely.

import { blobHash, MAX_PATH, MAX_SEGMENT, normalizePath, PathError, symlinkTarget } from "@fontego/core";
import { link, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
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

/** Whether an error means the thing isn't there (as opposed to being there and unreadable). */
export const absent = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");
const reasonOf = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message ?? String(e);

/** A folder or file the scan couldn't read: what is there is unknown, so nothing under it counts as added or gone. */
export interface Unreadable {
  path: string;
  reason: string;
}

/** Whether a path is one of `unreadable`, or inside one of them. */
export const insideUnreadable = (unreadable: Unreadable[], path: string) =>
  unreadable.some((u) => path === u.path || path.startsWith(`${u.path}/`));

/**
 * Reads one local file (or symlink) as a sync entry; null if it doesn't exist or isn't a file. A file that is there
 * but can't be read (permissions, I/O) throws: it must never pass for a deleted one.
 */
export async function readEntry(root: string, path: string, cached?: LocalEntry): Promise<LocalEntry | null> {
  const full = join(root, path);
  let st;
  try {
    st = await lstat(full);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
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
  /** Folders and files that couldn't be read: left as they were, never taken for deleted */
  unreadable: Unreadable[];
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
  const unreadable: Unreadable[] = [];
  const trackedPaths = Object.keys(tracked);

  const add = async (path: string, match?: IgnoreMatch) => {
    const key = path.normalize("NFC");
    let entry;
    try {
      entry = await readEntry(root, path, tracked[key]);
    } catch (e) {
      unreadable.push({ path: key, reason: reasonOf(e) });
      return;
    }
    if (!entry) return;
    files.set(key, entry);
    if (match?.ignored) trackedIgnored.push({ path: key, ...match });
  };

  async function walk(rel: string) {
    await rules.enter(rel);
    let names: string[];
    try {
      names = await readdir(rel ? join(root, rel) : root);
    } catch (e) {
      if (absent(e)) return; // gone while we walked
      if (!rel) throw new Error(`Can't read the synced folder ${root}: ${reasonOf(e)}.`);
      // There, but unreadable: what it holds is unknown, so nothing inside counts as deleted.
      unreadable.push({ path: rel.normalize("NFC"), reason: reasonOf(e) });
      return;
    }
    for (const name of names) {
      const path = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await lstat(join(root, path));
      } catch (e) {
        if (!absent(e)) unreadable.push({ path: path.normalize("NFC"), reason: reasonOf(e) });
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
  return {
    files,
    invalid,
    ignored: ignored.sort(),
    trackedIgnored: trackedIgnored.sort((a, b) => a.path.localeCompare(b.path)),
    unreadable: unreadable.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/**
 * Refuses a path that would reach outside the folder: one that isn't a clean workspace path (the server could send
 * anything), or one whose folders on the way down include a symlink here, which a write or a delete would follow
 * wherever it points (`a -> .` and `b -> a/..` look harmless one by one, and `b/x` lands next to the folder).
 */
export async function insideRoot(root: string, path: string): Promise<void> {
  let clean: string;
  try {
    clean = normalizePath(path);
  } catch (e) {
    throw new UnsafePathError(path, e instanceof PathError ? e.message : String(e));
  }
  if (clean !== path) throw new UnsafePathError(path, "it isn't written the way the server writes paths");
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    let st;
    try {
      st = await lstat(join(root, folder));
    } catch {
      return; // from here down nothing exists yet: mkdir makes real folders
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(path, `${folder} is a symlink here, and Fontego doesn't write through one`);
    if (!st.isDirectory()) return; // the write fails on its own, inside the folder
  }
}

export class UnsafePathError extends Error {
  constructor(
    readonly path: string,
    why: string,
  ) {
    super(`Left ${JSON.stringify(path)} alone: ${why}.`);
  }
}

/** Writes the bytes to a new temporary file inside the folder (so a rename or link to their place stays on one disk). */
async function prepare(root: string, path: string, bytes: Uint8Array, mode: string): Promise<string> {
  const tmp = join(await tmpDir(root), randomBytes(8).toString("hex"));
  if (mode === "120000") {
    // The server checks this rule too, but a workspace may hold links from before it, or the server may be wrong.
    let target: string;
    try {
      target = symlinkTarget(path, bytes);
    } catch (e) {
      if (e instanceof PathError) throw new UnsafePathError(path, `it is a symlink that could point outside this folder (${e.message})`);
      throw e;
    }
    await symlink(target, tmp);
  } else {
    await writeFile(tmp, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
  }
  return tmp;
}

async function tmpDir(root: string): Promise<string> {
  const dir = join(root, STATE_DIR, "tmp");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Refuses to put a file where a folder is. */
async function notAFolder(full: string, path: string) {
  try {
    if ((await lstat(full)).isDirectory()) throw new Error(`${path} is a folder here; it can't become a file.`);
  } catch (e) {
    if (!absent(e)) throw e;
  }
}

/** Writes a file atomically (temp file + rename) and returns its new entry. */
export async function writeLocal(root: string, path: string, bytes: Uint8Array, mode: string): Promise<LocalEntry> {
  await insideRoot(root, path);
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  const tmp = await prepare(root, path, bytes, mode);
  try {
    await notAFolder(full, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await rename(tmp, full);
  return (await readEntry(root, path))!;
}

/**
 * Puts `src` at `dst` only if nothing is there, in one step: link() never overwrites, so a file saved at `dst` in the
 * meantime stays. Where a hard link isn't possible (a symlink, or a file system without them) it checks and renames,
 * with only that instant in between. False if `dst` was taken.
 */
async function placeNew(src: string, dst: string): Promise<boolean> {
  if (!(await lstat(src)).isSymbolicLink()) {
    try {
      await link(src, dst);
      await rm(src, { force: true });
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "EEXIST") return false;
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code)) throw e;
    }
  }
  try {
    await lstat(dst);
    return false;
  } catch (e) {
    if (!absent(e)) throw e;
  }
  await rename(src, dst);
  return true;
}

/** Puts `src` at `path`, or, if that is taken, at the first free "path 2", "path 3"... next to it. Returns where. */
async function placeAt(root: string, src: string, path: string): Promise<string> {
  await insideRoot(root, path);
  await mkdir(dirname(join(root, path)), { recursive: true });
  const dot = posix.basename(path).lastIndexOf(".");
  const cut = dot > 0 ? path.length - posix.basename(path).length + dot : path.length;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : `${path.slice(0, cut)} ${n}${path.slice(cut)}`;
    if (await placeNew(src, join(root, candidate))) return candidate;
  }
}

/**
 * Puts the person's own version at its conflict copy's name, or, if that name can't be made here, at a short one next
 * to it. Throws only if neither can be made, with `src` still where it was.
 */
async function keepCopy(root: string, src: string, name: string, path: string): Promise<string> {
  try {
    return await placeAt(root, src, name);
  } catch (e) {
    const short = shortConflictName(path);
    if (short === name) throw e;
    return placeAt(root, src, short);
  }
}

/**
 * The person's file, moved aside, that couldn't go where it was meant to: back to its place, or, if a new file took
 * that place meanwhile, next to it as a conflict copy. Never deleted: if neither works, it stays in .fontego/tmp and
 * the error says where.
 */
async function putBack(root: string, aside: string, path: string, who: string) {
  try {
    if (await placeNew(aside, join(root, path))) return;
    await keepCopy(root, aside, conflictName(path, who), path);
  } catch (e) {
    throw new Error(`Your version of ${path} couldn't be put back, so it is kept in ${aside} (${reasonOf(e)}).`);
  }
}

const sameFile = (a: LocalEntry | null | undefined, b: LocalEntry | undefined) => (!a && !b) || (!!a && !!b && a.hash === b.hash && a.mode === b.mode);

/**
 * Changes the file at `path` (to `next`, or deletes it when `next` is null) only if it still is `expected` (undefined:
 * nothing there), so that an edit saved here while sync was busy is never lost. The file there is first moved aside in
 * one step (rename) and checked there, and the new one goes in with placeNew, which never overwrites:
 * - it wasn't the expected one: it goes back to its place, or, if a new file took that place meanwhile, next to it as a
 *   conflict copy, and nothing changes;
 * - a new file took the place after it was moved aside: that one stays and nothing changes;
 * - with `keepAs` (a conflict: keep both), whatever is there goes to that path, checked or not, and the new one in.
 * What was moved aside is deleted only once it is known to be the expected file, which the server has; anything else
 * is placed somewhere, or put back if that fails (putBack). Returns the new entry (null for a delete) and where the
 * old file went, or null when it left things as they were.
 */
export async function replaceIf(
  root: string,
  path: string,
  next: { bytes: Uint8Array; mode: string } | null,
  expected: LocalEntry | undefined,
  opts: { who: string; keepAs?: string },
): Promise<{ entry: LocalEntry | null; keptAs?: string } | null> {
  await insideRoot(root, path);
  const full = join(root, path);
  const dir = await tmpDir(root);
  let tmp: string | null = null;
  let entry: LocalEntry | null = null;
  if (next) {
    await mkdir(dirname(full), { recursive: true });
    tmp = await prepare(root, path, next.bytes, next.mode);
    entry = await readEntry(root, posix.join(STATE_DIR, "tmp", posix.basename(tmp)));
  }
  const name = randomBytes(8).toString("hex");
  const aside = join(dir, name);
  /** Whether `aside` holds the person's file, not yet placed anywhere nor known to be the expected one */
  let held = false;
  try {
    await notAFolder(full, path);
    try {
      await rename(full, aside);
      held = true;
    } catch (e) {
      if (!absent(e)) throw e;
    }
    let keptAs: string | undefined;
    if (opts.keepAs) {
      if (held) {
        keptAs = await keepCopy(root, aside, opts.keepAs, path);
        held = false;
      }
    } else {
      const there = held ? await readEntry(root, posix.join(STATE_DIR, "tmp", name)) : null;
      if (!sameFile(there, expected)) {
        // Edited (or made, or deleted) here since the scan: leave it be.
        if (held && !(await placeNew(aside, full))) await keepCopy(root, aside, conflictName(path, opts.who), path);
        held = false;
        return null;
      }
      held = false; // the expected file: the server has it
    }
    if (tmp && !(await placeNew(tmp, full))) return null; // a file saved here just now: it stays
    if (!next) await removeEmptyFolders(root, path);
    // The entry is the temporary file's: a link or a rename keeps its mtime, while reading the place again could
    // already see an edit saved right after, and take it for what the server sent.
    return { entry, ...(keptAs ? { keptAs } : {}) };
  } finally {
    if (tmp) await rm(tmp, { force: true });
    if (held) await putBack(root, aside, path, opts.who);
    else await rm(aside, { force: true });
  }
}

/** Deletes a file and the folders it leaves empty (never the root). */
export async function removeLocal(root: string, path: string) {
  await insideRoot(root, path);
  await rm(join(root, path), { force: true });
  await removeEmptyFolders(root, path);
}

/** Removes the folders above `path` that are left empty (never the root). */
async function removeEmptyFolders(root: string, path: string) {
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

/**
 * The longest name a conflict copy gets: a name fits 255 bytes of UTF-8 on Linux and macOS and 255 UTF-16 units on
 * Windows and in a workspace, less room for the " 2" placeAt may add.
 */
const COPY_NAME_MAX = MAX_SEGMENT - 5;
const fitsName = (name: string) => name.length <= COPY_NAME_MAX && Buffer.byteLength(name, "utf8") <= COPY_NAME_MAX;

const stampOf = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
};

/** Who, as a name can hold it on any system: letters, digits, spaces and . - _, in NFC, at most 40 characters. */
const whoInName = (who: string) =>
  [...who.normalize("NFC").replace(/[^\p{L}\p{M}\p{N} ._-]/gu, "").replace(/ {2,}/g, " ").trim()].slice(0, 40).join("").trim().normalize("NFC") ||
  "someone";

/**
 * "notes/plan.md" → "notes/plan (conflict Ana 2026-11-16 10.42.07).md". The name is cut short where it has to be (a
 * long name, or one of many bytes in UTF-8) so that the copy can always be made: the end of its stem goes, then the
 * extension too if it alone wouldn't fit.
 */
export function conflictName(path: string, who: string, date = new Date()): string {
  const dir = posix.dirname(path);
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot) : "";
  const mark = ` (conflict ${whoInName(who)} ${stampOf(date)})`;
  if (!fitsName(`x${mark}${ext}`)) [stem, ext] = [base, ""];
  const room = MAX_PATH - (dir === "." ? 0 : dir.length + 1);
  const chars = [...stem];
  let name = `${stem}${mark}${ext}`;
  while ((!fitsName(name) || name.length > room) && chars.length) {
    chars.pop();
    name = `${chars.join("").trimEnd()}${mark}${ext}`;
  }
  return dir === "." ? name : `${dir}/${name}`;
}

/** A conflict copy's name when the usual one can't be made: "(conflict 2026-11-16 10.42.07).md", next to the file. */
export function shortConflictName(path: string, date = new Date()): string {
  const dir = posix.dirname(path);
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(base.slice(dot)) ? base.slice(dot) : "";
  const name = `(conflict ${stampOf(date)})${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

export const isConflictCopy = (path: string) => /\(conflict [^)]*\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\)/.test(posix.basename(path));
