// Arguments left out: a person at a terminal (a pseudo-terminal, through script(1)) picks them from a list and sees
// the whole command afterwards; a script, --json or an agent, even on a terminal, gets the usage line with the values
// known here, and nothing is asked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
/** The variables that tell fontego an agent runs it (agents.ts), all off; CI too, since it would stop the asking */
const NO_AGENT = { FONTEGO_AGENT: "", CLAUDECODE: "", CODEX_THREAD_ID: "", COPILOT_CLI: "", OPENCODE: "", CURSOR_AGENT: "", GEMINI_CLI: "", CI: "" };
const DOWN = "\x1b[B";
const ESC = "\x1b";

let s: TestServer;
let home: string;

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  ...NO_AGENT,
  XDG_CONFIG_HOME: home,
  XDG_CACHE_HOME: home,
  FONTEGO_URL: s.url,
  FONTEGO_TOKEN: s.adminToken,
  FONTEGO_INSTANCE: "",
  FONTEGO_CREDENTIAL_STORE: "file",
  FONTEGO_BROWSER: "none",
  ...extra,
});

const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;

/**
 * Runs fontego in a pseudo-terminal: each step waits for its text to show (after the previous one), then types its
 * keys. Gives everything the terminal showed, without colours or cursor moves, and the exit code.
 */
async function inTerminal(args: string[], steps: [string, string][], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["script", "-qec", ["bun", MAIN, ...args].map(quote).join(" "), "/dev/null"], {
    env: env(extra),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 20_000); // a question nobody answers would wait here
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let shown = "";
  let from = 0;
  let step = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    shown += decoder.decode(value, { stream: true });
    while (step < steps.length) {
      const [waitFor, keys] = steps[step]!;
      const at = plain(shown).indexOf(waitFor, from);
      if (at < 0) break;
      from = at + waitFor.length;
      proc.stdin.write(keys);
      proc.stdin.flush();
      step++;
    }
  }
  const code = await proc.exited;
  clearTimeout(timer);
  return { shown: plain(shown), code, steps: step };
}

async function fontego(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], { env: env(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

const role = async (email: string) => ((await s.call(s.adminToken, "GET", "/v1/workspaces/notes/members")).data.members as any[]).find((m) => m.email === email)?.role;

beforeAll(async () => {
  s = await startTestServer();
  home = tempDir("fontego-ask-home-");
  await s.person("ana@example.org", "Ana");
  await s.person("bruno@example.org", "Bruno");
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "notes", name: "Notes" });
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "plans", name: "Plans" });
});

afterAll(async () => {
  await s.stop();
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("at a terminal, a person picks what they left out", () => {
  test("a declared command: the workspace and the person from the server, the role from its list", async () => {
    const r = await inTerminal(
      ["members", "set"],
      [
        ["WORKSPACE:", `${DOWN}\r`], // notes, plans: the second
        ["EMAIL", "bruno\r"], // typing filters the people
        ["ROLE", "2\r"], // the number next to editor
      ],
    );
    expect(r.steps).toBe(3);
    expect(r.code).toBe(0);
    expect(r.shown).toContain("Plans");
    expect(r.shown).toContain("Same as: fontego members set plans bruno@example.org editor");
    const members = (await s.call(s.adminToken, "GET", "/v1/workspaces/plans/members")).data.members as any[];
    expect(members.find((m) => m.email === "bruno@example.org")?.role).toBe("editor");
  });

  test("Esc cancels, and nothing changes", async () => {
    const r = await inTerminal(["members", "set", "notes"], [["EMAIL", ESC]]);
    expect(r.code).toBe(1);
    expect(r.shown).toContain("Cancelled: nothing changed.");
    expect(await role("ana@example.org")).toBeUndefined();
  });

  test("a built-in command: an alias picked from this machine's list", async () => {
    expect((await fontego(["login", s.url, "--token", s.adminToken, "--alias", "here"], { FONTEGO_URL: "", FONTEGO_TOKEN: "" })).code).toBe(0);
    const r = await inTerminal(["use"], [["ALIAS:", "\r"]], { FONTEGO_URL: "", FONTEGO_TOKEN: "" });
    expect(r.code).toBe(0);
    expect(r.shown).toContain("Same as: fontego use here");
    expect(r.shown).toContain("Commands go to here");
  });

  test("an agent on a terminal is never asked: it gets the usage line", async () => {
    const r = await inTerminal(["members", "set", "notes"], [], { CLAUDECODE: "1" });
    expect(r.code).toBe(1);
    expect(r.shown).not.toContain("↑↓");
    expect(r.shown).toContain("fontego members set WORKSPACE EMAIL ROLE");
  });
});

describe("with nobody to ask", () => {
  test("the usage line says the values a list on this machine allows, and nothing is asked", async () => {
    const r = await fontego(["members", "set", "notes", "ana@example.org", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.out).error;
    expect(e.code).toBe("usage");
    expect(e.message).toBe("fontego members set WORKSPACE EMAIL ROLE ROLE: reader, editor, admin.");
    // A list that needs the server (the people) isn't fetched just to fail.
    expect((await fontego(["members", "set", "notes"])).err).not.toContain("ana@example.org");
  });

  test("help lists a fixed list's values", async () => {
    const r = await fontego(["help", "members", "set"]);
    expect(r.out).toMatch(/ROLE +What they can do there: one of reader, editor, admin/);
  });
});
