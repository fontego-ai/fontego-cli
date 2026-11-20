// How fontego talks to the scripts and agents that run it, in one place: when it may ask the person something, how
// an error comes out (text with a hint, or {"error": {...}} with --json) and the exit codes. The exit codes are
// written in the guide for agents too (AGENT_INTRO in help.ts): change both together.

import { UsageError } from "./args.ts";
import { ClientError } from "./client.ts";
import type { SyncReport } from "./sync/engine.ts";
import { StateError } from "./sync/state.ts";
import { LockedError } from "./sync/watch.ts";

export const EXIT = {
  ok: 0,
  /** Anything else: a command used the wrong way, a folder another fontego is working in, a damaged state... */
  error: 1,
  signedOut: 2,
  notFound: 3,
  conflict: 4,
  forbidden: 5,
  /** The server can't be reached */
  unreachable: 6,
  /** A sync that did only part: something was refused or couldn't be read this time, or changes still wait */
  partial: 7,
} as const;

const BY_STATUS: Record<number, number> = { 0: EXIT.unreachable, 401: EXIT.signedOut, 403: EXIT.forbidden, 404: EXIT.notFound, 409: EXIT.conflict };

/** Whether fontego may ask the person: never with --json (a script or an agent reads it), and only on a terminal. */
export const canAsk = (json: boolean) => !json && !!process.stdin.isTTY;

/** Whether a sync round left something undone, which the next one tries again (the report says what). */
export const incomplete = (r: SyncReport) => r.pending > 0 || r.skipped.length > 0 || r.unreadable.length > 0;

export interface Failure {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
  exit: number;
  /** The text mode's prefix */
  label: "usage" | "error";
}

/**
 * What any error means for the person or program that ran the command: always a code, a message, a hint about what to
 * do next, and an exit code. `usageHint` is the hint for a command used the wrong way.
 */
export function failureOf(e: unknown, usageHint: string): Failure {
  if (e instanceof UsageError) return { code: "usage", message: e.message, hint: usageHint, exit: EXIT.error, label: "usage" };
  if (e instanceof LockedError) return { code: "locked", message: e.message, hint: "Run it again once the other one is done.", exit: EXIT.error, label: "error" };
  if (e instanceof StateError) return { code: "bad_state", message: e.message, hint: e.hint, exit: EXIT.error, label: "error" };
  if (e instanceof ClientError) {
    return { code: e.code, message: e.message, hint: e.hint, details: e.details, exit: BY_STATUS[e.status] ?? EXIT.error, label: "error" };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: "unexpected",
    message,
    hint: "This looks like a bug in fontego. FONTEGO_DEBUG=1 shows where it happened; please report it.",
    exit: EXIT.error,
    label: "error",
  };
}

/** Prints a failure: on stdout as JSON with --json, else on stderr as text. */
export function printFailure(f: Failure, json: boolean) {
  if (json) {
    const { code, message, hint, details } = f;
    console.log(JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}), ...(details !== undefined ? { details } : {}) } }, null, 2));
    return;
  }
  console.error(`${f.label}: ${f.message}`);
  if (f.hint) console.error(`hint: ${f.hint}`);
}
