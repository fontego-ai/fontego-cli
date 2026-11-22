#!/usr/bin/env node
// What `npm i -g fontego` puts on the PATH: it runs the fontego executable that npm installed for this system (one of
// the optional @fontego/cli-<os>-<arch> packages). Plain Node with no dependencies, so it runs anywhere npm does.
"use strict";

const { spawn } = require("node:child_process");
const { dirname, join } = require("node:path");

const os = process.platform === "win32" ? "windows" : process.platform;
const name = `@fontego/cli-${os}-${process.arch}`;
const file = `bin/fontego${process.platform === "win32" ? ".exe" : ""}`;
const version = require("../package.json").version;
const reinstall =
  "hint: reinstall without skipping optional dependencies (npm i -g fontego, without --omit=optional), or get it from https://github.com/fontego-ai/fontego-cli/releases";

// Node looks for the package here and then in every node_modules above: only the one of this very version is ours.
let found;
try {
  found = require(`${name}/package.json`);
} catch {
  console.error(`error: fontego has no executable for ${process.platform} ${process.arch} here (${name} isn't installed).`);
  console.error(reinstall);
  process.exit(1);
}
if (found.name !== name || found.version !== version) {
  console.error(`error: this is fontego ${version}, but the executable found is ${found.name} ${found.version}.`);
  console.error(reinstall);
  process.exit(1);
}
const bin = join(dirname(require.resolve(`${name}/package.json`)), file);

// The executable gets the terminal as it is, and every signal sent to this launcher (a kill, a service stopping), so
// `fontego watch` stops cleanly however it is stopped.
// On Windows the console sends Ctrl+C to the executable itself, and killing it from here would cut it short: there
// the launcher only waits.
const child = spawn(bin, process.argv.slice(2), { stdio: "inherit" });
if (process.platform === "win32") process.on("SIGINT", () => {});
else {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
    process.on(sig, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
    });
  }
}
child.on("error", (e) => {
  console.error(`error: couldn't run ${bin}: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
