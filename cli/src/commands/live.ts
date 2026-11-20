// `fontego events`: what happens in your workspaces, as it happens. The same stream the web app listens to (GET
// /v1/events): commits, who is in each workspace when that changes, and changes in the workspaces you see. It
// connects again by itself when the line drops; a script or an agent can wait on it for the next change.

import type { CommitEvent, PresenceEntry, PresenceEvent, ReadyEvent, WorkspacesEvent } from "@fontego/core";
import { ClientError } from "../client.ts";
import type { Builtin } from "./command.ts";

const time = () => new Date().toLocaleTimeString();

const who = (e: { user: { name: string; email: string }; agent: string | null }) => {
  const name = e.user.name || e.user.email;
  return e.agent ? `${name}'s agent (${e.agent})` : name;
};

const here = (list: PresenceEntry[]) => list.map((e) => `${who(e)}, ${e.doing}`).join("; ");

/** One line for a person, without the time. */
export function describeEvent(type: string, data: unknown): string | null {
  if (type === "ready") {
    const r = data as Omit<ReadyEvent, "type">;
    const people = new Set(r.presence.map((e) => `${e.user.id} ${e.agent ?? ""}`)).size;
    return `connected; ${people === 0 ? "nobody else is around" : `${people} around in your workspaces`}`;
  }
  if (type === "commit") {
    const c = data as CommitEvent;
    const name = c.author.name || c.author.email;
    const by = c.agent ? `${name}'s agent (${c.agent})` : name;
    return `${c.workspace}  ${by}: ${c.message} (${c.changes.length} ${c.changes.length === 1 ? "file" : "files"})`;
  }
  if (type === "presence") {
    const p = data as PresenceEvent;
    return `${p.workspace}  ${p.here.length ? `here now: ${here(p.here)}` : "nobody here now"}`;
  }
  if (type === "workspaces") {
    const w = data as WorkspacesEvent;
    return `your workspaces changed${w.workspace ? ` (${w.workspace})` : ""}: fontego workspaces`;
  }
  return null;
}

export const liveCommands: Builtin[] = [
  {
    name: "events",
    summary: "What happens in your workspaces as it happens: changes, who is in each, and your list; Ctrl+C to stop",
    group: "Live",
    async run(rc) {
      const conn = await rc.connect();
      const client = conn.client;
      const abort = new AbortController();
      let stopped = false;
      const stop = () => {
        stopped = true;
        abort.abort();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // With --json, stdout carries only events, one JSON object per line; what fontego itself says goes to stderr.
      const say = (line: string) => (rc.json ? console.error(line) : console.log(`${time()}  ${line}`));
      if (!rc.json) say(`listening on ${conn.label}; Ctrl+C to stop`);
      let backoff = 1000;
      for (;;) {
        try {
          await client.personEvents((type, data) => {
            backoff = 1000;
            if (rc.json) return console.log(JSON.stringify({ type, ...(data as object) }));
            const line = describeEvent(type, data);
            if (line) say(line);
          }, abort.signal);
          if (stopped) return;
          say("the server closed the stream");
        } catch (e) {
          if (stopped) return;
          // Signed out, or refused: that doesn't fix itself, so it ends here with what to do.
          if (e instanceof ClientError && e.status >= 400 && e.status < 500) throw e;
          say((e as Error).message);
        }
        const wait = Math.round(backoff * (0.75 + Math.random() / 2));
        say(`connecting again in ${Math.max(1, Math.round(wait / 1000))} s`);
        await new Promise((r) => setTimeout(r, wait));
        backoff = Math.min(backoff * 2, 30_000);
      }
    },
  },
];
