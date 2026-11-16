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
// Control characters, including NUL, tab and newline.
const CONTROL = /[\u0000-\u001f\u007f]/;

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
    if (segment.toLowerCase() === ".git") {
      throw new PathError("reserved_path", "Paths inside .git are reserved.");
    }
  }
  return segments.join("/");
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
