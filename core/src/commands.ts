// The commands a Fontego declares for the CLI. Each one describes one API call: the arguments and flags it takes,
// where each goes in the request, and how to print the answer. It is a description, never code: a CLI only sends
// that request to the same server it got the description from.
//
// The server publishes them at GET /v1/commands and marks every answer with their version (COMMANDS_HEADER), so a
// CLI knows when its copy is stale. Commands that work with this machine or a folder (login, sync, watch...) are
// written in the CLI itself; the server only lists the ones it expects ("builtins").

/** Where a value goes in the request: a path parameter, a query parameter or a field of the JSON body. */
export type CommandTarget = `path.${string}` | `query.${string}` | `body.${string}`;

export interface CommandArg {
  /** Shown in usage, in capitals: WORKSPACE, PATH */
  name: string;
  to: CommandTarget;
  optional?: boolean;
  /**
   * A secret, such as a password: when it is left out (so it must be optional), the CLI asks for it without showing
   * what is typed, or reads one line from stdin when that is not a terminal, so it stays out of the shell's history
   */
  secret?: boolean;
  description?: string;
}

export interface CommandFlag {
  /** Long name, without dashes: "category" for --category */
  name: string;
  /** One letter, for -r */
  short?: string;
  type: "string" | "number" | "boolean";
  to: CommandTarget;
  /** Placeholder shown in usage: --category C */
  value?: string;
  /** For a boolean flag: what to send when it is on (default true, or "1" in a query) */
  set?: string | number | boolean;
  /** Sent when the flag is not given */
  default?: string | number | boolean;
  description: string;
}

/** A template: text with {field.path} or {field|filter|filter:arg} (see template.ts). */
export type Template = string;

export interface CommandColumn {
  header: string;
  value: Template;
}

export type CommandOutput =
  /** A table, one row per item of the list in `rows` (or of the whole answer if it is a list) */
  | { kind: "table"; rows?: string; columns: CommandColumn[]; empty?: string }
  /** One line per item */
  | { kind: "lines"; rows?: string; line: Template; empty?: string }
  /** A few lines about one object; lines that come out empty are left out */
  | { kind: "record"; lines: Template[] }
  | { kind: "message"; text: Template }
  /** The body as it comes (a file). With --json: the content plus these headers, by name */
  | { kind: "raw"; meta?: Record<string, string> };

/** What a route declares. */
export interface CommandDecl {
  /** One or more words: "workspaces", "members set", "admin users add" */
  name: string;
  aliases?: string[];
  summary: string;
  /** Heading the command goes under in `fontego help` */
  group: string;
  /** Only server admins can run it; help hides it from everyone else */
  admin?: boolean;
  args?: CommandArg[];
  flags?: CommandFlag[];
  output: CommandOutput;
}

/** What GET /v1/commands publishes: the declaration plus the request it makes. */
export interface CommandSpec extends CommandDecl {
  request: { method: string; path: string };
}

export interface CommandsManifest {
  version: string;
  commands: CommandSpec[];
  /** Commands the server expects every CLI to have built in (they call its routes) */
  builtins: string[];
}

/** Header on every API answer: the version of the server's commands. */
export const COMMANDS_HEADER = "fontego-commands";

/** Names of the path parameters in a route path: "/v1/workspaces/{workspace}/files/{+path}" → workspace, path. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{\+?([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
}

export function splitTarget(target: CommandTarget): { where: "path" | "query" | "body"; key: string } {
  const dot = target.indexOf(".");
  return { where: target.slice(0, dot) as "path" | "query" | "body", key: target.slice(dot + 1) };
}
