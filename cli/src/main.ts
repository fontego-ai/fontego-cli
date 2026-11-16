#!/usr/bin/env bun
// fontego: workspaces on a Fontego server, from the terminal, for people, agents and scripts.
//
// Two kinds of commands: built-in ones (builtins.ts), which work with this machine or a synced folder, and the ones
// the server declares (declared.ts), learned from GET /v1/commands and kept in a cache. Every command accepts --json.

import { leadingWords, parseCommand, readGlobals, resolveName, UsageError } from "./args.ts";
import { BUILTIN_NAMES, BUILTINS, notLoggedIn, type RunContext } from "./builtins.ts";
import { Client, ClientError } from "./client.ts";
import { loadCliConfig, type CliConfig } from "./config.ts";
import { findCommand, nameLength, readCommands, refreshCommands, runCommand, type CachedCommands } from "./declared.ts";
import { describe } from "./help.ts";
import { LockedError } from "./sync/watch.ts";

const EXIT: Record<number, number> = { 401: 2, 404: 3, 409: 4, 403: 5 };

async function main(): Promise<void> {
  const { json, help, tokens } = readGlobals(process.argv.slice(2));
  const print = (data: unknown, text: () => string) => console.log(json ? JSON.stringify(data, null, 2) : text());
  let signedIn: { client: Client; config: CliConfig } | null = null;
  const client = () => {
    if (signedIn) return signedIn;
    const config = loadCliConfig();
    if (!config) throw notLoggedIn();
    signedIn = { client: new Client(config.url, config.token), config };
    return signedIn;
  };
  let cache: CachedCommands | null = null;

  try {
    const words = leadingWords(tokens);
    const builtinName = resolveName(words, BUILTIN_NAMES) ?? (words.length === 0 ? "help" : null);

    if (builtinName) {
      const b = BUILTINS.find((x) => x.name === builtinName)!;
      if (help && builtinName !== "help") return console.log(describe(b));
      const rest = tokens.slice(words.length ? 1 : 0);
      const rc: RunContext = { parsed: parseCommand(b, rest), json, print, client };
      await b.run(rc);
    } else {
      // A command the server declares: from the saved list, or a fresh one if it isn't there yet.
      const { client: c, config } = client();
      cache = readCommands(config.url);
      let spec = cache ? findCommand(cache, words) : null;
      if (!spec) {
        cache = await refreshCommands(c);
        spec = findCommand(cache, words);
      }
      if (!spec) throw new UsageError(`Unknown command "${words.join(" ") || tokens[0]}". Run: fontego help`);
      if (help) return console.log(describe(spec));
      await runCommand(spec, parseCommand(spec, tokens.slice(nameLength(spec, words))), c, { json });
    }

    // Every answer says which version of the commands the server has; a different one means our list is stale.
    const used = signedIn as { client: Client; config: CliConfig } | null;
    if (used?.client.commandsVersion) {
      cache ??= readCommands(used.config.url);
      if (cache?.version !== used.client.commandsVersion) await refreshCommands(used.client).catch(() => {});
    }
  } catch (e) {
    if (e instanceof LockedError) {
      if (json) console.log(JSON.stringify({ error: { code: "locked", message: e.message } }));
      else console.error(`error: ${e.message}`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      if (json) console.log(JSON.stringify({ error: { code: "usage", message: e.message } }));
      else console.error(`usage: ${e.message}`);
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
