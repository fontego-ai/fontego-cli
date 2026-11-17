import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, tempDir, type TestServer } from "./server.ts";
import { Client, ClientError } from "../src/client.ts";
import { localStatus, SyncEngine } from "../src/sync/engine.ts";
import { isConflictCopy } from "../src/sync/local.ts";
import { newState, saveState } from "../src/sync/state.ts";
import { acquireLock, LockedError, Watcher } from "../src/sync/watch.ts";

let s: TestServer;
let ana: { token: string; id: number };
let bea: { token: string; id: number };
let carl: { token: string; id: number };
const dirs: string[] = [];

async function copy(token: string, user: string, ws = "team"): Promise<SyncEngine> {
  const dir = tempDir(`fontego-sync-${user}-`);
  dirs.push(dir);
  const state = newState(s.url, ws, user);
  await saveState(dir, state);
  const engine = new SyncEngine(dir, new Client(s.url, token), state);
  await engine.sync();
  return engine;
}

const read = (e: SyncEngine, p: string) => readFileSync(join(e.root, p), "utf8");
const write = (e: SyncEngine, p: string, text: string) => {
  mkdirSync(join(e.root, p, ".."), { recursive: true });
  writeFileSync(join(e.root, p), text);
};
const DOC = "one\ntwo\nthree\nfour\nfive\n";

beforeAll(async () => {
  s = await startTestServer();
  ana = await s.person("ana@example.org", "Ana");
  bea = await s.person("bea@example.org", "Bea");
  carl = await s.person("carl@example.org", "Carl");
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "team" });
  for (const [who, role] of [["ana", "editor"], ["bea", "editor"], ["carl", "reader"]]) {
    await s.call(s.adminToken, "PUT", `/v1/workspaces/team/members/${who}@example.org`, { role });
  }
  await s.call(ana.token, "POST", "/v1/workspaces/team/changes", {
    baseCommit: null,
    ops: [
      { op: "put", path: "doc.md", content: DOC, baseHash: null },
      { op: "put", path: "notes/old.md", content: "old\n", baseHash: null },
    ],
  });
});
afterAll(async () => {
  await s.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("sync between two copies", () => {
  let A: SyncEngine;
  let B: SyncEngine;

  test("a clone brings every file", async () => {
    A = await copy(ana.token, "Ana");
    B = await copy(bea.token, "Bea");
    expect(read(A, "doc.md")).toBe(DOC);
    expect(read(B, "notes/old.md")).toBe("old\n");
    expect(existsSync(join(A.root, ".fontego/state.json"))).toBe(true);
  });

  test("an edit and a new file travel from A to B", async () => {
    write(A, "doc.md", DOC + "six\n");
    write(A, "ideas/new.md", "# New\n");
    expect((await localStatus(A.root, A.state)).modified).toEqual(["doc.md"]);
    const up = await A.sync();
    expect(up.pushed.map((p) => p.path).sort()).toEqual(["doc.md", "ideas/new.md"]);
    const down = await B.sync();
    expect(down.pulled.map((p) => p.path).sort()).toEqual(["doc.md", "ideas/new.md"]);
    expect(read(B, "doc.md")).toBe(DOC + "six\n");
    expect((await localStatus(B.root, B.state)).modified).toEqual([]);
  });

  test("a delete travels and empty folders go with it", async () => {
    unlinkSync(join(B.root, "notes/old.md"));
    await B.sync();
    await A.sync();
    expect(existsSync(join(A.root, "notes/old.md"))).toBe(false);
    expect(existsSync(join(A.root, "notes"))).toBe(false);
  });

  test("edits to different lines of the same file are merged", async () => {
    const base = read(A, "doc.md");
    write(A, "doc.md", base.replace("one", "ONE"));
    write(B, "doc.md", base.replace("five", "FIVE"));
    await A.sync();
    const r = await B.sync();
    expect(r.pushed).toEqual([{ path: "doc.md", status: "put", merged: true }]);
    const merged = base.replace("one", "ONE").replace("five", "FIVE");
    expect(read(B, "doc.md")).toBe(merged);
    await A.sync();
    expect(read(A, "doc.md")).toBe(merged);
  });

  test("the same lines changed on both sides: keep both, nothing lost", async () => {
    const base = read(A, "doc.md");
    write(A, "doc.md", base.replace("three", "three by Ana"));
    write(B, "doc.md", base.replace("three", "three by Bea"));
    await A.sync();
    const r = await B.sync();
    expect(r.conflicts).toHaveLength(1);
    const copyPath = r.conflicts[0]!.copy!;
    expect(isConflictCopy(copyPath)).toBe(true);
    expect(copyPath).toContain("conflict Bea");
    expect(read(B, "doc.md")).toContain("three by Ana");
    expect(read(B, copyPath)).toContain("three by Bea");
    // The copy is shared too, so Ana sees there's something to merge.
    await A.sync();
    expect(read(A, copyPath)).toContain("three by Bea");
    // Bea merges by hand and removes the copy.
    write(B, "doc.md", read(B, "doc.md").replace("three by Ana", "three by Ana and Bea"));
    unlinkSync(join(B.root, copyPath));
    await B.sync();
    await A.sync();
    expect(read(A, "doc.md")).toContain("three by Ana and Bea");
    expect(existsSync(join(A.root, copyPath))).toBe(false);
  });

  test("edited here, deleted there: the edit survives", async () => {
    write(A, "keep.md", "v1\n");
    await A.sync();
    await B.sync();
    unlinkSync(join(A.root, "keep.md"));
    await A.sync();
    write(B, "keep.md", "v2 edited by Bea\n");
    const r = await B.sync();
    expect(r.pushed.map((p) => p.path)).toContain("keep.md");
    await A.sync();
    expect(read(A, "keep.md")).toBe("v2 edited by Bea\n");
  });

  test("deleted here, edited there: the newer content comes back", async () => {
    write(A, "edit-wins.md", "v1\n");
    await A.sync();
    await B.sync();
    write(A, "edit-wins.md", "v2 by Ana\n");
    await A.sync();
    unlinkSync(join(B.root, "edit-wins.md"));
    const r = await B.sync();
    expect(read(B, "edit-wins.md")).toBe("v2 by Ana\n");
    expect(r.conflicts.length + r.pulled.length).toBeGreaterThan(0);
  });

  test("secrets are skipped and the rest still goes up", async () => {
    write(B, ".env", "API_KEY=1234\n");
    write(B, "fine.md", "fine\n");
    const r = await B.sync();
    expect(r.skipped.map((x) => x.path)).toEqual([".env"]);
    expect(r.pushed.map((p) => p.path)).toEqual(["fine.md"]);
    const again = await B.sync();
    expect(again.pushed).toEqual([]);
    expect((await localStatus(B.root, B.state)).skipped[".env"]).toBeDefined();
  });

  test("symlinks, executables and binaries round-trip", async () => {
    write(A, "AGENTS.md", "# Rules\n");
    symlinkSync("AGENTS.md", join(A.root, "CLAUDE.md"));
    write(A, "tools/run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(A.root, "tools/run.sh"), 0o755);
    writeFileSync(join(A.root, "logo.bin"), new Uint8Array([0, 255, 1, 2, 0]));
    await A.sync();
    await B.sync();
    expect(lstatSync(join(B.root, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(B.root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(lstatSync(join(B.root, "tools/run.sh")).mode & 0o111).toBeGreaterThan(0);
    expect([...readFileSync(join(B.root, "logo.bin"))]).toEqual([0, 255, 1, 2, 0]);
  });

  test("a reader gets everything but sends nothing", async () => {
    const C = await copy(carl.token, "Carl");
    expect(read(C, "fine.md")).toBe("fine\n");
    write(C, "fine.md", "carl tried\n");
    const r = await C.sync();
    expect(r.readOnly).toBe(true);
    expect(r.pending).toBe(1);
    await A.sync();
    expect(read(A, "fine.md")).toBe("fine\n");
  });

  test("one watcher per folder", async () => {
    const release = await acquireLock(A.root);
    // the same process may re-take it; another live pid may not
    writeFileSync(join(A.root, ".fontego/lock"), String(process.ppid));
    await expect(acquireLock(A.root)).rejects.toBeInstanceOf(LockedError);
    await release();
  });

  test("watchers keep both copies in step within seconds", async () => {
    const wa = new Watcher(A, new Client(s.url, ana.token), { debounceMs: 200, safetyMs: 60_000 });
    const wb = new Watcher(B, new Client(s.url, bea.token), { debounceMs: 200, safetyMs: 60_000 });
    await wa.start();
    await wb.start();
    await Bun.sleep(300); // let both event streams connect
    const t0 = Date.now();
    write(A, "live/from-ana.md", "hello Bea\n");
    while (!existsSync(join(B.root, "live/from-ana.md")) && Date.now() - t0 < 10_000) await Bun.sleep(100);
    expect(read(B, "live/from-ana.md")).toBe("hello Bea\n");
    expect(Date.now() - t0).toBeLessThan(10_000);
    await wa.stop();
    await wb.stop();
  });

  test("a watcher whose session ends waits, and carries on once its person signs in again", async () => {
    // A credential that stops working, as a session that ended; signing in again gives a new one.
    let current = "fontego_at_ended";
    let signedInAgain = false;
    const auth = {
      token: async () => current,
      recover: async () => {
        if (!signedInAgain) throw new ClientError(401, "session_ended", "Your session on test ended.", "Sign in again: fontego login test");
        current = ana.token;
      },
    };
    const errors: string[] = [];
    const client = new Client(s.url, auth);
    const engine = new SyncEngine(A.root, client, A.state); // the engine and the watcher share it, as in fontego watch
    const w = new Watcher(engine, client, { debounceMs: 200, safetyMs: 400, onError: (e) => errors.push(e.message) });
    await w.start(); // signed out: it waits instead of failing
    write(A, "paused/note.md", "written while signed out\n");
    await Bun.sleep(600);
    expect(errors.some((m) => m.includes("session on test ended"))).toBe(true);
    signedInAgain = true;
    const t0 = Date.now();
    let synced = false;
    while (!synced && Date.now() - t0 < 10_000) {
      await Bun.sleep(200);
      synced = (await s.call(ana.token, "GET", "/v1/workspaces/team/files/paused/note.md")).status === 200;
    }
    await w.stop();
    expect(synced).toBe(true);
  });

  test("a watcher started while the server is down waits, then catches up", async () => {
    await s.pause();
    const errors: string[] = [];
    const w = new Watcher(A, new Client(s.url, ana.token), { debounceMs: 200, safetyMs: 500, onError: (e) => errors.push(e.message) });
    await w.start(); // no server: it keeps watching instead of failing
    write(A, "offline/note.md", "written offline\n");
    await Bun.sleep(400);
    await s.resume();
    const t0 = Date.now();
    let synced = false;
    while (!synced && Date.now() - t0 < 15_000) {
      await Bun.sleep(200);
      synced = (await s.call(ana.token, "GET", "/v1/workspaces/team/files/offline/note.md")).status === 200;
    }
    await w.stop();
    expect(errors.some((m) => m.includes("Can't reach"))).toBe(true);
    expect(synced).toBe(true);
  });
});
