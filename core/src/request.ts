// The request a declared command makes (commands.ts): its arguments and flags put where the declaration says, in the
// path, the query or the JSON body. The CLI builds it from a command line; the server's MCP, from a tool's fields. So
// one value reaches the API the same way through both.

import { splitTarget, type CommandFlag, type CommandSpec } from "./commands.ts";

/** What a command was given: its arguments by name (WORKSPACE) and its flags by name (rev). */
export interface CommandValues {
  args: Record<string, unknown>;
  flags: Record<string, unknown>;
}

/** A value that can't go into the request: an argument its path needs left out, or a path part that would leave it. */
export class CommandInputError extends Error {
  constructor(
    message: string,
    /** The argument that is missing, when that is what is wrong */
    readonly missing?: string,
  ) {
    super(message);
  }
}

/** Whether a flag's value is its word for null, in any capitals: --photo none, --photo NONE */
export const isUnset = (f: CommandFlag, v: unknown) => f.unset !== undefined && typeof v === "string" && v.toLowerCase() === f.unset;

/**
 * A value for {PARAM}, or {+PARAM} (a path, which keeps its slashes). An empty, "." or ".." part is refused: the URL
 * would resolve it, and the command would reach another route (`rm WS ../members/ana@…`).
 */
function encodeParam(name: string, value: string, spans: boolean): string {
  const parts = spans ? value.split("/") : [value];
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new CommandInputError(`${name} can't be empty or have an empty, "." or ".." part: "${value}"`);
  }
  return parts.map(encodeURIComponent).join("/");
}

/** A value for the path or the query: a word, never a list or an object. */
function scalar(name: string, v: unknown): string | number | boolean {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  throw new CommandInputError(`${name} takes a single value, not ${Array.isArray(v) ? "a list" : typeof v}.`);
}

/**
 * The request a command makes with these values. `files` holds what file flags read (the CLI reads them from this
 * machine); without an entry, a file flag's value goes into the body as it is (the MCP, whose client sends it).
 */
export function buildRequest(
  spec: CommandSpec,
  values: CommandValues,
  files: Record<string, unknown> = {},
): { method: string; path: string; query: URLSearchParams; body?: unknown } {
  const pathValues: Record<string, string> = {};
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let hasBody = false;

  const put = (name: string, to: string, value: unknown, set?: string | number | boolean) => {
    const { where, key } = splitTarget(to as never);
    if (where === "body") {
      body[key] = value === true && set !== undefined ? set : value;
      return;
    }
    const v = scalar(name, value);
    if (where === "path") pathValues[key] = String(v);
    else query.set(key, v === true ? String(set ?? "1") : String(v));
  };

  for (const a of spec.args ?? []) {
    if (a.to.startsWith("body.")) hasBody = true;
    const v = values.args[a.name];
    if (v !== undefined) put(a.name, a.to, v);
  }
  for (const f of spec.flags ?? []) {
    if (f.to.startsWith("body.")) hasBody = true;
    const v = values.flags[f.name] ?? f.default;
    // A boolean flag that is off is a flag not given.
    if (v === undefined || (f.type === "boolean" && v === false)) continue;
    if (isUnset(f, v)) body[splitTarget(f.to).key] = null;
    else if (f.file && f.name in files) body[splitTarget(f.to).key] = files[f.name];
    else put(`--${f.name}`, f.to, v, f.set);
  }

  const path = spec.request.path.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_, plus: string, key: string) => {
    const arg = spec.args?.find((a) => a.to === `path.${key}`);
    const v = pathValues[key];
    if (v === undefined) throw new CommandInputError(`${arg?.name ?? key} is missing.`, arg?.name ?? key);
    return encodeParam(arg?.name ?? key, v, plus === "+");
  });
  return { method: spec.request.method, path, query, ...(hasBody ? { body } : {}) };
}
