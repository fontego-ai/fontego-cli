// The ignore rules of a synced folder, read from its disk. The rules themselves live in core (core/src/ignore.ts),
// because the server applies them too when it imports a folder into a new workspace.

import { IgnoreRules, MAX_RULES_BYTES } from "@fontego/core";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export { BUILT_IN, IGNORE_FILE, IgnoreRules, isJunk, MACHINE_IGNORE, STATE_DIR, type IgnoreMatch, type RulesProblem } from "@fontego/core";

// Not on Windows, where both are 0: there the lstat before opening is the check.
const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants;

const isAbsent = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/**
 * A rules file's text, only from a plain file in the folder, as Git reads .gitignore since 2.32: never through a
 * symlink (which could lead to /dev/zero, or to a pipe that never ends), and at most a little over MAX_RULES_BYTES,
 * which is all that counts. Opened without following a link nor waiting for a writer, then checked again, in case it
 * was swapped since the lstat. Null when there is none; an error with the reason when it can't be read.
 */
export async function readRulesFile(full: string): Promise<string | null> {
  const unread = (why: string) => new Error(`${why}, so its rules don't count`);
  const symlink = unread("it is a symlink, and ignore rules are read only from a plain file");
  const special = unread("it isn't a plain file");
  const failed = (e: unknown) => unread(`it can't be read (${(e as NodeJS.ErrnoException)?.code ?? (e as Error)?.message})`);
  try {
    const st = await lstat(full);
    if (st.isSymbolicLink()) throw symlink;
    if (!st.isFile()) throw special;
  } catch (e) {
    if (isAbsent(e)) return null;
    throw e === symlink || e === special ? e : failed(e);
  }
  const fh = await open(full, O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "ELOOP" ? symlink : failed(e);
  });
  try {
    if (!(await fh.stat()).isFile()) throw special;
    const buf = Buffer.alloc(MAX_RULES_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The rules of the folder at `root`: built-in, its .fontego/ignore and its .fontegoignore files. */
export const loadIgnoreRules = (root: string): Promise<IgnoreRules> => IgnoreRules.load((path) => readRulesFile(join(root, path)));
