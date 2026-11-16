// The local side of sync: scanning the folder, reading and writing files safely.

import { blobHash, normalizePath, PathError } from "@workspaces/core";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, posix, sep } from "node:path";

export const STATE_DIR = ".ws";

/** Files and folders sync never touches, whatever the workspace contains. */
const ALWAYS_IGNORED_DIRS = new Set([STATE_DIR, ".git"]);
const ALWAYS_IGNORED_FILES = [/^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /\.sw[op]$/, /~$/, /^\.#/, /^#.*#$/];

export interface LocalEntry {
  hash: string;
  mode: string;
  size: number;
  mtimeMs: number;
}

/** Simple ignore rules from a .wsignore file at the root: "name", "*.ext", "dir/", "path/to/file". */
export class Ignore {
  private readonly rules: Array<{ re: RegExp; dirOnly: boolean; anchored: boolean }> = [];

  constructor(text = "") {
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const dirOnly = line.endsWith("/");
      const body = line.replace(/\/+$/, "").replace(/^\//, "");
      const anchored = line.startsWith("/") || body.includes("/");
      const re = new RegExp(
        "^" +
          body
            .split("")
            .map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
            .join("") +
          "$",
      );
      this.rules.push({ re, dirOnly, anchored });
    }
  }

  ignores(path: string, isDir: boolean): boolean {
    const name = path.split("/").pop() ?? path;
    if (isDir && ALWAYS_IGNORED_DIRS.has(name) && !path.includes("/")) return true;
    if (isDir && name === ".git") return true;
    if (!isDir && ALWAYS_IGNORED_FILES.some((re) => re.test(name))) return true;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.anchored ? r.re.test(path) : r.re.test(name)) return true;
    }
    return false;
  }
}

export async function loadIgnore(root: string): Promise<Ignore> {
  try {
    return new Ignore(await readFile(join(root, ".wsignore"), "utf8"));
  } catch {
    return new Ignore();
  }
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
}

/** Walks the folder and returns every syncable file with its hash (reusing cached hashes when size and mtime match). */
export async function scan(root: string, ignore: Ignore, cache: Record<string, LocalEntry>): Promise<ScanResult> {
  const files = new Map<string, LocalEntry>();
  const invalid: string[] = [];
  async function walk(rel: string) {
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
      if (ignore.ignores(path, isDir)) continue;
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
      else {
        const entry = await readEntry(root, path, cache[path]);
        if (entry) files.set(path.normalize("NFC"), entry);
      }
    }
  }
  await walk("");
  return { files, invalid };
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
