// What reaches the terminal: text written by other people or by a server never carries control characters to it.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ChangeSetBody, CreateWorkspaceBody, FolderDescriptionBody, UpdateMeBody } from "@fontego/core";
import { forJson, forPerson } from "../src/terminal.ts";
import { onTerminal } from "./pty.ts";
import { tempDir } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
// Sets the clipboard (OSC 52), clears the screen, a one-byte CSI (C1) and a right-to-left override.
const EVIL = "bad\u001b]52;c;Y3VybCB4fHNo\u0007 news\u001b[2J\u009b31m\u202etxt.exe\rFAKE";
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

describe("the filter", () => {
  test("for a person, control characters show as �; tabs, newlines and line ends stay", () => {
    expect(forPerson("a\tb\r\nc\n")).toBe("a\tb\r\nc\n");
    expect(forPerson(EVIL)).toBe("bad�]52;c;Y3VybCB4fHNo� news�[2J�31m�txt.exe�FAKE");
  });

  test("in JSON they become \\u escapes: the same JSON, and nothing for the terminal", () => {
    const json = forJson(JSON.stringify({ message: EVIL }));
    expect(json).not.toMatch(CONTROLS);
    expect(JSON.parse(json).message).toBe(EVIL);
  });
});

describe("a server's words on the terminal", () => {
  test("an error message and hint from the server arrive without control characters, as text and as JSON", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error: { code: "down", message: EVIL, hint: `Run${EVIL}` } }, { status: 503 }),
    });
    try {
      const home = tempDir("fontego-terminal-");
      const run = async (args: string[]) => {
        const proc = Bun.spawn([process.execPath, MAIN, ...args], {
          env: {
            PATH: process.env.PATH!,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_CACHE_HOME: join(home, ".cache"),
            FONTEGO_URL: `http://127.0.0.1:${server.port}`,
            FONTEGO_TOKEN: "t",
            FONTEGO_CREDENTIAL_STORE: "file",
            FONTEGO_BROWSER: "none",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { out, err };
      };

      const text = await run(["workspaces"]);
      expect(text.err).toContain("bad�]52;c;");
      expect(text.err).not.toMatch(CONTROLS);

      const json = await run(["workspaces", "--json"]);
      expect(json.out).not.toMatch(CONTROLS);
      expect(JSON.parse(json.out).error.message).toBe(EVIL);
    } finally {
      server.stop(true);
    }
  });
});

describe("colour on a terminal", () => {
  /** Something that answers like a Fontego: who it is, and 404 to everything else */
  const fake = () =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const base = new URL(req.url).origin;
        if (new URL(req.url).pathname === "/v1/instance") {
          return Response.json({ name: "Fake", software: "fontego", version: "1", oauth: { authorizationEndpoint: `${base}/oauth/authorize`, clientId: "fontego-cli" } });
        }
        return Response.json({ error: { code: "not_found", message: "No workspace \"nope\" for you.", hint: "Run fontego workspaces." } }, { status: 404 });
      },
    });
  const env = (home: string, extra: Record<string, string | undefined> = {}) => ({
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    FONTEGO_CREDENTIAL_STORE: "file",
    FONTEGO_BROWSER: "none",
    ...extra,
  });
  const RED = "\x1b[31m";

  test("a notice on stderr, such as signing in, isn't red: it isn't a failure", async () => {
    const server = fake();
    try {
      const r = await onTerminal(["login", `http://127.0.0.1:${server.port}`], env(tempDir("fontego-colour-")), { until: /Waiting/ });
      expect(r.text).toContain("Open this link in your browser to sign in to Fake");
      expect(r.text).not.toContain("\x1b[");
    } finally {
      server.stop(true);
    }
  });

  test("a failure has its label red, and only that; never with NO_COLOR or a TERM that draws none", async () => {
    const server = fake();
    try {
      const url = { FONTEGO_URL: `http://127.0.0.1:${server.port}`, FONTEGO_TOKEN: "t" };
      const home = tempDir("fontego-colour-");
      const r = await onTerminal(["info", "nope"], env(home, url));
      expect(r.code).toBe(3);
      expect(r.text).toContain(`${RED}error:\x1b[39m No workspace "nope" for you.\r\nhint: Run fontego workspaces.`);
      expect(r.text.split(RED).length).toBe(2);
      for (const plain of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
        const p = await onTerminal(["info", "nope"], env(home, { ...url, ...plain }));
        expect(p.text).toContain('error: No workspace "nope" for you.');
        expect(p.text).not.toContain("\x1b[");
      }
    } finally {
      server.stop(true);
    }
  });
});

describe("stderr nobody reads", () => {
  test("a failure whose stderr was closed still leaves with its exit code, not a crash (2>&1 | head)", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { code: "not_found", message: "No." } }, { status: 404 }) });
    try {
      const home = tempDir("fontego-epipe-");
      // The reader is gone before fontego writes: its write gets EPIPE
      const script = `{ sleep 0.3; "${process.execPath}" "${MAIN}" info nope; } 2>&1 >/dev/null | true; exit \${PIPESTATUS[0]}`;
      const proc = Bun.spawn(["bash", "-c", script], {
        env: { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), FONTEGO_URL: `http://127.0.0.1:${server.port}`, FONTEGO_TOKEN: "t" },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await proc.exited).toBe(3);
    } finally {
      server.stop(true);
    }
  });
});

describe("what the API takes", () => {
  test("names and other one-line fields take no control characters, tabs or line breaks; messages take lines", () => {
    expect(UpdateMeBody.safeParse({ name: "Ana Pérez" }).success).toBe(true);
    for (const name of [EVIL, "Ana\nPérez", "Ana\tPérez", "Ana\u202ePérez", "Ana\u0085"]) {
      expect(UpdateMeBody.safeParse({ name }).success).toBe(false);
      expect(CreateWorkspaceBody.safeParse({ slug: "demo", name }).success).toBe(false);
      expect(FolderDescriptionBody.safeParse({ description: name }).success).toBe(false);
    }
    const op = { op: "delete", path: "a.md", baseHash: "0".repeat(40) };
    expect(ChangeSetBody.safeParse({ message: "Fix\n\nWhy:\r\n- a\tb", ops: [op] }).success).toBe(true);
    expect(ChangeSetBody.safeParse({ message: EVIL, ops: [op] }).success).toBe(false);
  });
});
