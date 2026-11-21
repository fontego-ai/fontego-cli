#!/usr/bin/env bun
// Builds what a release of fontego hands out: one executable per system, which needs neither Bun nor Node, and the
// npm packages that bring the right one.
//
//   bun scripts/build.ts [--only linux-x64,...] [--out dist]
//
// dist/release/   fontego-<os>-<arch>[.exe] and SHA256SUMS: the files of a GitHub release, which install.sh downloads
// dist/npm/       fontego (a small launcher, what `npm i -g fontego` installs) and @fontego/cli-<os>-<arch> (one
//                 executable each, for npm to pick by its os and cpu fields). `npm publish` each folder, launcher last.
//
// Bun cross-compiles every system from any of them. macOS: the arm64 executable is signed ad hoc (by Bun), the x64 one
// isn't signed (macho.ts says why); neither is notarized, which takes building on a Mac with Apple's tools.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { codeSignature, stripSignature } from "./macho.ts";

interface Target {
  /** Name in files and npm packages */
  id: string;
  /** Bun's --target */
  bun: string;
  os: "linux" | "darwin" | "win32";
  cpu: "x64" | "arm64";
}

// x64 builds use Bun's baseline (no AVX2), so they run on older processors too; for a CLI the speed is the same.
const TARGETS: Target[] = [
  { id: "linux-x64", bun: "bun-linux-x64-baseline", os: "linux", cpu: "x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "windows-x64", bun: "bun-windows-x64-baseline", os: "win32", cpu: "x64" },
];

const ROOT = resolve(import.meta.dir, "..");
const { values } = parseArgs({ options: { only: { type: "string" }, out: { type: "string", default: "dist" } } });
const only = values.only?.split(",");
const targets = only ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;
if (only && targets.length !== only.length) throw new Error(`Unknown target in --only. Known: ${TARGETS.map((t) => t.id).join(", ")}`);

const out = resolve(ROOT, values.out!);
const release = join(out, "release");
const npm = join(out, "npm");
rmSync(out, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

const version: string = JSON.parse(readFileSync(join(ROOT, "cli/package.json"), "utf8")).version;
const repository = { type: "git", url: "git+https://github.com/fontego-ai/fontego-cli.git" };
const common = { version, license: "Apache-2.0", homepage: "https://fontego.ai", repository };
const legal = ["LICENSE", "NOTICE"];
const exe = (t: Target) => `fontego${t.os === "win32" ? ".exe" : ""}`;
const platformPackage = (t: Target) => `@fontego/cli-${t.id}`;

const sums: string[] = [];
for (const t of targets) {
  const file = `fontego-${t.id}${t.os === "win32" ? ".exe" : ""}`;
  const dest = join(release, file);
  const build = Bun.spawnSync([process.execPath, "build", "--compile", "--minify", `--target=${t.bun}`, "cli/src/main.ts", "--outfile", dest], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`Building ${t.id} failed:\n${build.stderr.toString()}`);
  if (t.os === "darwin") {
    const bytes = readFileSync(dest);
    // macOS on arm64 runs only signed programs: Bun signs this one ad hoc. On x64 the signature Bun leaves is its
    // runtime's, which no longer matches, so it goes.
    if (t.cpu === "arm64" && !codeSignature(bytes)?.adhoc) throw new Error(`${t.id}: Bun didn't sign it ad hoc, and an arm64 Mac won't run it unsigned`);
    if (t.cpu === "x64") writeFileSync(dest, stripSignature(bytes));
  }
  sums.push(`${createHash("sha256").update(readFileSync(dest)).digest("hex")}  ${file}`);

  const dir = join(npm, `cli-${t.id}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(dest, join(dir, "bin", exe(t)));
  chmodSync(join(dir, "bin", exe(t)), 0o755);
  for (const f of legal) copyFileSync(join(ROOT, f), join(dir, f));
  writeFileSync(join(dir, "README.md"), `# ${platformPackage(t)}\n\nThe \`fontego\` executable for ${t.os} ${t.cpu}. Install \`fontego\` instead: it brings this one when it fits.\n`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: platformPackage(t), description: `The fontego executable for ${t.os} ${t.cpu}`, ...common, os: [t.os], cpu: [t.cpu], files: ["bin", ...legal] }, null, 2) + "\n",
  );
  console.log(`built ${file}`);
}
writeFileSync(join(release, "SHA256SUMS"), sums.join("\n") + "\n");
copyFileSync(join(ROOT, "install.sh"), join(release, "install.sh"));

// The launcher: what `npm i -g fontego` installs. npm installs only the optional dependency that fits this machine
// (by its os and cpu), and the launcher runs it. No install script: many installs don't run them.
const launcher = join(npm, "fontego");
mkdirSync(join(launcher, "bin"), { recursive: true });
copyFileSync(join(ROOT, "scripts/npm-launcher.cjs"), join(launcher, "bin", "fontego.cjs"));
chmodSync(join(launcher, "bin", "fontego.cjs"), 0o755);
for (const f of legal) copyFileSync(join(ROOT, f), join(launcher, f));
copyFileSync(join(ROOT, "scripts/npm-readme.md"), join(launcher, "README.md"));
writeFileSync(
  join(launcher, "package.json"),
  JSON.stringify(
    {
      name: "fontego",
      description: "Shared folders for teams that work with agents: the fontego command",
      ...common,
      keywords: ["fontego", "workspaces", "agents", "sync", "cli"],
      bin: { fontego: "bin/fontego.cjs" },
      files: ["bin", ...legal],
      engines: { node: ">=18" },
      optionalDependencies: Object.fromEntries(TARGETS.map((t) => [platformPackage(t), version])),
    },
    null,
    2,
  ) + "\n",
);
console.log(`fontego ${version}: ${release} and ${npm}`);
