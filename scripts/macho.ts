// The code signature of a macOS executable (a 64-bit Mach-O), for the release build.
//
// Bun cross-compiles a macOS executable by adding the program to its own runtime. For arm64 it signs the result ad
// hoc, as macOS requires there. For x64 it keeps the runtime's own signature (Oven's, with the hardened runtime), which
// no longer matches the file: macOS would kill the program as soon as it ran a page that doesn't match. An Intel Mac,
// or Rosetta on Apple silicon, runs an unsigned program, so the release takes that signature out (as Apple's
// `codesign --remove-signature` does, and as Go leaves its own x64 binaries).

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CS_ADHOC = 0x2;
const HEADER = 32;

export interface CodeSignature {
  /** Where the signature is in the file, and its size */
  offset: number;
  size: number;
  /** Signed ad hoc (no certificate), as Bun signs an arm64 executable */
  adhoc: boolean;
}

interface LoadCommand {
  at: number;
  cmd: number;
  size: number;
}

function loadCommands(b: Buffer): LoadCommand[] {
  if (b.length < HEADER || b.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a 64-bit Mach-O executable");
  const count = b.readUInt32LE(16);
  const end = HEADER + b.readUInt32LE(20);
  if (end > b.length) throw new Error("its load commands run past the end of the file");
  const out: LoadCommand[] = [];
  let at = HEADER;
  for (let i = 0; i < count; i++) {
    const cmd = b.readUInt32LE(at);
    const size = b.readUInt32LE(at + 4);
    if (size < 8 || at + size > end) throw new Error(`load command ${i} doesn't fit`);
    out.push({ at, cmd, size });
    at += size;
  }
  return out;
}

const segmentName = (b: Buffer, lc: LoadCommand) => b.toString("latin1", lc.at + 8, lc.at + 24).replace(/\0+$/, "");

/** The executable's code signature, or null when it has none. */
export function codeSignature(b: Buffer): CodeSignature | null {
  const lc = loadCommands(b).find((c) => c.cmd === LC_CODE_SIGNATURE);
  if (!lc) return null;
  const offset = b.readUInt32LE(lc.at + 8);
  const size = b.readUInt32LE(lc.at + 12);
  if (offset + size > b.length || b.readUInt32BE(offset) !== CSMAGIC_EMBEDDED_SIGNATURE) throw new Error("its code signature isn't where it says");
  let adhoc = false;
  const blobs = b.readUInt32BE(offset + 8);
  for (let i = 0; i < blobs; i++) {
    const blob = offset + b.readUInt32BE(offset + 12 + i * 8 + 4);
    if (b.readUInt32BE(blob) === CSMAGIC_CODEDIRECTORY) adhoc = (b.readUInt32BE(blob + 12) & CS_ADHOC) !== 0;
  }
  return { offset, size, adhoc };
}

/**
 * The same executable without its code signature: the signature's load command goes (the ones after it move up), the
 * file ends where the signature began, and `__LINKEDIT`, the segment that held it, ends there too. Refuses a file laid
 * out otherwise (the signature not at the very end, inside `__LINKEDIT`), rather than guess.
 */
export function stripSignature(b: Buffer): Buffer {
  const cmds = loadCommands(b);
  const sig = cmds.find((c) => c.cmd === LC_CODE_SIGNATURE);
  if (!sig) return b;
  const offset = b.readUInt32LE(sig.at + 8);
  const size = b.readUInt32LE(sig.at + 12);
  if (offset + size !== b.length) throw new Error("the code signature isn't at the end of the file");
  const linkedit = cmds.find((c) => c.cmd === LC_SEGMENT_64 && segmentName(b, c) === "__LINKEDIT");
  if (!linkedit) throw new Error("no __LINKEDIT segment");
  const fileoff = Number(b.readBigUInt64LE(linkedit.at + 40));
  const filesize = Number(b.readBigUInt64LE(linkedit.at + 48));
  if (fileoff + filesize !== b.length || offset < fileoff) throw new Error("the code signature isn't at the end of __LINKEDIT");

  const out = Buffer.from(b.subarray(0, offset));
  // __LINKEDIT shrinks in the file and in memory, by whole 16 KB pages (a page on arm64, four on x64)
  const vmsize = Number(out.readBigUInt64LE(linkedit.at + 32));
  out.writeBigUInt64LE(BigInt(offset - fileoff), linkedit.at + 48);
  out.writeBigUInt64LE(BigInt(Math.min(vmsize, Math.ceil((offset - fileoff) / 16384) * 16384)), linkedit.at + 32);
  const end = HEADER + out.readUInt32LE(20);
  out.copy(out, sig.at, sig.at + sig.size, end);
  out.fill(0, end - sig.size, end);
  out.writeUInt32LE(out.readUInt32LE(16) - 1, 16);
  out.writeUInt32LE(out.readUInt32LE(20) - sig.size, 20);
  return out;
}
