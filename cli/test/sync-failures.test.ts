// One path that can't be written here never stops a sync round: the rest comes down and local work goes up. Against a
// server played in memory, which can list what a real one refuses today (links from before its rules, a damaged
// download).

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobHash, type ChangeSetRequest, type ChangeSetResult, type SyncResponse } from "@fontego/core";
import { ClientError, type Client } from "../src/client.ts";
import { SyncEngine } from "../src/sync/engine.ts";
import { insideRoot, UnsafePathError } from "../src/sync/local.ts";
import { newState } from "../src/sync/state.ts";
import { tempDir } from "./server.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A workspace in memory: its files at the head, and what /sync lists since any other commit. */
class FakeServer {
  head = "c1";
  files = new Map<string, { bytes: Uint8Array; mode: string }>();
  /** Bytes /files sends instead of a file's own, to play a damaged download */
  damaged = new Map<string, Uint8Array>();
  /** The order /sync lists changes in (default: the files', then deletes) */
  deletes: string[] = [];
  sent: ChangeSetRequest[] = [];
  /** Answers the next change set with this error instead */
  refuse: ClientError | null = null;

  put(path: string, text: string, mode = "100644") {
    this.files.set(path, { bytes: enc(text), mode });
    this.head = `c${Number(this.head.slice(1)) + 1}`;
  }

  client(): Client {
    const fake = {
      sync: async (_ws: string, since: string | null): Promise<SyncResponse> => {
        if (since === this.head) return { head: this.head, since, reset: false, changes: [] };
        const puts = [...this.files].map(([path, f]) => ({ path, status: "put" as const, hash: blobHash(f.bytes), mode: f.mode as "100644" }));
        const dels = this.deletes.map((path) => ({ path, status: "delete" as const }));
        return { head: this.head, since, reset: false, changes: [...puts, ...dels] };
      },
      file: async (_ws: string, path: string) => {
        const f = this.files.get(path);
        if (!f) throw new ClientError(404, "not_found", `${path} isn't there.`);
        const bytes = this.damaged.get(path) ?? f.bytes;
        return { bytes, hash: blobHash(f.bytes), mode: f.mode, rev: this.head };
      },
      change: async (_ws: string, cs: ChangeSetRequest): Promise<ChangeSetResult> => {
        if (this.refuse) {
          const e = this.refuse;
          this.refuse = null;
          throw e;
        }
        this.sent.push(cs);
        const changes: ChangeSetResult["changes"] = [];
        for (const op of cs.ops) {
          if (op.op !== "put") continue;
          const bytes = op.content !== undefined ? enc(op.content) : new Uint8Array(Buffer.from(op.contentBase64!, "base64"));
          this.files.set(op.path, { bytes, mode: op.mode ?? "100644" });
          changes.push({ status: "put", path: op.path, hash: blobHash(bytes) });
        }
        this.head = `c${Number(this.head.slice(1)) + 1}`;
        return { status: "committed", commit: this.head, parent: null, changes };
      },
      workspace: async () => ({ role: "editor" }),
    };
    return fake as unknown as Client;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

function copy(server: FakeServer) {
  const root = tempDir("fontego-failures-");
  dirs.push(root);
  return new SyncEngine(root, server.client(), newState("http://localhost", "ws", "Ana"));
}

const sentPaths = (server: FakeServer) => server.sent.flatMap((cs) => cs.ops.map((o) => (o.op === "move" ? o.to : o.path)));

describe("one path that can't be written here never stops the round", () => {
  for (const [label, bad, setup] of [
    ["a file where a folder is here", "build", (root: string) => mkdirSync(join(root, "build"))],
    ["a name of more than 255 bytes", `${"中".repeat(100)}.md`, () => {}],
    ["a file inside what is a file here", "notes/a.md", (root: string) => writeFileSync(join(root, "notes"), "a file of mine\n")],
  ] as const) {
    test(`${label}: skipped with its reason, the rest comes down, and local work goes up, every round`, async () => {
      const server = new FakeServer();
      server.put(bad, "theirs\n");
      server.put("zz-good.md", "good\n");
      const A = copy(server);
      setup(A.root);
      writeFileSync(join(A.root, "mine.md"), "my local work\n");
      const r = await A.sync();
      expect(r.skipped.map((s) => s.path)).toEqual([bad]);
      expect(r.skipped[0]!.reason).not.toContain("tried again");
      expect(readFileSync(join(A.root, "zz-good.md"), "utf8")).toBe("good\n");
      expect(sentPaths(server)).toContain("mine.md");
      // The next round goes on as well; the head moved past the path that can't be here.
      server.put("zz-later.md", "later\n");
      const again = await A.sync();
      expect(readFileSync(join(A.root, "zz-later.md"), "utf8")).toBe("later\n");
      expect(again.head).toBe(server.head);
    });
  }

  test("deletes go first: a folder that became a file on the server comes down", async () => {
    const server = new FakeServer();
    server.put("build/x.md", "x\n");
    const A = copy(server);
    await A.sync();
    // On the server, build/x.md went and a file build came; /sync lists the put before the delete.
    server.files.delete("build/x.md");
    server.deletes = ["build/x.md"];
    server.put("build", "now a file\n");
    const r = await A.sync();
    expect(r.skipped).toEqual([]);
    expect(lstatSync(join(A.root, "build")).isFile()).toBe(true);
    expect(readFileSync(join(A.root, "build"), "utf8")).toBe("now a file\n");
  });

  test("one that failed only this once (no permission here) waits, and comes once it can", async () => {
    const server = new FakeServer();
    server.put("locked/a.md", "v1\n");
    const A = copy(server);
    await A.sync();
    server.put("locked/a.md", "v2\n");
    server.put("open.md", "open\n");
    chmodSync(join(A.root, "locked"), 0o555);
    try {
      const r = await A.sync();
      expect(r.skipped.map((s) => s.path)).toEqual(["locked/a.md"]);
      expect(r.skipped[0]!.reason).toContain("tried again next round");
      expect(readFileSync(join(A.root, "open.md"), "utf8")).toBe("open\n");
      expect(A.state.head).not.toBe(server.head); // the copy stays at its last full step
    } finally {
      chmodSync(join(A.root, "locked"), 0o755);
    }
    const later = await A.sync();
    expect(later.skipped).toEqual([]);
    expect(readFileSync(join(A.root, "locked/a.md"), "utf8")).toBe("v2\n");
    expect(A.state.head).toBe(server.head);
  });

  test("a link a workspace holds from before the rules, that could lead out, is never made; the rest comes", async () => {
    const server = new FakeServer();
    server.put("a", ".", "120000");
    server.put("b", "a/..", "120000");
    server.put("c", "/home/ana/.ssh", "120000");
    server.put("d", "..\\secret", "120000");
    server.put("ok.md", "fine\n");
    const A = copy(server);
    const r = await A.sync();
    expect(r.skipped.map((s) => s.path).sort()).toEqual(["b", "c", "d"]);
    expect(lstatSync(join(A.root, "a")).isSymbolicLink()).toBe(true); // harmless alone
    for (const p of ["b", "c", "d"]) expect(existsSync(join(A.root, p))).toBe(false);
    expect(readFileSync(join(A.root, "ok.md"), "utf8")).toBe("fine\n");
    // Nothing of them goes back up as deleted either.
    expect(sentPaths(server)).toEqual([]);
  });
});

describe("what comes down is what the server listed", () => {
  test("a download that doesn't match its hash isn't written: skipped, tried again, and the rest comes", async () => {
    const server = new FakeServer();
    server.put("doc.md", "the real text\n");
    server.put("other.md", "other\n");
    server.damaged.set("doc.md", enc("something else\n"));
    const A = copy(server);
    const r = await A.sync();
    expect(r.skipped).toEqual([{ path: "doc.md", reason: "what came down for doc.md isn't what the server lists; it is tried again next round" }]);
    expect(existsSync(join(A.root, "doc.md"))).toBe(false);
    expect(readFileSync(join(A.root, "other.md"), "utf8")).toBe("other\n");
    server.damaged.clear();
    await A.sync();
    expect(readFileSync(join(A.root, "doc.md"), "utf8")).toBe("the real text\n");
  });

  test("in a conflict too: the edit here stays where it is, and the round goes on", async () => {
    const server = new FakeServer();
    server.put("doc.md", "base\n");
    const A = copy(server);
    await A.sync();
    writeFileSync(join(A.root, "doc.md"), "mine\n");
    writeFileSync(join(A.root, "new.md"), "new here\n");
    server.put("doc.md", "theirs\n");
    server.damaged.set("doc.md", enc("not theirs\n"));
    const theirs = blobHash(enc("theirs\n"));
    server.refuse = new ClientError(409, "conflict", "1 file(s) conflict.", undefined, {
      head: server.head,
      conflicts: [{ path: "doc.md", reason: "merge", currentHash: theirs, message: "doc.md changed on both sides in the same lines." }],
    });
    // The pull doesn't touch doc.md (changed on both sides); the push conflicts, and its download is damaged.
    const r = await A.sync();
    expect(r.skipped.map((s) => s.path)).toContain("doc.md");
    expect(readFileSync(join(A.root, "doc.md"), "utf8")).toBe("mine\n");
    expect(sentPaths(server)).toContain("new.md");
  });
});

describe("names Windows can't hold", () => {
  test("a copy on Windows leaves them out with the reason; elsewhere they are ordinary names", async () => {
    const root = tempDir("fontego-windows-");
    dirs.push(root);
    for (const p of ["CON", "docs/aux.md", "a:b", "what?.md", "notes."]) {
      await expect(insideRoot(root, p, "win32")).rejects.toThrow("isn't a valid name on Windows");
      await expect(insideRoot(root, p, "win32")).rejects.toBeInstanceOf(UnsafePathError);
      await insideRoot(root, p, "linux");
    }
    await insideRoot(root, "docs/console.md", "win32");
  });
});
