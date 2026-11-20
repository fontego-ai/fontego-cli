// Commands written in the CLI itself: the ones that work with this machine (signing in to instances) or with a synced
// folder. Everything else comes from the server (declared.ts).

import type { Builtin, RunContext } from "./commands/command.ts";
import { folderCommands } from "./commands/folders.ts";
import { instanceCommands } from "./commands/instances.ts";
import { liveCommands } from "./commands/live.ts";
import { setupCommands } from "./commands/setup.ts";
import { agentName } from "./agents.ts";
import { listInstances } from "./config.ts";
import type { Connection } from "./connect.ts";
import { readCommands, refreshCommands, type CachedCommands } from "./declared.ts";
import { VERSION } from "./version.ts";
import { agentHelp, commandHelp, generalHelp } from "./help.ts";

export type { Builtin, RunContext } from "./commands/command.ts";
export { describeReport } from "./commands/folders.ts";
export { VERSION } from "./version.ts";

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
      // With --json, help is JSON too: {"help": text}, and the command it is about.
      const show = (text: string, command?: string) => rc.print({ ...(command ? { command } : {}), help: text }, () => text);
      if (parsed.flags.agent === true) return show(agentHelp(BUILTINS, cache, stale, { alias, others }));
      if (parsed.args.COMMAND) return show(commandHelp(parsed.args.COMMAND.split(" "), BUILTINS, cache), parsed.args.COMMAND);
      show(generalHelp(BUILTINS, cache, stale, VERSION, { alias, others }, agentName()));
    },
  },
  ...setupCommands,
  {
    name: "version",
    summary: "The version of this CLI",
    group: "This machine",
    async run() {
      console.log(VERSION);
    },
  },
  ...folderCommands,
  ...liveCommands,
];

export const BUILTIN_NAMES = BUILTINS.map((b) => b.name);

/** First words of the built-in commands: a declared command can't start with one. */
export const BUILTIN_WORDS = [...new Set(BUILTIN_NAMES.map((n) => n.split(" ")[0]!))];
