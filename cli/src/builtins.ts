// Commands written in the CLI itself: the ones that work with this machine (signing in to instances) or with a synced
// folder. Everything else comes from the server (declared.ts).

import type { Builtin, RunContext } from "./commands/command.ts";
import { folderCommands } from "./commands/folders.ts";
import { instanceCommands } from "./commands/instances.ts";
import { listInstances } from "./config.ts";
import type { Connection } from "./connect.ts";
import { readCommands, refreshCommands, type CachedCommands } from "./declared.ts";
import { agentHelp, commandHelp, generalHelp } from "./help.ts";

export type { Builtin, RunContext } from "./commands/command.ts";
export { describeReport } from "./commands/folders.ts";
export const VERSION = "0.1.0";

/** The saved commands of the instance help is about, refreshed if possible (quickly: help must not hang). */
async function commandsForHelp(rc: RunContext): Promise<{ cache: CachedCommands | null; stale: boolean; alias: string | null }> {
  let conn: Connection;
  try {
    conn = await rc.connect();
  } catch {
    return { cache: null, stale: false, alias: null };
  }
  try {
    return { cache: await refreshCommands(conn.client, 3000), stale: false, alias: conn.instance?.alias ?? null };
  } catch {
    return { cache: readCommands(conn.url), stale: true, alias: conn.instance?.alias ?? null };
  }
}

export const BUILTINS: Builtin[] = [
  ...instanceCommands,
  {
    name: "help",
    summary: "This help; with a command, its details; --agent: how to use fontego, for an AI agent",
    group: "This machine",
    args: [{ name: "COMMAND", optional: true, rest: true }],
    flags: [{ name: "agent", type: "boolean", description: "Markdown for an AI agent" }],
    async run(rc) {
      const { parsed } = rc;
      const { cache, stale, alias } = await commandsForHelp(rc);
      const others = listInstances()
        .map((i) => i.alias)
        .filter((a) => a !== alias);
      if (parsed.flags.agent === true) return console.log(agentHelp(BUILTINS, cache, stale, { alias, others }));
      if (parsed.args.COMMAND) return console.log(commandHelp(parsed.args.COMMAND.split(" "), BUILTINS, cache));
      console.log(generalHelp(BUILTINS, cache, stale, VERSION, { alias, others }));
    },
  },
  {
    name: "version",
    summary: "The version of this CLI",
    group: "This machine",
    async run() {
      console.log(VERSION);
    },
  },
  ...folderCommands,
];

export const BUILTIN_NAMES = BUILTINS.map((b) => b.name);

/** First words of the built-in commands: a declared command can't start with one. */
export const BUILTIN_WORDS = [...new Set(BUILTIN_NAMES.map((n) => n.split(" ")[0]!))];
