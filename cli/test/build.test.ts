// The release builds: the executable for this system, the npm packages around it and install.sh, each used the way a
// person would. Only this system's target is built, to keep it quick.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SKILL } from "../src/commands/setup.ts";
import { VERSION } from "../src/version.ts";
import { tempDir } from "./server.ts";

const ROOT = resolve(import.meta.dir, "../..");
const os = process.platform === "win32" ? "windows" : process.platform;
const target = `${os}-${process.arch}`;
const exe = process.platform === "win32" ? ".exe" : "";
let out: string;
/** Each holds a copy of an executable of ~100 MB: removed at the end */
const made: string[] = [];
const scratch = (prefix: string) => {
  const d = tempDir(prefix);
  made.push(d);
  return d;
};

async function run(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: stdout, err: stderr, code };
}

beforeAll(async () => {
  out = scratch("fontego-build-");
  const r = await run([process.execPath, join(ROOT, "scripts/build.ts"), "--only", target, "--out", out]);
  if (r.code !== 0) throw new Error(r.err);
}, 60_000);
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the release build", () => {
  test("the executable runs on its own, and says its version", async () => {
    const bin = join(out, "release", `fontego-${target}${exe}`);
    expect((await run([bin, "version"])).out.trim()).toBe(VERSION);
    expect((await run([bin, "--version"])).out.trim()).toBe(VERSION);
    expect((await run([bin, "setup", "--print"])).out).toBe(SKILL);
    const sums = readFileSync(join(out, "release", "SHA256SUMS"), "utf8");
    expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  fontego-${target}${exe.replace(".", "\\.")}$`, "m"));
  });

  test("npm: the launcher depends on every system's package, and each says which system it is for", () => {
    const launcher = JSON.parse(readFileSync(join(out, "npm", "fontego", "package.json"), "utf8"));
    expect(launcher.name).toBe("fontego");
    expect(launcher.version).toBe(VERSION);
    expect(launcher.bin).toEqual({ fontego: "bin/fontego.cjs" });
    expect(launcher.scripts).toBeUndefined();
    expect(Object.keys(launcher.optionalDependencies)).toContain(`@fontego/cli-${target}`);
    for (const v of Object.values(launcher.optionalDependencies)) expect(v).toBe(VERSION);
    const platform = JSON.parse(readFileSync(join(out, "npm", `cli-${target}`, "package.json"), "utf8"));
    expect(platform.os).toEqual([process.platform]);
    expect(platform.cpu).toEqual([process.arch]);
    expect(existsSync(join(out, "npm", "fontego", "LICENSE"))).toBe(true);
  });

  test.skipIf(!Bun.which("node"))("npm: the launcher runs the executable npm installed next to it, and passes its exit code", async () => {
    // What a global install leaves: node_modules/fontego and node_modules/@fontego/cli-<os>-<arch>
    const modules = join(scratch("fontego-npm-"), "node_modules");
    mkdirSync(join(modules, "@fontego"), { recursive: true });
    cpSync(join(out, "npm", "fontego"), join(modules, "fontego"), { recursive: true });
    cpSync(join(out, "npm", `cli-${target}`), join(modules, "@fontego", `cli-${target}`), { recursive: true });
    const launcher = join(modules, "fontego", "bin", "fontego.cjs");
    expect((await run(["node", launcher, "version"])).out.trim()).toBe(VERSION);
    const bad = await run(["node", launcher, "setup", "--no-such-flag"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("usage:");
  });
});

describe.skipIf(process.platform === "win32")("install.sh", () => {
  let server: ReturnType<typeof Bun.serve>;
  let releases: string;
  beforeAll(() => {
    // Laid out like GitHub releases: /latest/download/FILE and /download/vX.Y.Z/FILE
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const m = new URL(req.url).pathname.match(/^\/(?:latest\/download|download\/v([^/]+))\/([^/]+)$/);
        if (!m || (m[1] && m[1] !== VERSION)) return new Response("not found", { status: 404 });
        const file = join(out, "release", m[2]!);
        return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
      },
    });
    releases = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server?.stop(true));

  const install = (dir: string, env: Record<string, string> = {}) =>
    run(["sh", join(ROOT, "install.sh")], { FONTEGO_DOWNLOAD_URL: releases, FONTEGO_INSTALL_DIR: dir, ...env });

  test("downloads the executable for this system, checks it and installs it", async () => {
    const dir = join(scratch("fontego-install-"), "bin");
    const r = await install(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed fontego ${VERSION}`);
    expect(r.out).toContain("fontego setup");
    expect((await run([join(dir, "fontego"), "version"])).out.trim()).toBe(VERSION);
    expect((await install(join(scratch("fontego-install-"), "bin"), { FONTEGO_VERSION: VERSION })).code).toBe(0);
  });

  test("installs nothing when the download doesn't match its checksum, or the version doesn't exist", async () => {
    const sums = join(out, "release", "SHA256SUMS");
    const good = readFileSync(sums, "utf8");
    writeFileSync(sums, good.replace(/^[0-9a-f]/gm, (c) => (c === "0" ? "1" : "0")));
    try {
      const dir = join(scratch("fontego-install-"), "bin");
      const r = await install(dir);
      expect(r.code).toBe(1);
      expect(r.err).toContain("doesn't match its SHA-256");
      expect(existsSync(join(dir, "fontego"))).toBe(false);
    } finally {
      writeFileSync(sums, good);
    }
    const missing = await install(join(scratch("fontego-install-"), "bin"), { FONTEGO_VERSION: "99.0.0" });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("couldn't download");
  });
});
