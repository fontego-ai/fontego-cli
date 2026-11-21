// Everything fontego prints goes through one filter (main.ts installs it), because much of what it prints was written by
// other people or by a server: names, commit messages, file names, error messages and hints. In many terminals,
// control characters in that text can clear the screen, fake a line or a prompt, or set the clipboard (OSC 52), and
// the bidi controls reorder what is shown. For a person they become a visible �. JSON escapes most of them already;
// the ones it leaves alone (C1 and the bidi controls) are escaped too, as \u…, which is the same JSON.

/** Control characters but tab and newline, a carriage return that doesn't end a line, and the bidi controls. */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|\r(?!\n)/g;

/** Text for a person: what could act on the terminal shows as �. */
export const forPerson = (text: string) => text.replace(UNSAFE, "\uFFFD");

/** Text that is (or holds) JSON: what could act on the terminal is written as a \u escape. */
export const forJson = (text: string) => text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Whether bytes meant for a terminal could act on it (`fontego cat` of someone else's file). */
export const unsafeForTerminal = (text: string) => new RegExp(UNSAFE.source).test(text);

/**
 * Makes every console.log and console.error of this process go through the filter: for a person, or as JSON while
 * `json()` says so (it can change once the command line is read).
 */
export function guardConsole(json: () => boolean) {
  for (const name of ["log", "error", "warn", "info"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      const clean = json() ? forJson : forPerson;
      original(...args.map((a) => clean(typeof a === "string" ? a : Bun.inspect(a))));
    };
  }
}
