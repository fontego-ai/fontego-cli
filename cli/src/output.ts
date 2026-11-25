// How fontego talks to the scripts and agents that run it, in one place: when it may ask the person something, how
// an error comes out (text with a hint, or {"error": {...}} with --json) and the exit codes. The exit codes are
// written in the guide for agents too (AGENT_INTRO in help.ts): change both together.

import { agentName } from "./agents.ts";
import { UsageError } from "./args.ts";
import { ClientError } from "./client.ts";
import type { SyncReport } from "./sync/engine.ts";
import { StateError } from "./sync/state.ts";
import { LockedError } from "./sync/watch.ts";
import { colorful, forPerson, writeStderr } from "./terminal.ts";

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

export interface Ttys {
  stdin: boolean;
  /** Where questions go, so what a command prints on stdout stays clean */
  stderr: boolean;
}

const ttys = (): Ttys => ({ stdin: !!process.stdin.isTTY, stderr: !!process.stderr.isTTY });

const isCI = (env: NodeJS.ProcessEnv) => !["", "0", "false"].includes((env.CI ?? "").trim().toLowerCase());

/**
 * Why fontego won't ask anything here, or null when it may: only a person at a terminal is asked. Never with --json
 * (a script or an agent reads the answer), in CI, with FONTEGO_NO_INPUT=1, or when an agent runs it: some agents run
 * commands in a pseudo-terminal, and would wait for an answer forever.
 */
export function whyNotAsked(json: boolean, env: NodeJS.ProcessEnv = process.env, tty: Ttys = ttys()): string | null {
  if (json) return "--json";
  if (!tty.stdin || !tty.stderr) return "not a terminal";
  if (isCI(env)) return "CI";
  if (env.FONTEGO_NO_INPUT === "1") return "FONTEGO_NO_INPUT=1";
  const agent = agentName(env);
  return agent ? `${agent} runs it` : null;
}

/** Whether fontego may ask the person something (whyNotAsked says why not). */
export const canAsk = (json: boolean, env: NodeJS.ProcessEnv = process.env, tty: Ttys = ttys()) => whyNotAsked(json, env, tty) === null;

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

/**
 * Prints a failure: on stdout as JSON with --json, else on stderr as text, where only its label is red (on a terminal
 * that shows colour), so that a failure looks like one and a notice doesn't.
 */
export function printFailure(f: Failure, json: boolean, stderrIsTerminal = !!process.stderr.isTTY) {
  if (json) {
    const { code, message, hint, details } = f;
    console.log(JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}), ...(details !== undefined ? { details } : {}) } }, null, 2));
    return;
  }
  writeStderr(failureText(f, colorful(stderrIsTerminal)));
}

/** A failure as text: "error: …" (the label red with colour), then "hint: …". The server's words carry no controls. */
export function failureText(f: Failure, color: boolean): string {
  const label = color ? `\x1b[31m${f.label}:\x1b[39m` : `${f.label}:`;
  return `${label} ${forPerson(f.message)}\n${f.hint ? `hint: ${forPerson(f.hint)}\n` : ""}`;
}
