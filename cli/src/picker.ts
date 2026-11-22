// Asking a person at a terminal: picking one value from a list, or typing one. Only for a person (canAsk, in
// output.ts); everyone else passes the value on the command line, and is never asked.
//
// The list: the arrow keys move, typing filters (by what each row says, or by the number next to it), Enter picks,
// Esc or Ctrl+C cancels. What it does with each key and what it draws are plain functions (pickerKey, drawPicker), so
// tests need no terminal; choose() only wires them to the keyboard and to stderr, where questions go, so a command's
// output stays clean on stdout. A terminal that can't move the cursor (TERM=dumb) gets a numbered list instead.

import { UsageError } from "./args.ts";

export interface Choice {
  value: string;
  /** What a person reads next to the value */
  label?: string;
}

type Action = "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | "enter" | "cancel" | "backspace" | "clear";

export type Key = { name: Action } | { name: "char"; char: string };

const SEQUENCES: [string, Action][] = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[5~", "pageUp"],
  ["\x1b[6~", "pageDown"],
  ["\x1b[H", "home"],
  ["\x1bOH", "home"],
  ["\x1b[1~", "home"],
  ["\x1b[F", "end"],
  ["\x1bOF", "end"],
  ["\x1b[4~", "end"],
];

const CONTROL: Record<string, Action> = {
  "\r": "enter",
  "\n": "enter",
  "\x04": "enter",
  "\x03": "cancel",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x15": "clear",
  "\x10": "up",
  "\x0e": "down",
};

/** The keys in what the terminal sent: one key, or several at once when text is pasted. */
export function readKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      const known = SEQUENCES.find(([seq]) => chunk.startsWith(seq, i));
      if (known) {
        keys.push({ name: known[1] });
        i += known[0].length;
        continue;
      }
      const csi = /^\x1b[[O][0-9;]*[\x40-\x7e]/.exec(chunk.slice(i));
      if (csi) {
        i += csi[0].length; // a key this doesn't use (F1, the mouse...)
        continue;
      }
      keys.push({ name: "cancel" }); // Esc on its own
      i++;
      continue;
    }
    const ch = String.fromCodePoint(chunk.codePointAt(i)!);
    i += ch.length;
    if (ch === "\r" && chunk[i] === "\n") i++;
    const control = CONTROL[ch];
    if (control) keys.push({ name: control });
    else if (ch >= " ") keys.push({ name: "char", char: ch });
  }
  return keys;
}

// --- Picking one value from a list ---

export interface PickerState {
  choices: Choice[];
  query: string;
  /** Position in the rows that match the query */
  cursor: number;
}

export const startPicker = (choices: Choice[]): PickerState => ({ choices, query: "", cursor: 0 });

/** The rows that match what was typed: their text, or the number shown next to them. */
export function matching(s: PickerState): number[] {
  const q = s.query.trim().toLowerCase();
  const all = s.choices.map((_, i) => i);
  if (!q) return all;
  return all.filter((i) => {
    const c = s.choices[i]!;
    return String(i + 1) === q || c.value.toLowerCase().includes(q) || (c.label ?? "").toLowerCase().includes(q);
  });
}

export type PickerStep = { state: PickerState } | { picked: Choice } | { cancelled: true };

export function pickerKey(s: PickerState, key: Key, pageSize = 10): PickerStep {
  const rows = matching(s);
  const move = (cursor: number): PickerStep => ({ state: { ...s, cursor } });
  const clamp = (n: number) => Math.max(0, Math.min(rows.length - 1, n));
  switch (key.name) {
    case "cancel":
      return { cancelled: true };
    case "enter":
      return rows.length ? { picked: s.choices[rows[Math.min(s.cursor, rows.length - 1)]!]! } : { state: s };
    case "up":
      return move(rows.length ? (s.cursor - 1 + rows.length) % rows.length : 0);
    case "down":
      return move(rows.length ? (s.cursor + 1) % rows.length : 0);
    case "pageUp":
      return move(clamp(s.cursor - pageSize));
    case "pageDown":
      return move(clamp(s.cursor + pageSize));
    case "home":
      return move(0);
    case "end":
      return move(clamp(rows.length - 1));
    case "backspace":
      return { state: { ...s, query: [...s.query].slice(0, -1).join(""), cursor: 0 } };
    case "clear":
      return { state: { ...s, query: "", cursor: 0 } };
    case "char":
      return { state: { ...s, query: s.query + key.char, cursor: 0 } };
  }
}

export interface Screen {
  width: number;
  height: number;
  color: boolean;
}

/** Cuts a line to the terminal's width, so it never wraps (the list redraws itself line by line). */
export function fit(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

/** What the list looks like now: a title line, the rows that fit around the cursor, and a line of keys. */
export function drawPicker(s: PickerState, title: string, screen: Screen): string[] {
  const rows = matching(s);
  const width = Math.max(20, screen.width - 1);
  const room = Math.max(3, Math.min(10, screen.height - 3));
  const top = Math.max(0, Math.min(s.cursor - Math.floor(room / 2), rows.length - room));
  const shown = rows.slice(top, top + room);
  const numberWidth = String(s.choices.length).length;
  const valueWidth = Math.max(...shown.map((i) => s.choices[i]!.value.length), 0);
  const bold = (t: string) => (screen.color ? `\x1b[1m${t}\x1b[22m` : t);
  const dim = (t: string) => (screen.color ? `\x1b[2m${t}\x1b[22m` : t);

  const lines = [fit(`${title}${s.query ? `  ${s.query}` : ""}`, width)];
  if (!rows.length) lines.push(fit(`  Nothing matches "${s.query}".`, width));
  for (const [n, i] of shown.entries()) {
    const c = s.choices[i]!;
    const here = top + n === s.cursor;
    const text = fit(`${here ? "›" : " "} ${String(i + 1).padStart(numberWidth)}  ${c.value.padEnd(valueWidth)}${c.label ? `  ${c.label}` : ""}`, width);
    lines.push(here ? bold(text) : text);
  }
  const more = rows.length > shown.length ? `${rows.length} rows · ` : "";
  lines.push(dim(fit(`  ${more}↑↓ move · type to filter · enter picks · esc cancels`, width)));
  return lines;
}

// --- On a real terminal ---

export interface Terminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
}

const defaultTerminal = (): Terminal => ({ input: process.stdin, output: process.stderr, env: process.env });

interface KeyLoop<T> {
  /** Draws the first time, once the terminal is in raw mode (so nothing typed meanwhile is echoed) */
  start(): void;
  /** What the keys do: { done } ends the loop */
  onKeys(keys: Key[]): { done: T } | null;
  onResize?(): void;
}

/** Reads keys from the terminal until the loop is done, with the terminal in raw mode meanwhile. */
function withKeys<T>(term: Terminal, loop: KeyLoop<T>): Promise<T> {
  const { input, output } = term;
  return new Promise<T>((resolve, reject) => {
    const finish = (fn: () => void) => {
      input.off("data", onData);
      output.off("resize", resized);
      input.setRawMode(false);
      input.pause();
      fn();
    };
    const onData = (chunk: string) => {
      try {
        const step = loop.onKeys(readKeys(chunk));
        if (step) finish(() => resolve(step.done));
      } catch (e) {
        finish(() => reject(e));
      }
    };
    const resized = () => loop.onResize?.();
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    output.on("resize", resized);
    loop.start();
    input.resume();
  });
}

const cancelled = () => new UsageError("Cancelled: nothing changed.");

/** Lets a person pick one of the choices; Esc or Ctrl+C cancels (a UsageError: nothing changed). */
export async function choose(title: string, choices: Choice[], term: Terminal = defaultTerminal()): Promise<Choice> {
  if (!choices.length) throw new UsageError(`${title} There is nothing to pick from.`);
  if (term.env.TERM === "dumb") return chooseByNumber(title, choices, term);
  const { output } = term;
  const screen = (): Screen => ({
    width: output.columns || 80,
    height: output.rows || 24,
    color: !term.env.NO_COLOR && term.env.TERM !== "dumb",
  });
  let state = startPicker(choices);
  let drawn = 0;
  const draw = () => {
    const lines = drawPicker(state, title, screen());
    // Back to where the list starts, then down over it: the cursor stays at the end of the last line.
    output.write(`${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\r\x1b[J${lines.join("\r\n")}`);
    drawn = lines.length;
  };
  try {
    const picked = await withKeys<Choice | null>(term, {
      start() {
        output.write("\x1b[?25l");
        draw();
      },
      onKeys(keys) {
        for (const key of keys) {
          const step = pickerKey(state, key);
          if ("cancelled" in step) return { done: null };
          if ("picked" in step) return { done: step.picked };
          state = step.state;
        }
        draw();
        return null;
      },
      onResize: draw,
    });
    // The list goes away, and what was picked stays on screen.
    output.write(`${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\r\x1b[J${fit(`${title} ${picked?.value ?? "(cancelled)"}`, screen().width - 1)}\r\n`);
    if (!picked) throw cancelled();
    return picked;
  } finally {
    output.write("\x1b[?25h");
  }
}

/** The list for a terminal that can't redraw: numbered rows, then the number (or the value itself) typed in. */
async function chooseByNumber(title: string, choices: Choice[], term: Terminal): Promise<Choice> {
  term.output.write(`${title}\n${choices.map((c, i) => `  ${i + 1}) ${c.value}${c.label ? `  ${c.label}` : ""}`).join("\n")}\n`);
  const answer = (await askText("Number", { term })).trim();
  const n = Number(answer);
  const picked = Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : choices.find((c) => c.value === answer);
  if (!picked) throw new UsageError(`"${answer}" isn't one of the ${choices.length} listed.`);
  return picked;
}

// --- Typing a value ---

export interface TextOptions {
  /** Shows nothing of what is typed: a secret */
  hidden?: boolean;
  term?: Terminal;
}

/** One line typed at the terminal. Esc or Ctrl+C cancels; an empty answer is a UsageError (nothing changed). */
export async function askText(label: string, opts: TextOptions = {}): Promise<string> {
  const term = opts.term ?? defaultTerminal();
  const { output } = term;
  let typed = "";
  const value = await withKeys<string | null>(term, {
    start: () => output.write(opts.hidden ? `${label} (not shown): ` : `${label}: `),
    onKeys(keys) {
      for (const key of keys) {
        if (key.name === "enter") return { done: typed };
        if (key.name === "cancel") return { done: null };
        if (key.name === "backspace" && typed) {
          typed = [...typed].slice(0, -1).join("");
          if (!opts.hidden) output.write("\b \b");
        } else if (key.name === "clear") {
          if (!opts.hidden) output.write("\b \b".repeat([...typed].length));
          typed = "";
        } else if (key.name === "char") {
          typed += key.char;
          if (!opts.hidden) output.write(key.char);
        }
      }
      return null;
    },
  });
  output.write("\r\n");
  if (value === null) throw cancelled();
  if (!value) throw new UsageError("Nothing typed: nothing changed.");
  return value;
}
