import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { blobHash } from "@fontego/core";
import { startTestServer, tempDir, type TestServer } from "./server.ts";
import { Client, ClientError } from "../src/client.ts";
import { localStatus, SyncEngine } from "../src/sync/engine.ts";
import { isConflictCopy } from "../src/sync/local.ts";
import { loadState, newState, saveState } from "../src/sync/state.ts";
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
    // Not AGENTS.md and CLAUDE.md: only workspace admins write those, and Ana is an editor.
    write(A, "guide.md", "# Guide\n");
    symlinkSync("guide.md", join(A.root, "start-here.md"));
    write(A, "tools/run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(A.root, "tools/run.sh"), 0o755);
    writeFileSync(join(A.root, "logo.bin"), new Uint8Array([0, 255, 1, 2, 0]));
    await A.sync();
    await B.sync();
    expect(lstatSync(join(B.root, "start-here.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(B.root, "start-here.md"))).toBe("guide.md");
    expect(lstatSync(join(B.root, "tools/run.sh")).mode & 0o111).toBeGreaterThan(0);
    expect([...readFileSync(join(B.root, "logo.bin"))]).toEqual([0, 255, 1, 2, 0]);
  });

  test("every byte survives the trip: Latin-1, a BOM, binary without a NUL", async () => {
    const utf8 = new TextEncoder().encode("# Título\n");
    const files: Record<string, Uint8Array> = {
      "bytes/latin1.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]), // "café\n" in Latin-1
      "bytes/bom.md": new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]),
      "bytes/plain.md": utf8,
      "bytes/odd.bin": new Uint8Array([0xff, 0xfe, 0x80, 0x01, 0x7f]),
    };
    mkdirSync(join(A.root, "bytes"), { recursive: true });
    for (const [p, b] of Object.entries(files)) writeFileSync(join(A.root, p), b);
    await A.sync();
    await B.sync();
    for (const [p, b] of Object.entries(files)) {
      const onServer = (await s.call(ana.token, "GET", `/v1/workspaces/team/files/${p}?meta=1`)).data.hash;
      expect([p, onServer]).toEqual([p, blobHash(b)]);
      expect([p, blobHash(new Uint8Array(readFileSync(join(B.root, p))))]).toEqual([p, blobHash(b)]);
    }
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

  test("one fontego per folder: a live holder keeps the lock, a gone one loses it, and only the holder releases it", async () => {
    const lock = join(A.root, ".fontego/lock");
    const release = await acquireLock(A.root);
    // Another live process holds it (here, as an older version wrote it: just the pid): nobody else gets it, and the
    // release of a lock that isn't ours any more leaves it be.
    writeFileSync(lock, String(process.ppid));
    await expect(acquireLock(A.root)).rejects.toBeInstanceOf(LockedError);
    await release();
    expect(existsSync(lock)).toBe(true);
    // Left by a process that is gone: taken.
    const gone = Bun.spawnSync(["true"]).pid;
    writeFileSync(lock, JSON.stringify({ pid: gone, host: hostname(), command: "fontego watch" }));
    const mine = await acquireLock(A.root);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    await mine();
    expect(existsSync(lock)).toBe(false);
  });

  test("of several processes at once, never two inside, a lock left behind included", async () => {
    const lock = join(A.root, ".fontego/lock");
    for (let round = 0; round < 3; round++) {
      writeFileSync(lock, JSON.stringify({ pid: Bun.spawnSync(["true"]).pid, host: hostname() })); // left behind
      const log = join(tempDir("fontego-lock-log-"), "log");
      writeFileSync(log, "");
      const kids = Array.from({ length: 6 }, () =>
        Bun.spawn(["bun", join(import.meta.dir, "lock-child.ts"), A.root, log, "80"], { stdout: "ignore", stderr: "inherit" }),
      );
      await Promise.all(kids.map((k) => k.exited));
      const lines = readFileSync(log, "utf8").trim().split("\n");
      let inside: string | null = null;
      let entered = 0;
      for (const line of lines) {
        const [what, pid] = line.split(" ");
        if (what === "in") {
          expect(inside).toBeNull();
          inside = pid!;
          entered++;
        } else if (what === "out") {
          expect(inside).toBe(pid!);
          inside = null;
        }
      }
      expect(entered).toBeGreaterThan(0);
      expect(lines).toHaveLength(6 + entered); // each one either went in and out, or was refused
      expect(existsSync(lock)).toBe(false);
    }
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

describe("a copy that couldn't send tries again once it may", () => {
  const space = async (ws: string, people: Array<[string, string]>, seed = true) => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: ws });
    for (const [who, role] of people) await s.call(s.adminToken, "PUT", `/v1/workspaces/${ws}/members/${who}@example.org`, { role });
    if (seed) await s.call(s.adminToken, "PUT", `/v1/workspaces/${ws}/files/readme.md`, { content: "hi\n" });
  };
  const fileOn = async (ws: string, path: string) => {
    const r = await s.call(s.adminToken, "GET", `/v1/workspaces/${ws}/files/${path}`);
    return r.status === 200 ? (r.data as string) : null;
  };

  test("a reader made an editor while watch runs: the edit that waited goes up, untouched", async () => {
    await space("promote", [["carl", "reader"]]);
    let clock = Date.now();
    let asked = 0;
    class Counting extends Client {
      override workspace(ws: string) {
        asked++;
        return super.workspace(ws);
      }
    }
    const client = new Counting(s.url, carl.token);
    const C0 = await copy(carl.token, "Carl", "promote");
    const C = new SyncEngine(C0.root, client, C0.state, { now: () => clock });
    write(C, "note.md", "carl's edit\n");
    const first = await C.sync();
    expect([first.readOnly, first.pending]).toEqual([true, 1]);
    const w = new Watcher(C, client, { debounceMs: 100, safetyMs: 150 });
    await w.start();
    await Bun.sleep(700); // several rounds while still a reader: none of them asks for the role yet
    expect(asked).toBe(0);
    await s.call(s.adminToken, "PUT", "/v1/workspaces/promote/members/carl@example.org", { role: "editor" });
    clock += 61_000;
    const t0 = Date.now();
    while ((await fileOn("promote", "note.md")) === null && Date.now() - t0 < 10_000) await Bun.sleep(100);
    await w.stop();
    expect(await fileOn("promote", "note.md")).toBe("carl's edit\n");
    expect(C.state.readOnly).toBe(false);
    expect(asked).toBe(1);
  });

  test("a file the rules refused goes up once they allow it, untouched; until then it isn't sent again", async () => {
    await space("allow", [["ana", "editor"]]);
    await s.call(s.adminToken, "PUT", "/v1/workspaces/allow/paths/protected/plans/**");
    let clock = Date.now();
    const A0 = await copy(ana.token, "Ana", "allow");
    const A = new SyncEngine(A0.root, new Client(s.url, ana.token), A0.state, { now: () => clock });
    write(A, "plans/q1.md", "the plan\n");
    expect((await A.sync()).skipped.map((x) => x.path)).toEqual(["plans/q1.md"]);
    const soon = await A.sync(); // same content, too soon: it isn't sent again
    expect([soon.skipped, soon.pushed]).toEqual([[], []]);
    await s.call(s.adminToken, "DELETE", "/v1/workspaces/allow/paths/protected/plans/**");
    clock += 5 * 60_000 + 1000;
    expect((await A.sync()).pushed.map((p) => p.path)).toEqual(["plans/q1.md"]);
    expect(await fileOn("allow", "plans/q1.md")).toBe("the plan\n");
    expect(A.state.skipped["plans/q1.md"]).toBeUndefined();
  });

  test("a refusal that keeps coming waits longer each time", async () => {
    await space("refuse", [["ana", "editor"]]);
    await s.call(s.adminToken, "PUT", "/v1/workspaces/refuse/paths/protected/locked.md");
    let clock = Date.now();
    const A0 = await copy(ana.token, "Ana", "refuse");
    const A = new SyncEngine(A0.root, new Client(s.url, ana.token), A0.state, { now: () => clock });
    write(A, "locked.md", "no\n");
    const waits: number[] = [];
    for (let n = 0; n < 3; n++) {
      await A.sync();
      const at = Date.parse(A.state.skipped["locked.md"]!.retryAt!);
      waits.push(at - clock);
      clock = at + 1;
    }
    expect(waits).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000]);
  });

  test("a one-off 403 doesn't leave the copy read-only", async () => {
    await space("oneoff", [["ana", "editor"]]);
    class ForbiddenOnce extends Client {
      done = false;
      override change(ws: string, cs: Parameters<Client["change"]>[1]) {
        if (this.done) return super.change(ws, cs);
        this.done = true;
        return Promise.reject(new ClientError(403, "forbidden", "Not right now."));
      }
    }
    let clock = Date.now();
    const A0 = await copy(ana.token, "Ana", "oneoff");
    const A = new SyncEngine(A0.root, new ForbiddenOnce(s.url, ana.token), A0.state, { now: () => clock });
    write(A, "x.md", "x\n");
    expect((await A.sync()).readOnly).toBe(true);
    clock += 61_000;
    const r = await A.sync();
    expect(r.readOnly).toBe(false);
    expect(r.pushed.map((p) => p.path)).toEqual(["x.md"]);
  });
});

describe("an edit saved while sync is busy is never lost", () => {
  /** A client that, at a chosen point (a download just done, a change set about to go), runs what a person does there. */
  class Busy extends Client {
    hooks: Array<{ at: "file" | "change"; path?: string; run: () => unknown }> = [];
    private async fire(at: "file" | "change", path?: string) {
      const i = this.hooks.findIndex((h) => h.at === at && (!h.path || h.path === path));
      if (i >= 0) await this.hooks.splice(i, 1)[0]!.run();
    }
    override async file(ws: string, path: string, rev?: string) {
      const f = await super.file(ws, path, rev);
      await this.fire("file", path);
      return f;
    }
    override async change(ws: string, cs: Parameters<Client["change"]>[1]) {
      await this.fire("change");
      return super.change(ws, cs);
    }
  }
  const TEXT = "one\ntwo\nthree\nfour\nfive\n";
  let n = 0;
  async function pair() {
    const ws = `busy${++n}`;
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: ws });
    for (const who of ["ana", "bea"]) await s.call(s.adminToken, "PUT", `/v1/workspaces/${ws}/members/${who}@example.org`, { role: "editor" });
    await s.call(ana.token, "POST", `/v1/workspaces/${ws}/changes`, {
      baseCommit: null,
      ops: [
        { op: "put", path: "doc.md", content: TEXT, baseHash: null },
        { op: "put", path: "z-gone.md", content: "soon gone\n", baseHash: null },
      ],
    });
    const A = await copy(ana.token, "Ana", ws);
    const bea2 = new Busy(s.url, bea.token);
    const B0 = await copy(bea.token, "Bea", ws);
    const B = new SyncEngine(B0.root, bea2, B0.state);
    const onServer = async (path: string) => {
      const r = await s.call(ana.token, "GET", `/v1/workspaces/${ws}/files/${path}`);
      return r.status === 200 ? (r.data as string) : null;
    };
    return { ws, A, B, client: bea2, onServer };
  }

  test("saved during a download: it stays, and goes up merged with what came", async () => {
    const { A, B, client, onServer } = await pair();
    write(A, "doc.md", TEXT.replace("one", "ONE by Ana"));
    await A.sync();
    client.hooks.push({ at: "file", path: "doc.md", run: () => write(B, "doc.md", TEXT.replace("five", "FIVE by Bea")) });
    await B.sync();
    const both = TEXT.replace("one", "ONE by Ana").replace("five", "FIVE by Bea");
    expect(read(B, "doc.md")).toBe(both);
    expect(await onServer("doc.md")).toBe(both);
  });

  test("saved while the server's merge comes down: it stays, and is merged next", async () => {
    const { ws, B, client, onServer } = await pair();
    // Ana commits between Bea's pull and her change set, so the server merges; while the merged text comes down,
    // Bea saves once more.
    client.hooks.push({
      at: "change",
      run: async () => {
        const hash = (await s.call(ana.token, "GET", `/v1/workspaces/${ws}/files/doc.md?meta=1`)).data.hash;
        await s.call(ana.token, "PUT", `/v1/workspaces/${ws}/files/doc.md`, { content: TEXT.replace("one", "ONE by Ana"), baseHash: hash });
      },
    });
    client.hooks.push({
      at: "file",
      path: "doc.md",
      run: () => write(B, "doc.md", read(B, "doc.md").replace("three", "THREE by Bea, later")),
    });
    write(B, "doc.md", TEXT.replace("five", "FIVE by Bea"));
    await B.sync();
    expect(read(B, "doc.md")).toContain("THREE by Bea, later");
    await B.sync();
    const all = TEXT.replace("one", "ONE by Ana").replace("three", "THREE by Bea, later").replace("five", "FIVE by Bea");
    expect(await onServer("doc.md")).toBe(all);
    expect(read(B, "doc.md")).toBe(all);
  });

  test("saved after the scan to a file deleted on the server: it stays, and goes back up", async () => {
    const { A, B, client, onServer } = await pair();
    // On the server: doc.md changes and z-gone.md goes. While doc.md comes down (after Bea's scan), she edits z-gone.md.
    write(A, "doc.md", TEXT.replace("two", "TWO by Ana"));
    unlinkSync(join(A.root, "z-gone.md"));
    await A.sync();
    expect(await onServer("z-gone.md")).toBeNull();
    client.hooks.push({ at: "file", path: "doc.md", run: () => write(B, "z-gone.md", "kept by Bea\n") });
    const r = await B.sync();
    expect(r.pulled.map((p) => p.path)).not.toContain("z-gone.md");
    expect(read(B, "z-gone.md")).toBe("kept by Bea\n");
    expect(await onServer("z-gone.md")).toBe("kept by Bea\n");
  });

  test("saved while a conflict is being resolved: the conflict copy has it", async () => {
    const { A, B, client, onServer } = await pair();
    write(A, "doc.md", TEXT.replace("three", "three by Ana"));
    await A.sync();
    // Bea changed the same line; her change set conflicts, and while the server's version comes down she saves again.
    client.hooks.push({ at: "file", path: "doc.md", run: () => write(B, "doc.md", TEXT.replace("three", "three by Bea, saved again")) });
    write(B, "doc.md", TEXT.replace("three", "three by Bea"));
    const r = await B.sync();
    const copies = r.conflicts.map((c) => c.copy).filter(Boolean) as string[];
    const kept = copies.map((c) => read(B, c)).join("") + read(B, "doc.md") + ((await onServer("doc.md")) ?? "");
    expect(kept).toContain("three by Bea, saved again");
    expect(read(B, "doc.md")).toContain("three by Ana");
  });
});

describe("big sends go in batches the server takes", () => {
  const files = async (ws: string) => (await s.call(s.adminToken, "GET", `/v1/workspaces/${ws}/tree?recursive=1`)).data.entries.filter((e: any) => e.type === "blob").length;
  const linkDir = async (ws: string, make: (dir: string) => void, client?: Client, batchBytes?: number) => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: ws });
    await s.call(s.adminToken, "PUT", `/v1/workspaces/${ws}/members/ana@example.org`, { role: "editor" });
    const dir = tempDir(`fontego-link-${ws}-`);
    dirs.push(dir);
    make(dir);
    // What `fontego link` does: a state with no files yet, then a sync that sends everything up.
    const state = newState(s.url, ws, "Ana");
    await saveState(dir, state);
    return { dir, engine: new SyncEngine(dir, client ?? new Client(s.url, ana.token), state, { batchBytes }) };
  };

  test("a link of 1,001 files sends them all, past the 1,000 operations of one change set", async () => {
    const { engine } = await linkDir("thousand", (dir) => {
      for (let n = 0; n < 1001; n++) writeFileSync(join(dir, `f${String(n).padStart(4, "0")}.md`), `file ${n}\n`);
    });
    const r = await engine.sync();
    expect(r.pushed).toHaveLength(1001);
    expect(r.pending).toBe(0);
    expect(await files("thousand")).toBe(1001);
  }, 60_000);

  test("files that together pass the server's body limit go in several change sets", async () => {
    // 4 files of 17 MiB: each under the 20 MiB file limit, 68 MiB together, over the smallest body limit (64 MiB).
    const line = "a plain line of text to fill a big file with\n";
    const big = line.repeat(Math.ceil((17 * 1024 * 1024) / line.length));
    const { engine } = await linkDir("heavy", (dir) => {
      for (const n of [1, 2, 3, 4]) writeFileSync(join(dir, `big${n}.txt`), big);
    });
    const r = await engine.sync();
    expect(r.pushed.map((p) => p.path)).toEqual(["big1.txt", "big2.txt", "big3.txt", "big4.txt"]);
    expect(await files("heavy")).toBe(4);
    const commits = (await s.call(ana.token, "GET", "/v1/workspaces/heavy/history?limit=10")).data.commits;
    expect(commits.length).toBeGreaterThan(1);
  }, 60_000);

  test("a link stopped after a batch carries on with the next sync of that folder", async () => {
    class Dropped extends Client {
      calls = 0;
      override change(ws: string, cs: Parameters<Client["change"]>[1]) {
        if (++this.calls === 2) return Promise.reject(new Error("connection lost"));
        return super.change(ws, cs);
      }
    }
    // Small batches (1 KiB) so that 30 files take several change sets.
    const { dir, engine } = await linkDir(
      "halfway",
      (d) => {
        for (let n = 0; n < 30; n++) writeFileSync(join(d, `n${String(n).padStart(2, "0")}.md`), `note ${n} `.repeat(20) + "\n");
      },
      new Dropped(s.url, ana.token),
      1024,
    );
    await expect(engine.sync()).rejects.toThrow("connection lost");
    const sent = await files("halfway");
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(30);
    // What the first batch committed is in the saved state: `fontego sync` (a new process) sends only the rest.
    const again = new SyncEngine(dir, new Client(s.url, ana.token), await loadState(dir), { batchBytes: 1024 });
    const r = await again.sync();
    expect(r.pushed).toHaveLength(30 - sent);
    expect(await files("halfway")).toBe(30);
    const B = await copy(ana.token, "Bea", "halfway");
    expect(read(B, "n29.md")).toBe("note 29 ".repeat(20) + "\n");
  }, 60_000);

  test("five refused files in a row don't keep a sixth, valid one from going up", async () => {
    const { engine } = await linkDir("refusals", (dir) => {
      for (const n of [1, 2, 3, 4, 5]) {
        mkdirSync(join(dir, `s${n}`));
        writeFileSync(join(dir, `s${n}/.env`), `TOKEN=${n}\n`);
      }
      writeFileSync(join(dir, "valid.md"), "fine\n");
    });
    const r = await engine.sync();
    expect(r.skipped.map((x) => x.path).sort()).toEqual(["s1/.env", "s2/.env", "s3/.env", "s4/.env", "s5/.env"]);
    expect(r.pushed.map((p) => p.path)).toEqual(["valid.md"]);
    expect(r.pending).toBe(0);
  });
});

describe("a folder that can't be read is not a deleted one", () => {
  test("nothing in it is sent or deleted, the server's edits to it wait, and it catches up once readable", async () => {
    if (process.getuid?.() === 0) return; // root reads every folder, whatever its permissions
    const onServer = async (path: string) => (await s.call(s.adminToken, "GET", `/v1/workspaces/perm/files/${path}`)).status === 200;
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "perm" });
    for (const who of ["ana", "bea"]) await s.call(s.adminToken, "PUT", `/v1/workspaces/perm/members/${who}@example.org`, { role: "editor" });
    await s.call(ana.token, "POST", "/v1/workspaces/perm/changes", {
      baseCommit: null,
      ops: [
        { op: "put", path: "private/plan.md", content: "v1\n", baseHash: null },
        { op: "put", path: "private/old.md", content: "old\n", baseHash: null },
        { op: "put", path: "open.md", content: "open\n", baseHash: null },
      ],
    });
    const A = await copy(ana.token, "Ana", "perm");
    const B = await copy(bea.token, "Bea", "perm");
    chmodSync(join(A.root, "private"), 0o000);
    try {
      write(B, "private/plan.md", "v2 by Bea\n");
      await B.sync();
      unlinkSync(join(A.root, "open.md")); // a real delete, next to it
      const st = await localStatus(A.root, A.state);
      expect(st.deleted).toEqual(["open.md"]);
      expect(st.unreadable.map((u) => [u.path, u.reason])).toEqual([["private", "EACCES"]]);
      const r = await A.sync();
      expect(r.pushed).toEqual([{ path: "open.md", status: "delete" }]);
      expect(r.unreadable.map((u) => u.path)).toEqual(["private"]);
      expect(await onServer("private/plan.md")).toBe(true);
      expect(await onServer("private/old.md")).toBe(true);
      expect(await onServer("open.md")).toBe(false);
    } finally {
      chmodSync(join(A.root, "private"), 0o755);
    }
    // Readable again: the edit that waited arrives, with nothing to do by hand.
    const back = await A.sync();
    expect(back.unreadable).toEqual([]);
    expect(read(A, "private/plan.md")).toBe("v2 by Bea\n");
    expect(read(A, "private/old.md")).toBe("old\n");
    await B.sync();
    expect(existsSync(join(B.root, "open.md"))).toBe(false);
    expect(read(B, "private/old.md")).toBe("old\n");
  });
});

describe("ignore rules never delete", () => {
  // Like Git: an ignore rule only keeps new files from going up. A file already in the workspace keeps syncing.
  let A: SyncEngine;
  let B: SyncEngine;
  const onServer = async (path: string) => (await s.call(s.adminToken, "GET", `/v1/workspaces/ign/files/${path}`)).status === 200;

  beforeAll(async () => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "ign" });
    for (const who of ["ana", "bea"]) await s.call(s.adminToken, "PUT", `/v1/workspaces/ign/members/${who}@example.org`, { role: "editor" });
    await s.call(ana.token, "POST", "/v1/workspaces/ign/changes", {
      baseCommit: null,
      ops: [
        { op: "put", path: "build/out.txt", content: "built\n", baseHash: null },
        { op: "put", path: "notes.md", content: "notes\n", baseHash: null },
      ],
    });
    A = await copy(ana.token, "Ana", "ign");
    B = await copy(bea.token, "Bea", "ign");
  });

  test("a file already in the workspace that a new rule matches is not deleted, and keeps syncing both ways", async () => {
    write(A, ".fontegoignore", "build/\n");
    await A.sync();
    expect(await onServer("build/out.txt")).toBe(true);
    await B.sync();
    expect(read(B, "build/out.txt")).toBe("built\n");
    write(B, "build/out.txt", "built again\n");
    await B.sync();
    await A.sync();
    expect(read(A, "build/out.txt")).toBe("built again\n");
  });

  test("an ignore rule of * from one person deletes nothing for anyone", async () => {
    write(B, ".fontegoignore", "*\n");
    await B.sync();
    await A.sync();
    await B.sync();
    for (const path of ["notes.md", "build/out.txt", ".fontegoignore"]) expect(await onServer(path)).toBe(true);
    expect(read(A, "notes.md")).toBe("notes\n");
  });

  test("a file the rules ignore that comes from the server is kept, here and there", async () => {
    write(A, ".fontegoignore", "cache/\n");
    await A.sync();
    await s.call(s.adminToken, "PUT", "/v1/workspaces/ign/files/cache/x.tmp", { content: "from the server\n" });
    const C = await copy(bea.token, "Bea", "ign");
    expect(read(C, "cache/x.tmp")).toBe("from the server\n");
    await C.sync();
    await C.sync();
    expect(await onServer("cache/x.tmp")).toBe(true);
    expect(read(C, "cache/x.tmp")).toBe("from the server\n");
  });
});

describe("taking an ignored file out of the workspace", () => {
  test("its copy stays where the rules ignore it, and goes where they don't", async () => {
    await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "out" });
    for (const who of ["ana", "bea"]) await s.call(s.adminToken, "PUT", `/v1/workspaces/out/members/${who}@example.org`, { role: "editor" });
    await s.call(ana.token, "POST", "/v1/workspaces/out/changes", { baseCommit: null, ops: [{ op: "put", path: "local.cfg", content: "mine\n", baseHash: null }] });
    const A = await copy(ana.token, "Ana", "out");
    const B = await copy(bea.token, "Bea", "out");
    mkdirSync(join(A.root, ".fontego"), { recursive: true });
    writeFileSync(join(A.root, ".fontego/ignore"), "*.cfg\n");
    const hash = (await s.call(ana.token, "GET", "/v1/workspaces/out/files/local.cfg?meta=1")).data.hash;
    await s.call(ana.token, "DELETE", "/v1/workspaces/out/files/local.cfg", { baseHash: hash });
    await A.sync();
    await B.sync();
    expect(read(A, "local.cfg")).toBe("mine\n");
    expect(existsSync(join(B.root, "local.cfg"))).toBe(false);
    expect((await A.sync()).pushed).toEqual([]); // and it doesn't go back up
  });
});
