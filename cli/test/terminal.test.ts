// What reaches the terminal: text written by other people or by a server never carries control characters to it.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ChangeSetBody, CreateWorkspaceBody, FolderDescriptionBody, UpdateMeBody } from "@fontego/core";
import { forJson, forPerson } from "../src/terminal.ts";
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
