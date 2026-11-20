#!/usr/bin/env bun
// fontego: workspaces on Fontego servers, from the terminal, for people, agents and scripts.
//
// Two kinds of commands: built-in ones (builtins.ts), which work with this machine or a synced folder, and the ones
// each server declares (declared.ts), learned from GET /v1/commands and kept in a cache. A machine can be signed in
// to several servers (connect.ts says which one a command goes to). Every command accepts --json.

import { agentName } from "./agents.ts";
import { leadingWords, parseCommand, readGlobals, resolveName, UsageError } from "./args.ts";
import { BUILTIN_NAMES, BUILTINS, type RunContext } from "./builtins.ts";
import { ClientError } from "./client.ts";
import { connect, type Connection } from "./connect.ts";
import { findCommand, nameLength, readCommands, refreshCommands, runCommand, type CachedCommands } from "./declared.ts";
import { agentPointer, describe } from "./help.ts";
import { findRoot, loadState } from "./sync/state.ts";
import { LockedError } from "./sync/watch.ts";

const EXIT: Record<number, number> = { 401: 2, 404: 3, 409: 4, 403: 5 };
const DAY = 86_400_000;

/** Inside a synced folder, the URL of the instance it belongs to. */
async function folderUrl(): Promise<string | undefined> {
  const root = findRoot(process.cwd());
  return root ? (await loadState(root).catch(() => null))?.url : undefined;
}

async function main(): Promise<void> {
  let json = process.argv.includes("--json");
  let conn: Connection | null = null;
  let cache: CachedCommands | null = null;

  try {
    const globals = readGlobals(process.argv.slice(2));
    json = globals.json;
    const { help, instance, tokens } = globals;
    const print = (data: unknown, text: () => string) => console.log(json ? JSON.stringify(data, null, 2) : text());
    const chosen = instance || process.env.FONTEGO_INSTANCE;
    const signIn: RunContext["connect"] = async (opts = {}) => {
      if (!conn) conn = await connect({ alias: instance, folderUrl: opts.folderUrl ?? (chosen ? undefined : await folderUrl()) });
      return conn;
    };

    const words = leadingWords(tokens);
    const builtinName = resolveName(words, BUILTIN_NAMES) ?? (words.length === 0 ? "help" : null);

    if (builtinName) {
      const b = BUILTINS.find((x) => x.name === builtinName)!;
      if (help && builtinName !== "help") return console.log(describe(b));
      const rest = tokens.slice(words.length ? builtinName.split(" ").length : 0);
      await b.run({ parsed: parseCommand(b, rest), json, instance, print, connect: signIn });
    } else {
      // A command the server declares: from the saved list, or a fresh one if it isn't there yet.
      const { client, url } = await signIn();
      cache = readCommands(url);
      let spec = cache ? findCommand(cache, words) : null;
      if (!spec) {
        cache = await refreshCommands(client);
        spec = findCommand(cache, words);
      }
      if (!spec) throw new UsageError(`Unknown command "${words.join(" ") || tokens[0]}". Run: fontego help`);
      if (help) return console.log(describe(spec));
      const parsed = parseCommand(spec, tokens.slice(nameLength(spec, words)));
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
        const reparsed = parseCommand(again, tokens.slice(nameLength(again, words)));
        for (const [name, value] of Object.entries(parsed.args)) reparsed.args[name] ??= value;
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
    }
  } catch (e) {
    if (e instanceof LockedError) {
      if (json) console.log(JSON.stringify({ error: { code: "locked", message: e.message } }));
      else console.error(`error: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      // An agent that gets a command wrong is told where its guide is.
      const agent = agentName();
      const hint = agent ? agentPointer(agent) : undefined;
      if (json) console.log(JSON.stringify({ error: { code: "usage", message: e.message, ...(hint ? { hint } : {}) } }));
      else {
        console.error(`usage: ${e.message}`);
        if (hint) console.error(`hint: ${hint}`);
      }
      process.exit(1);
    }
    if (e instanceof ClientError) {
      if (json) console.log(JSON.stringify({ error: { code: e.code, message: e.message, hint: e.hint, details: e.details } }, null, 2));
      else {
        console.error(`error: ${e.message}`);
        if (e.hint) console.error(`hint: ${e.hint}`);
      }
      process.exit(EXIT[e.status] ?? 1);
    }
    throw e;
  }
}

await main();
