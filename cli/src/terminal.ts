// Everything fontego prints goes through one filter (main.ts installs it), because much of what it prints was written by
// other people or by a server: names, commit messages, file names, error messages and hints. In many terminals,
// control characters in that text can clear the screen, fake a line or a prompt, or set the clipboard (OSC 52), and
// the bidi controls reorder what is shown. For a person they become a visible �. JSON escapes most of them already;
// the ones it leaves alone (C1 and the bidi controls) are escaped too, as \u…, which is the same JSON.

import { writeSync } from "node:fs";

/** Control characters but tab and newline, a carriage return that doesn't end a line, and the bidi controls. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/g;

/** Text for a person: what could act on the terminal shows as �. */
export const forPerson = (text: string) => text.replace(UNSAFE, "\uFFFD");

/** Text that is (or holds) JSON: what could act on the terminal is written as a \u escape. */
export const forJson = (text: string) => text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Whether bytes meant for a terminal could act on it (`fontego cat` of someone else's file). */
export const unsafeForTerminal = (text: string) => new RegExp(UNSAFE.source).test(text);

/**
 * Whether what goes to a terminal may carry colours: it is one, NO_COLOR isn't set (https://no-color.org) and its
 * TERM draws them. Colour only ever marks a failure (output.ts) and the picker's choice, never a notice.
 */
export const colorful = (isTerminal: boolean, env: Record<string, string | undefined> = process.env) =>
  isTerminal && !env.NO_COLOR && env.TERM !== "dumb";

/**
 * Makes every console.log and console.error of this process go through the filter: for a person, or as JSON while
 * `json()` says so (it can change once the command line is read). console.error and console.warn are written to
 * stderr as they are: Bun paints them red on a terminal, and most of what goes there is a notice ("Waiting…", "Your
 * session ends in 2 days"), not a failure. They are written at once (writeSync): a failure printed right before
 * process.exit arrives whole, also through a pipe.
 */
export function guardConsole(json: () => boolean) {
  const clean = (args: unknown[]) => args.map((a) => (json() ? forJson : forPerson)(typeof a === "string" ? a : Bun.inspect(a))).join(" ");
  for (const name of ["log", "info"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => original(clean(args));
  }
  for (const name of ["error", "warn"] as const) console[name] = (...args: unknown[]) => writeStderr(`${clean(args)}\n`);
}

/**
 * Writes to stderr at once, so a failure printed right before process.exit arrives whole, and never throws: a stderr
 * nobody reads any more (EPIPE: `fontego sync 2>&1 | head -1`) drops the text, and one that can't take it now
 * (EAGAIN: a non-blocking pipe that is full) hands it to the stream, which writes it when it can.
 */
export function writeStderr(text: string) {
  try {
    writeSync(2, text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EAGAIN") process.stderr.write(text);
  }
}
