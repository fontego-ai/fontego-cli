// Values a command reads instead of taking them on the command line: a secret (a password), asked for without showing
// it, so it stays out of the screen and of the shell's history; and long text, such as a file's content, from stdin.

import { UsageError } from "./args.ts";

/** Reads a secret: typed on the terminal without echo, or the first line of stdin when that is not a terminal. */
export async function readSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const line = (await Bun.stdin.text()).split(/\r?\n/)[0] ?? "";
    if (!line) throw new UsageError(`${label} is a secret: type it when asked, or pipe it in on stdin. Nothing came on stdin.`);
    return line;
  }
  const stdin = process.stdin;
  process.stderr.write(`${label} (not shown): `);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  const value = await new Promise<string>((resolve, reject) => {
    let typed = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new UsageError("Cancelled: nothing changed."));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else if (ch >= " ") typed += ch;
      }
    };
    stdin.on("data", onData);
  });
  if (!value) throw new UsageError("Nothing typed: nothing changed.");
  return value;
}

/** Reads the whole of stdin as text, for an argument such as a file's content: `fontego write WS PATH < file`. */
export async function readStdin(label: string, usage: string): Promise<string> {
  if (process.stdin.isTTY) throw new UsageError(`${label} comes from stdin: ${usage} < FILE, or pipe it in.`);
  const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  // A forgotten `< file` would otherwise write an empty file without a word.
  if (!bytes.length) throw new UsageError(`Nothing came on stdin for ${label}: ${usage} < FILE. For an empty one, pass "" as ${label}.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label} isn't text. Binary files go through sync, or the API with contentBase64.`);
  }
}
