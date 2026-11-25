// fontego on a pseudo-terminal, as a person sees it: colours, the terminal's width, and what goes to stderr mixed
// with stdout. Bun gives the child a real terminal (Bun.spawn's `terminal`), so nothing here opens a window.

import { join } from "node:path";

const MAIN = join(import.meta.dir, "../src/main.ts");

export interface OnTerminal {
  /** Everything that reached the terminal, escapes included */
  text: string;
  /** null when it was stopped because `until` showed */
  code: number | null;
}

/**
 * Runs fontego with `args` on a terminal of `cols` columns. With `until`, stops it as soon as that shows (for a
 * command that waits, such as a sign-in); otherwise waits for it to end, at most `timeoutMs`.
 */
export async function onTerminal(
  args: string[],
  env: Record<string, string | undefined>,
  opts: { cols?: number; until?: RegExp; timeoutMs?: number } = {},
): Promise<OnTerminal> {
  let text = "";
  let seen: () => void = () => {};
  const shown = new Promise<void>((resolve) => (seen = resolve));
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { PATH: process.env.PATH, TERM: "xterm-256color", ...env } as Record<string, string>,
    terminal: {
      cols: opts.cols ?? 80,
      rows: 40,
      data(_term, data) {
        text += new TextDecoder().decode(data);
        if (opts.until?.test(text)) seen();
      },
    },
  });
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), opts.timeoutMs ?? 15_000));
  const ended = await Promise.race([proc.exited.then((code) => ({ code })), shown.then(() => "shown" as const), timeout]);
  if (ended === "shown" || ended === "timeout") {
    proc.kill();
    await proc.exited;
    if (ended === "timeout") throw new Error(`fontego ${args.join(" ")} didn't ${opts.until ? `show ${opts.until}` : "end"} in time:\n${text}`);
    return { text, code: null };
  }
  // What the terminal still had to hand over
  await Bun.sleep(50);
  return { text, code: ended.code };
}
