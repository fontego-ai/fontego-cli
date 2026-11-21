// Path rules shared by the server and the client, so both reject the same things.

export class PathError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
/**
 * Folders no workspace may hold, at any depth: Git's, and `.fontego`, where each synced copy keeps its own state (the
 * server it syncs with, what it last saw, its own ignore rules). A file there from the workspace would rewrite that
 * state on every member's machine.
 */
const RESERVED = [".git", ".fontego"];
/** Their short names on Windows (GIT~1, FONTEG~1), which open the same folder. */
const SHORT_NAME = /^(git|fonteg)~\d+$/;
// Control characters: C0 (NUL, tab and newline among them), DEL and C1.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Code points HFS+ leaves out when it compares names, the list Git's protectHFS uses: `.g‌it` is .git there. */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/gu;

/**
 * The name a file system really opens for this one. HFS+ skips some invisible code points; Windows drops trailing dots
 * and spaces and reads what follows a colon as a stream of the same file: `.git.`, `.git ` and
 * `.git::$INDEX_ALLOCATION` are all the folder .git there.
 */
const aliasOf = (name: string) => name.replace(HFS_IGNORED, "").split(":")[0]!.replace(/[. ]+$/, "");

/**
 * Whether a name is .git or .fontego on some file system, whatever the case (as Git's verify_path checks .git with
 * protectNTFS and protectHFS). Both case mappings, because Windows upcases `ı` to `I`.
 */
export function isReservedName(name: string): boolean {
  const alias = aliasOf(name);
  return [alias.toLowerCase(), alias.toUpperCase().toLowerCase()].some((n) => RESERVED.includes(n) || SHORT_NAME.test(n));
}

/** Normalizes a workspace-relative path and rejects anything that could escape the workspace. */
export function normalizePath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathError("invalid_path", "The path is empty.");
  }
  const path = input.normalize("NFC");
  if (path.length > MAX_PATH) {
    throw new PathError("invalid_path", `The path is longer than ${MAX_PATH} characters.`);
  }
  if (CONTROL.test(path)) {
    throw new PathError("invalid_path", "The path contains control characters.");
  }
  if (path.includes("\\")) {
    throw new PathError("invalid_path", "The path contains a backslash.", "Use forward slashes: notes/2026/file.md");
  }
  if (path.startsWith("/")) {
    throw new PathError("invalid_path", "The path must be relative to the workspace root.", "Drop the leading slash.");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new PathError("path_escapes", `The path "${path}" has an empty, "." or ".." segment.`);
    }
    if (segment.length > MAX_SEGMENT) {
      throw new PathError("invalid_path", `A path segment is longer than ${MAX_SEGMENT} characters.`);
    }
    if (isReservedName(segment)) {
      throw new PathError(
        "reserved_path",
        RESERVED.includes(segment.toLowerCase())
          ? `Paths inside ${segment} are reserved.`
          : `"${segment}" is reserved: on Windows or macOS it is the same folder as .git or .fontego.`,
      );
    }
  }
  return segments.join("/");
}

/**
 * The target of the symlink at `path`, from its bytes, if it can't lead outside the workspace however links combine.
 * `a -> .`, `b -> a/..` and `c -> b/secret` each land inside on paper, yet b is the folder above the copy on disk, and
 * c a file outside it. So a target is only some `..` (no more than the folders above the link), then names, each one a
 * name a workspace may hold (`.` may stand anywhere, and a trailing `/`: neither climbs). A link's folders are always
 * real folders, since nothing can sit inside a symlink, so each `..` climbs a real folder inside the workspace and each
 * name goes down from one: every step, through any number of links, stays inside. No backslash or colon either, which
 * Windows reads as a separator or a drive. Throws a PathError (`path_escapes` or `invalid_symlink`) that says why not.
 */
export function symlinkTarget(path: string, bytes: Uint8Array): string {
  const target = exactText(bytes);
  const refuse = (code: string, why: string): never => {
    throw new PathError(code, `${path} is a symlink ${why}.`, "A symlink in a workspace points to a path relative to its folder, inside the workspace.");
  };
  if (!target) return refuse("invalid_symlink", target === null ? "whose target isn't UTF-8" : "with no target");
  if (CONTROL.test(target) || target.includes("\\") || target.includes(":")) {
    return refuse("invalid_symlink", "whose target has a backslash, a colon or a control character");
  }
  if (target.startsWith("/")) return refuse("invalid_symlink", "to an absolute path");
  const names = target.replace(/(.)\/$/, "$1").split("/");
  let up = 0;
  while (names[up] === "..") up++;
  if (up > path.split("/").length - 1) return refuse("path_escapes", "that points outside the workspace");
  const down = names.slice(up).filter((n) => n !== ".");
  if (down.includes("..")) return refuse("path_escapes", "that goes back up (..) after a name");
  if (down.length) {
    try {
      normalizePath(down.join("/"));
    } catch (e) {
      if (e instanceof PathError) return refuse(e.code === "reserved_path" ? "reserved_path" : "invalid_symlink", `to a path a workspace can't hold (${e.message})`);
      throw e;
    }
  }
  return target;
}

/**
 * Why a path can't be a file on Windows, or null. A workspace may hold these, since they are valid on Linux and macOS;
 * a copy on Windows leaves them out: the names Windows keeps for devices (CON, aux.md, COM1...), the characters it
 * doesn't take in a name (`< > : " | ? *`; a colon would write a stream of another file), and a name ending in a dot
 * or a space, which it drops (`notes.` would land on `notes`).
 */
export function windowsNameProblem(path: string): string | null {
  for (const name of path.split("/")) {
    if (/[<>:"|?*]/.test(name)) return `"${name}" has a character Windows doesn't take in names (< > : " | ? *)`;
    if (/[. ]$/.test(name)) return `"${name}" ends in a dot or a space, which Windows drops`;
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i.test(name.split(".")[0]!.replace(/ +$/, ""))) {
      return `"${name}" is a name Windows keeps for a device`;
    }
  }
  return null;
}

/** Normalizes an optional directory prefix; "" means the root. */
export function normalizePrefix(input: unknown): string {
  if (input === undefined || input === null || input === "") return "";
  const trimmed = String(input).replace(/\/+$/, "");
  return trimmed === "" ? "" : normalizePath(trimmed);
}

/** True if the bytes look like text (no NUL byte in the first 8000 bytes, like Git's heuristic). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false;
  return true;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The bytes as a string, only if that string turns back into the very same bytes: valid UTF-8, a BOM kept. Anything
 * else (Latin-1, a stray byte) is null and has to travel as base64, because a lenient decoder would swap the bytes it
 * doesn't understand for U+FFFD, and the default one drops a BOM: the file that arrives wouldn't be the one sent.
 */
export function exactText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return null;
  }
  const back = new TextEncoder().encode(text);
  if (back.length !== bytes.length) return null;
  for (let i = 0; i < back.length; i++) if (back[i] !== bytes[i]) return null;
  return text;
}

/** A file's content as text for JSON ("content"), or null when it has to go as base64 ("contentBase64"). */
export const textContent = (bytes: Uint8Array): string | null => (looksLikeText(bytes) ? exactText(bytes) : null);

// --- Path patterns: which paths a workspace protects or rejects ---
//
// A pattern names paths from the workspace's top, split by "/". In a name, `*` stands for any characters and `?` for
// one; a name that is just `**` stands for any number of folders, none included. A pattern matches a whole path, and
// ignores case, as the file systems of macOS and Windows do: `**/AGENTS.md` is every AGENTS.md, `.claude/**`
// everything under .claude at the top.

/** What is wrong with a pattern, or null. */
export function pathPatternError(pattern: string): string | null {
  if (!pattern || pattern.length > 200) return "a pattern has 1 to 200 characters";
  if (CONTROL.test(pattern) || pattern.includes("\\")) return "a pattern has no control characters or backslashes";
  if (pattern.startsWith("/") || pattern.endsWith("/")) return "a pattern starts and ends with a name, not a /";
  const names = pattern.split("/");
  if (names.some((n) => n === "" || n === "." || n === "..")) return "a pattern has no empty, . or .. names";
  if (names.some((n) => n.includes("**") && n !== "**")) return "** stands alone between slashes";
  return null;
}

const nameRegex = new Map<string, RegExp>();

function nameMatches(pattern: string, name: string): boolean {
  let re = nameRegex.get(pattern);
  if (!re) {
    const body = [...pattern].map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
    re = new RegExp(`^${body}$`, "iu");
    nameRegex.set(pattern, re);
  }
  return re.test(name);
}

function namesMatch(pattern: string[], path: string[], p = 0, n = 0): boolean {
  if (p === pattern.length) return n === path.length;
  if (pattern[p] === "**") {
    for (let skip = n; skip <= path.length; skip++) if (namesMatch(pattern, path, p + 1, skip)) return true;
    return false;
  }
  return n < path.length && nameMatches(pattern[p]!, path[n]!) && namesMatch(pattern, path, p + 1, n + 1);
}

/** Whether a pattern matches a path. */
export function matchPath(pattern: string, path: string): boolean {
  return namesMatch(pattern.normalize("NFC").split("/"), path.normalize("NFC").split("/"));
}

/**
 * Whether a symlink at this path would let files reach what the pattern names: the path is where the pattern's
 * folders are, with the rest of the pattern below it. A link named .claude pointing to an ordinary folder would turn
 * that folder's settings.json into .claude/settings.json on every machine, so a pattern for .claude/settings.json in
 * any folder reaches a symlink named .claude. A pattern's leading `**` alone reaches nothing: files below any folder
 * are checked by their own path when they are written.
 */
export function patternReachesBelow(pattern: string, path: string): boolean {
  const names = pattern.normalize("NFC").split("/");
  const at = path.normalize("NFC").split("/");
  for (let k = 1; k < names.length; k++) {
    const head = names.slice(0, k);
    if (head.some((n) => n !== "**") && namesMatch(head, at)) return true;
  }
  return false;
}
