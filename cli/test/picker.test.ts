// The pieces that ask a person, without a terminal: which keys arrive, what each does to a list, what it draws, and
// when fontego may ask at all.

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { commandLine } from "../src/ask.ts";
import { whyNotAsked } from "../src/output.ts";
import { askText, choose, drawPicker, fit, matching, pickerKey, readKeys, startPicker, type Key, type PickerState, type Terminal } from "../src/picker.ts";

const SCREEN = { width: 80, height: 24, color: false };
const list = startPicker([
  { value: "notes", label: "Notes · editor" },
  { value: "bakery", label: "The bakery · admin" },
  { value: "plans", label: "Plans for 2027" },
]);

/** Runs keys on a list until one picks or cancels. */
function press(s: PickerState, keys: Key[]) {
  for (const key of keys) {
    const step = pickerKey(s, key);
    if (!("state" in step)) return step;
    s = step.state;
  }
  return { state: s };
}

describe("reading keys", () => {
  test("arrows, Enter, Esc and Ctrl+C, and text pasted at once", () => {
    expect(readKeys("\x1b[A\x1b[B\x1bOB\r")).toEqual([{ name: "up" }, { name: "down" }, { name: "down" }, { name: "enter" }]);
    expect(readKeys("\x1b")).toEqual([{ name: "cancel" }]);
    expect(readKeys("\x03")).toEqual([{ name: "cancel" }]);
    expect(readKeys("añ\x7f")).toEqual([{ name: "char", char: "a" }, { name: "char", char: "ñ" }, { name: "backspace" }]);
    // CR LF from a paste is one Enter; a key this doesn't use (F5) is skipped whole.
    expect(readKeys("x\r\n\x1b[15~")).toEqual([{ name: "char", char: "x" }, { name: "enter" }]);
  });
});

describe("a list to pick from", () => {
  test("the arrows move and wrap around; Enter picks the row under the cursor", () => {
    expect(press(list, [{ name: "down" }, { name: "enter" }])).toEqual({ picked: { value: "bakery", label: "The bakery · admin" } });
    expect(press(list, [{ name: "up" }, { name: "enter" }])).toMatchObject({ picked: { value: "plans" } });
  });

  test("typing filters by what a row says, or by its number", () => {
    const typed = (text: string) => ({ ...list, query: text });
    expect(matching(typed("BAK"))).toEqual([1]);
    expect(matching(typed("admin"))).toEqual([1]);
    expect(matching(typed("2"))).toEqual([1, 2]); // number 2, and "2027"
    expect(press(list, [{ name: "char", char: "3" }, { name: "enter" }])).toMatchObject({ picked: { value: "plans" } });
    expect(press(list, [{ name: "char", char: "z" }, { name: "enter" }])).toMatchObject({ state: { query: "z" } }); // nothing to pick
    expect(press(list, [{ name: "char", char: "z" }, { name: "backspace" }, { name: "enter" }])).toMatchObject({ picked: { value: "notes" } });
  });

  test("Esc cancels", () => {
    expect(press(list, [{ name: "down" }, { name: "cancel" }])).toEqual({ cancelled: true });
  });

  test("it draws a title, numbered rows with the cursor, and the keys; never wider than the screen", () => {
    const lines = drawPicker({ ...list, cursor: 1 }, "WORKSPACE:", SCREEN);
    expect(lines).toEqual([
      "WORKSPACE:",
      "  1  notes   Notes · editor",
      "› 2  bakery  The bakery · admin",
      "  3  plans   Plans for 2027",
      "  ↑↓ move · type to filter · enter picks · esc cancels",
    ]);
    const narrow = drawPicker(list, "WORKSPACE:", { ...SCREEN, width: 24 });
    for (const line of narrow) expect([...line].length).toBeLessThanOrEqual(23);
    expect(drawPicker({ ...list, query: "zz" }, "WORKSPACE:", SCREEN)[1]).toBe('  Nothing matches "zz".');
    expect(fit("abcdef", 4)).toBe("abc…");
  });

  test("a long list shows the rows around the cursor, and how many there are", () => {
    const long = startPicker(Array.from({ length: 40 }, (_, i) => ({ value: `ws-${i + 1}` })));
    const lines = drawPicker({ ...long, cursor: 30 }, "WORKSPACE:", SCREEN);
    expect(lines.length).toBe(12);
    expect(lines.some((l) => l.startsWith("› 31  ws-31"))).toBe(true);
    expect(lines.at(-1)).toContain("40 rows");
  });
});

describe("when fontego may ask", () => {
  const tty = { stdin: true, stderr: true };
  test("only a person at a terminal: never with --json, without a terminal, in CI, with FONTEGO_NO_INPUT or under an agent", () => {
    expect(whyNotAsked(false, {}, tty)).toBeNull();
    expect(whyNotAsked(true, {}, tty)).toBe("--json");
    expect(whyNotAsked(false, {}, { stdin: true, stderr: false })).toBe("not a terminal");
    expect(whyNotAsked(false, { CI: "true" }, tty)).toBe("CI");
    expect(whyNotAsked(false, { CI: "false" }, tty)).toBeNull();
    expect(whyNotAsked(false, { FONTEGO_NO_INPUT: "1" }, tty)).toBe("FONTEGO_NO_INPUT=1");
    expect(whyNotAsked(false, { CLAUDECODE: "1" }, tty)).toBe("claude-code runs it");
  });
});

describe("the command written back", () => {
  const members = {
    name: "members set",
    summary: "",
    group: "",
    args: [{ name: "WORKSPACE" }, { name: "EMAIL" }, { name: "ROLE" }],
    flags: [{ name: "note", type: "string" as const, description: "" }, { name: "quiet", type: "boolean" as const, description: "" }],
  };
  test("its words, its arguments quoted for a shell, the flags given and --instance", () => {
    const parsed = { args: { WORKSPACE: "notes", EMAIL: "ana@example.org", ROLE: "editor" }, flags: { note: "it's done", quiet: true } };
    expect(commandLine(members, parsed, "casa")).toBe(`fontego members set notes ana@example.org editor --note 'it'\\''s done' --quiet --instance casa`);
  });
  test("never a secret, nor what comes from stdin", () => {
    const set = { name: "admin settings set", summary: "", group: "", args: [{ name: "KEY" }, { name: "VALUE", secret: true }] };
    expect(commandLine(set, { args: { KEY: "smtp.password", VALUE: "hunter2" }, flags: {} })).toBe("fontego admin settings set smtp.password");
  });
});

/**
 * A terminal in memory: keys go in through `type`, and what fontego writes lands on a screen that understands the
 * few sequences it uses (cursor up, carriage return, clear to the end, backspace), so a test sees what a person would.
 */
function fakeTerminal(env: Record<string, string> = {}) {
  const input = Object.assign(new EventEmitter(), { setRawMode: () => input, setEncoding: () => input, resume: () => input, pause: () => input });
  const screen: string[] = [""];
  let row = 0;
  let col = 0;
  const write = (text: string) => {
    for (let i = 0; i < text.length; ) {
      const seq = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i));
      if (seq) {
        if (seq[2] === "A") row -= Number(seq[1] || 1);
        if (seq[2] === "J") {
          screen[row] = screen[row]!.slice(0, col);
          screen.length = row + 1;
        }
        i += seq[0].length;
        continue;
      }
      const ch = text[i++]!;
      if (ch === "\r") col = 0;
      else if (ch === "\n") screen[++row] ??= "";
      else if (ch === "\b") col = Math.max(0, col - 1);
      else {
        const line = screen[row]!.padEnd(col);
        screen[row] = line.slice(0, col) + ch + line.slice(col + 1);
        col++;
      }
    }
    return true;
  };
  const output = Object.assign(new EventEmitter(), { write, columns: 80, rows: 24 });
  const term = { input, output, env } as unknown as Terminal;
  const type = async (...chunks: string[]) => {
    for (const c of chunks) {
      await Bun.sleep(1);
      input.emit("data", c);
    }
  };
  return { term, type, screen };
}

describe("on a terminal", () => {
  test("the list redraws in place, and once picked only the answer stays", async () => {
    const t = fakeTerminal();
    const picked = choose("WORKSPACE:", list.choices, t.term);
    await t.type("\x1b[B");
    expect(t.screen).toEqual(drawPicker({ ...list, cursor: 1 }, "WORKSPACE:", { width: 80, height: 24, color: true }).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")));
    await t.type("pl");
    expect(t.screen.length).toBe(3); // the title, one row, the keys
    await t.type("\r");
    expect((await picked).value).toBe("plans");
    expect(t.screen).toEqual(["WORKSPACE: plans", ""]);
  });

  test("typing a line: backspace, and Esc cancels", async () => {
    const t = fakeTerminal();
    const typed = askText("EMAIL", { term: t.term });
    await t.type("bruno@x", "\x7f", "y.org\r");
    expect(await typed).toBe("bruno@y.org");
    expect(t.screen).toEqual(["EMAIL: bruno@y.org", ""]);
    const u = fakeTerminal();
    const cancelled = askText("EMAIL", { term: u.term });
    await u.type("ana\x1b");
    await expect(cancelled).rejects.toThrow("Cancelled: nothing changed.");
  });

  test("what a server wrote can't act on the terminal nor pose as another line: choices, titles and labels", async () => {
    const evil = "a\u001b]52;c;aGk=\u0007b\r\n  2) safe";
    const unsafe = /[\u0000-\u0009\u000b-\u001f\u0080-\u009f]|\n/;
    const drawn = drawPicker(startPicker([{ value: evil, label: evil }, { value: "safe" }]), evil, SCREEN);
    expect(drawn).toHaveLength(4);
    for (const line of drawn) expect(line).not.toMatch(unsafe);
    const dumb = fakeTerminal({ TERM: "dumb" });
    const picked = choose(evil, [{ value: evil }], dumb.term);
    await dumb.type("1\r");
    // What is picked is the value itself; only how it shows changes
    expect((await picked).value).toBe(evil);
    expect(dumb.screen.join("")).not.toContain("\u001b]52");
    const t = fakeTerminal();
    const typed = askText(evil, { term: t.term });
    await t.type("x\r");
    expect(await typed).toBe("x");
    expect(t.screen.join("")).not.toContain("\u001b]52");
  });

  test("a secret shows nothing of what is typed", async () => {
    const t = fakeTerminal();
    const typed = askText("VALUE", { term: t.term, hidden: true });
    await t.type("hunter2\r");
    expect(await typed).toBe("hunter2");
    expect(t.screen.join("\n")).not.toContain("hunter2");
  });
});
