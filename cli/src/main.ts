#!/usr/bin/env bun
// fontego: workspaces on Fontego servers, from the terminal, for people, agents and scripts.
//
// Two kinds of commands: built-in ones (builtins.ts), which work with this machine or a synced folder, and the ones
// each server declares (declared.ts), learned from GET /v1/commands and kept in a cache. A machine can be signed in
// to several servers (connect.ts says which one a command goes to). Every command accepts --json.

import { agentName } from "./agents.ts";
import { askMissing } from "./ask.ts";
import { leadingWords, parseCommand, readGlobals, resolveName, UsageError } from "./args.ts";
import { BUILTIN_NAMES, BUILTINS, VERSION, type RunContext } from "./builtins.ts";
import { ClientError } from "./client.ts";
import { connect, type Connection } from "./connect.ts";
import { choicesSource, findCommand, nameLength, readCommands, refreshCommands, runCommand, type CachedCommands } from "./declared.ts";
import { agentPointer, describe } from "./help.ts";
import { failureOf, printFailure } from "./output.ts";
import { findRoot, loadState } from "./sync/state.ts";
import { guardConsole } from "./terminal.ts";

const DAY = 86_400_000;
/** A token says it ends this many days before (a session: three, as it renews while it is used) */
const TOKEN_WARN_DAYS = 7;

/** Inside a synced folder, the URL of the instance it belongs to. */
async function folderUrl(): Promise<string | undefined> {
  const root = findRoot(process.cwd());
  return root ? (await loadState(root).catch(() => null))?.url : undefined;
}

async function main(): Promise<void> {
  let json = process.argv.includes("--json");
  // What others wrote (names, messages, file names) reaches the terminal only without control characters.
  guardConsole(() => json);
  let conn: Connection | null = null;
  let cache: CachedCommands | null = null;
  /** The command being run, once known: a usage error points to its help */
  let commandName: string | null = null;

  try {
    const globals = readGlobals(process.argv.slice(2));
    json = globals.json;
    const { help, instance } = globals;
    // `fontego --version` (or -v), the first thing people type after installing, is `fontego version`.
    const tokens = ["--version", "-v"].includes(globals.tokens[0] ?? "") ? ["version", ...globals.tokens.slice(1)] : globals.tokens;
    const print = (data: unknown, text: () => string) => console.log(json ? JSON.stringify(data, null, 2) : text());
    /** A command's help, as text, or with --json as {"command", "help"} */
    const showHelp = (command: string, text: string) => print({ command, help: text }, () => text);
    const chosen = instance || process.env.FONTEGO_INSTANCE;
    const signIn: RunContext["connect"] = async (opts = {}) => {
      if (!conn) conn = await connect({ alias: instance, folderUrl: opts.folderUrl ?? (chosen ? undefined : await folderUrl()) });
      return conn;
    };

    const words = leadingWords(tokens);
    const builtinName = resolveName(words, BUILTIN_NAMES) ?? (words.length === 0 ? "help" : null);

    if (builtinName) {
      const b = BUILTINS.find((x) => x.name === builtinName)!;
      commandName = b.name;
      if (help && builtinName !== "help") return showHelp(b.name, describe(b));
      const rest = tokens.slice(words.length ? builtinName.split(" ").length : 0);
      const parsed = parseCommand(b, rest, { allowMissing: true });
      await askMissing(b, parsed, { json, instance, sourceFor: (arg) => (arg.pick ? { local: !!arg.pick.local, load: () => arg.pick!.load(signIn) } : null) });
      await b.run({ parsed, json, instance, print, connect: signIn });
    } else {
      // A command the server declares: from the saved list, or a fresh one if it isn't there yet.
      const { client, url } = await signIn();
      cache = readCommands(url);
      let spec = cache ? findCommand(cache, words) : null;
      if (!spec) {
        cache = await refreshCommands(client);
        spec = findCommand(cache, words);
      }
      if (!spec) {
        const refused = cache?.refused?.find((r) => words.join(" ").startsWith(r.name));
        if (refused) {
          throw new UsageError(`This fontego (${VERSION}) won't run "fontego ${refused.name}" as this server declares it: ${refused.problems[0]}. A newer fontego may.`);
        }
        throw new UsageError(`Unknown command "${words.join(" ") || tokens[0]}". Run: fontego help`);
      }
      commandName = spec.name;
      if (help) return showHelp(spec.name, describe(spec));
      const parsed = parseCommand(spec, tokens.slice(nameLength(spec, words)), { allowMissing: true });
      await askMissing(spec, parsed, { json, instance, sourceFor: (arg, args) => choicesSource(arg, args, client) });
      try {
        await runCommand(spec, parsed, client, { json });
      } catch (e) {
        // A route that moved since our list was saved answers 404 or 405, and its answer carries the server's newer
        // version: learn the commands again and try once more (the failed call did nothing).
        const stale = client.commandsVersion && cache?.version !== client.commandsVersion;
        if (!(stale && e instanceof ClientError && (e.status === 404 || e.status === 405))) throw e;
        cache = await refreshCommands(client);
        const again = findCommand(cache, words);
        if (!again) throw new UsageError(`Unknown command "${words.join(" ")}". Run: fontego help`);
        const reparsed = parseCommand(again, tokens.slice(nameLength(again, words)), { allowMissing: true });
        for (const [name, value] of Object.entries(parsed.args)) reparsed.args[name] ??= value;
        reparsed.missing = reparsed.missing?.filter((name) => reparsed.args[name] === undefined);
        await askMissing(again, reparsed, { json, instance, sourceFor: (arg, args) => choicesSource(arg, args, client) });
        await runCommand(again, reparsed, client, { json });
      }
    }

    const used = conn as Connection | null;
    if (used) {
      // Every answer says which version of the commands the server has; a different one means our list is stale.
      if (used.client.commandsVersion) {
        cache ??= readCommands(used.url);
        if (cache?.version !== used.client.commandsVersion) await refreshCommands(used.client).catch(() => {});
      }
      // A few days before a session ends, say so.
      const ends = used.auth?.expiresAt;
      const left = ends ? Date.parse(ends) - Date.now() : Infinity;
      if (left > 0 && left < 3 * DAY) {
        const days = Math.max(1, Math.round(left / DAY));
        console.error(`Your session on ${used.label} ends in ${days} day(s) unless you use it; renew it with: fontego login ${used.label}`);
      }
      // The last week of a token, say so too: a script or a CI job runs where nobody looks, but its log says it.
      const tokenLeft = used.client.tokenExpiresAt ? Date.parse(used.client.tokenExpiresAt) - Date.now() : Infinity;
      if (tokenLeft > 0 && tokenLeft < TOKEN_WARN_DAYS * DAY) {
        const days = Math.max(1, Math.round(tokenLeft / DAY));
        console.error(`The token in use on ${used.label} ends in ${days} day(s). Make another in Your account, or with fontego account tokens create from a signed-in computer.`);
      }
    }
  } catch (e) {
    if (process.env.FONTEGO_DEBUG === "1") throw e;
    // A command used the wrong way points to its help, and an agent also to its guide.
    const agent = agentName();
    const help = `Run: fontego help${commandName && commandName !== "help" ? ` ${commandName}` : ""}`;
    const usageHint = agent ? `${help}. ${agentPointer(agent)}` : help;
    const failure = failureOf(e, usageHint);
    printFailure(failure, json);
    process.exit(failure.exit);
  }
}

await main();
