// Values a command reads instead of taking them on the command line: a secret (a password), asked for without showing
// it, so it stays out of the screen and of the shell's history; and long text, such as a file's content, from stdin.

import { exactText } from "@fontego/core";
import { UsageError } from "./args.ts";
import { canAsk, whyNotAsked } from "./output.ts";
import { askText } from "./picker.ts";

/**
 * Reads a secret: the first line of stdin when that is not a terminal, else typed on the terminal without echo, but
 * only when fontego may ask a person (canAsk: never with --json, in CI or when an agent runs it).
 */
export async function readSecret(label: string, json = false): Promise<string> {
  if (!process.stdin.isTTY) {
    const line = (await Bun.stdin.text()).split(/\r?\n/)[0] ?? "";
    if (!line) throw new UsageError(`${label} is a secret: type it when asked, or pipe it in on stdin. Nothing came on stdin.`);
    return line;
  }
  if (!canAsk(json)) throw new UsageError(`${label} is a secret, and nothing is asked here (${whyNotAsked(json)}): pipe it in on stdin.`);
  return askText(label, { hidden: true });
}

/**
 * Reads the whole of stdin as bytes, for a file flag given `-` (`fontego edit WS PATH --edits - < edits.json`): never
 * from a terminal, never nothing (a forgotten `< file`), and never more than `maxBytes`, which is checked as it comes.
 * `usage` is the command as it reads stdin: `fontego edit WORKSPACE PATH --edits -`.
 */
export async function readStdinBytes(label: string, usage: string, maxBytes: number): Promise<Uint8Array> {
  if (process.stdin.isTTY) throw new UsageError(`${label} - reads stdin: ${usage} < FILE, or pipe it in.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.length;
    if (size > maxBytes) throw new UsageError(`${label}: more than ${sizeText(maxBytes)} came on stdin; this Fontego takes at most that.`);
    chunks.push(chunk);
  }
  if (!size) throw new UsageError(`Nothing came on stdin for ${label} -: ${usage} < FILE.`);
  return Buffer.concat(chunks);
}

/** 1.5 MB, 12 KB: a size for a message. */
export const sizeText = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`);

/** Reads the whole of stdin as text, for an argument such as a file's content: `fontego write WS PATH < file`. */
export async function readStdin(label: string, usage: string): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError(`${label} comes from stdin: ${usage} < FILE, or pipe it in.`);
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  // A forgotten `< file` would otherwise write an empty file without a word.
  if (!bytes.length) throw new UsageError(`Nothing came on stdin for ${label}: ${usage} < FILE. For an empty one, pass "" as ${label}.`);
  // Only text that gives back the very same bytes (a BOM kept): what is written is what came in.
  const text = exactText(bytes);
  if (text === null) throw new UsageError(`${label} isn't UTF-8 text. Other files go through sync, or the API with contentBase64.`);
  return text;
}
