// The macOS executables of a release: arm64 signed ad hoc by Bun, x64 without the runtime's signature, which no longer
// matches it (scripts/macho.ts). Built from this machine, whatever it is: Bun cross-compiles.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeSignature, stripSignature } from "../../scripts/macho.ts";
import { tempDir } from "./server.ts";

const ROOT = resolve(import.meta.dir, "../..");

/** A Mach-O with only what stripSignature reads: a __LINKEDIT segment that ends with a code signature. */
function fakeMacho(): Buffer {
  const lcs = 72 + 16 + 24;
  const linkedit = 32 + lcs;
  const data = Buffer.from("symbols.");
  // The signature: a superblob holding one CodeDirectory, signed ad hoc
  const superblob = Buffer.alloc(36);
  superblob.writeUInt32BE(0xfade0cc0, 0);
  superblob.writeUInt32BE(36, 4);
  superblob.writeUInt32BE(1, 8); // one blob: type 0, at 20
  superblob.writeUInt32BE(0, 12);
  superblob.writeUInt32BE(20, 16);
  superblob.writeUInt32BE(0xfade0c02, 20);
  superblob.writeUInt32BE(16, 24);
  superblob.writeUInt32BE(0x20400, 28);
  superblob.writeUInt32BE(0x2, 32); // CS_ADHOC
  const b = Buffer.alloc(linkedit + data.length + superblob.length);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(3, 16);
  b.writeUInt32LE(lcs, 20);
  let at = 32;
  b.writeUInt32LE(0x19, at); // LC_SEGMENT_64 __LINKEDIT
  b.writeUInt32LE(72, at + 4);
  b.write("__LINKEDIT", at + 8, "latin1");
  b.writeBigUInt64LE(16384n * 4n, at + 24);
  b.writeBigUInt64LE(32768n, at + 32);
  b.writeBigUInt64LE(BigInt(linkedit), at + 40);
  b.writeBigUInt64LE(BigInt(data.length + superblob.length), at + 48);
  at += 72;
  b.writeUInt32LE(0x1d, at); // LC_CODE_SIGNATURE
  b.writeUInt32LE(16, at + 4);
  b.writeUInt32LE(linkedit + data.length, at + 8);
  b.writeUInt32LE(superblob.length, at + 12);
  at += 16;
  b.writeUInt32LE(0x2a, at); // LC_SOURCE_VERSION, after it: it must move up
  b.writeUInt32LE(24, at + 4);
  b.writeBigUInt64LE(7n, at + 8);
  data.copy(b, linkedit);
  superblob.copy(b, linkedit + data.length);
  return b;
}

describe("stripSignature", () => {
  test("takes out the signature, its load command and its bytes, and moves the commands after it up", () => {
    const b = fakeMacho();
    expect(codeSignature(b)).toEqual({ offset: 32 + 112 + 8, size: 36, adhoc: true });
    const s = stripSignature(b);
    expect(codeSignature(s)).toBeNull();
    expect(s.length).toBe(32 + 112 + 8);
    expect(s.toString("latin1", s.length - 8)).toBe("symbols.");
    expect(s.readUInt32LE(16)).toBe(2);
    expect(s.readUInt32LE(20)).toBe(96);
    expect(s.readUInt32LE(32 + 72)).toBe(0x2a); // LC_SOURCE_VERSION, where the signature's command was
    expect(s.readBigUInt64LE(32 + 72 + 8)).toBe(7n);
    expect(s.subarray(32 + 96, 32 + 112).every((x) => x === 0)).toBe(true);
    expect(s.readBigUInt64LE(32 + 48)).toBe(8n); // __LINKEDIT's filesize, and its vmsize in whole 16 KB pages
    expect(s.readBigUInt64LE(32 + 32)).toBe(16384n);
    expect(stripSignature(s)).toBe(s);
  });

  test("refuses a file laid out otherwise, rather than guess", () => {
    const b = Buffer.concat([fakeMacho(), Buffer.from("more")]);
    expect(() => stripSignature(b)).toThrow("isn't at the end of the file");
    expect(() => stripSignature(Buffer.from("MZ not a Mach-O at all, just text"))).toThrow("not a 64-bit Mach-O");
  });
});

describe("the macOS executables of a release", () => {
  let out: string;
  beforeAll(() => {
    out = tempDir("fontego-build-macos-");
    const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts/build.ts"), "--only", "darwin-x64,darwin-arm64", "--out", out], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }, 120_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("arm64 is signed ad hoc, x64 isn't signed, and npm has the same files as the release", () => {
    for (const [id, signed] of [["darwin-arm64", true], ["darwin-x64", false]] as const) {
      const bin = readFileSync(join(out, "release", `fontego-${id}`));
      const sig = codeSignature(bin);
      if (signed) expect(sig?.adhoc).toBe(true);
      else expect(sig).toBeNull();
      expect(readFileSync(join(out, "npm", `cli-${id}`, "bin", "fontego")).equals(bin)).toBe(true);
      const hash = new Bun.CryptoHasher("sha256").update(bin).digest("hex");
      expect(readFileSync(join(out, "release", "SHA256SUMS"), "utf8")).toContain(`${hash}  fontego-${id}\n`);
    }
  });
});
