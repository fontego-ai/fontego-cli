// Asking for a secret (a password) without showing it, so it stays out of the screen and of the shell's history.

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
