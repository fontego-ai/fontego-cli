// Which files sync leaves alone, in three levels, as Git does:
//
//   built-in     the .git and .fontego folders, and the junk operating systems and editors leave (short on purpose);
//   per machine  .fontego/ignore, never synced, like .git/info/exclude;
//   shared       .fontegoignore files in the workspace, at the top or in any folder. They sync to everyone and travel
//                with templates.
//
// The syntax is .gitignore's in full (the `ignore` library): `*`, `**`, `!` to take a file back, a leading `/` to
// anchor a rule to its file's folder, a trailing `/` for folders only. A rule in a deeper .fontegoignore wins over one
// higher up, the shared files over the machine's, and within a file the last rule that matches. As in Git, nothing
// below an ignored folder can be taken back.
//
// An ignore rule only keeps new files from going up. It never deletes anything or stops a file that is already in
// the workspace (tracked) from syncing: otherwise a `*` written by one person would make everyone's sync delete
// every file. To take such a file out of the workspace: fontego rm.
//
// This is a convenience of each copy. The paths the server protects or rejects (paths.ts) are the workspace's
// policy, enforced on the server whatever these files say.
//
// The rules live here, in core, because the server applies them too when it imports a folder, a zip or a Git
// repository into a new workspace: there every file is new, so what the rules ignore stays out. They read their files
// through a function, so the same code works on a disk, inside a zip or on a Git tree.

import ignore, { type Ignore } from "ignore";

export const STATE_DIR = ".fontego";
export const IGNORE_FILE = ".fontegoignore";
/** The machine's own rules, inside the state folder, so they never sync. */
export const MACHINE_IGNORE = `${STATE_DIR}/ignore`;
export const BUILT_IN = "built-in";

const JUNK_FILES: Array<[RegExp, string]> = [
  [/^\.DS_Store$/, ".DS_Store"],
  [/^Thumbs\.db$/i, "Thumbs.db"],
  [/^desktop\.ini$/i, "desktop.ini"],
  [/\.sw[op]$/, "*.swp, *.swo"],
  [/~$/, "*~"],
  [/^\.#/, ".#*"],
  [/^#.*#$/, "#*#"],
];

export interface IgnoreMatch {
  ignored: boolean;
  /** The file the deciding rule is in (".fontegoignore", "docs/.fontegoignore", ".fontego/ignore"), or "built-in" */
  source?: string;
  /** Its line in that file, from 1 */
  line?: number;
  pattern?: string;
  /** The folder ignored, when the path is ignored because a folder above it is */
  folder?: string;
}

interface Level {
  /** The folder its rules apply to, "" for the top */
  dir: string;
  source: string;
  rules: Ignore;
}

function parse(text: string): Ignore {
  const rules = ignore();
  text.split(/\r?\n/).forEach((pattern, i) => {
    if (pattern.trim() && !pattern.trimStart().startsWith("#")) rules.add({ pattern, mark: String(i + 1) });
  });
  return rules;
}

/** A rules file's text by its path from the top (".fontegoignore", "docs/.fontegoignore", ".fontego/ignore"), or null. */
export type ReadRules = (path: string) => Promise<string | null>;

async function readRules(read: ReadRules, file: string): Promise<Ignore | null> {
  const text = await read(file).catch(() => null);
  return text === null ? null : parse(text);
}

/** Whether a file name is junk an operating system or editor leaves. */
export const isJunk = (name: string) => JUNK_FILES.some(([re]) => re.test(name));

/** Built-in rules: true with the rule's name, or null. */
function builtIn(path: string, isDir: boolean): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (isDir) return name === ".git" ? ".git/" : path === STATE_DIR ? `${STATE_DIR}/` : null;
  return JUNK_FILES.find(([re]) => re.test(name))?.[1] ?? null;
}

export class IgnoreRules {
  /** .fontegoignore of each folder seen so far; null where there is none */
  private readonly shared = new Map<string, Level | null>();
  private readonly memo = new Map<string, IgnoreMatch>();

  private constructor(
    private readonly read: ReadRules,
    private readonly machine: Level | null,
  ) {}

  static async load(read: ReadRules): Promise<IgnoreRules> {
    const machine = await readRules(read, MACHINE_IGNORE);
    const r = new IgnoreRules(read, machine ? { dir: "", source: MACHINE_IGNORE, rules: machine } : null);
    await r.enter("");
    return r;
  }

  /** Reads a folder's .fontegoignore, once. Scanning calls it on the way down; match needs it for every folder above. */
  async enter(dir: string): Promise<void> {
    if (this.shared.has(dir)) return;
    const source = dir ? `${dir}/${IGNORE_FILE}` : IGNORE_FILE;
    const rules = await readRules(this.read, source);
    this.shared.set(dir, rules ? { dir, source, rules } : null);
    if (rules) this.memo.clear();
  }

  /** Reads the .fontegoignore of every folder above a path, for a path that wasn't reached by scanning. */
  async prepare(path: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) await this.enter(parts.slice(0, i).join("/"));
  }

  /** Whether the rules ignore a path, and which rule decides. The folders above it must have been entered. */
  match(path: string, isDir: boolean): IgnoreMatch {
    const key = `${isDir ? "d" : "f"}:${path}`;
    const known = this.memo.get(key);
    if (known) return known;
    const result = this.decide(path, isDir);
    this.memo.set(key, result);
    return result;
  }

  private decide(path: string, isDir: boolean): IgnoreMatch {
    const builtin = builtIn(path, isDir);
    if (builtin) return { ignored: true, source: BUILT_IN, pattern: builtin };
    // Nothing below an ignored folder comes back.
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      const parent = this.match(path.slice(0, slash), true);
      if (parent.ignored) return { ...parent, folder: parent.folder ?? path.slice(0, slash) };
    }
    // From the weakest level to the strongest; the last one with an opinion decides.
    const levels: Level[] = [];
    if (this.machine) levels.push(this.machine);
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const level = this.shared.get(parts.slice(0, i).join("/"));
      if (level) levels.push(level);
    }
    let decision: IgnoreMatch = { ignored: false };
    for (const level of levels) {
      const rel = (level.dir ? path.slice(level.dir.length + 1) : path) + (isDir ? "/" : "");
      const r = level.rules.test(rel);
      if (r.ignored) decision = { ignored: true, source: level.source, line: Number(r.rule!.mark), pattern: r.rule!.pattern };
      else if (r.unignored) decision = { ignored: false };
    }
    return decision;
  }
}
