// The commands a Fontego declares for the CLI. Each one describes one API call: the arguments and flags it takes,
// where each goes in the request, and how to print the answer. It is a description, never code: a CLI only sends
// that request to the same server it got the description from.
//
// The server publishes them at GET /v1/commands and marks every answer with their version (COMMANDS_HEADER), so a
// CLI knows when its copy is stale. Commands that work with this machine or a folder (login, sync, watch...) are
// written in the CLI itself; the server only lists the ones it expects ("builtins").

import { checkTemplate, templateVars } from "./template.ts";

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
  /**
   * Long text, such as a file's content: when it is left out (so it must be optional), the CLI reads it whole from
   * stdin (`< file`, or a pipe)
   */
  stdin?: boolean;
  description?: string;
  /** The values it can take: help lists a fixed list, and a person who left it out at a terminal picks one */
  choices?: CommandChoices;
}

/**
 * Where an argument's values come from. `values`: a fixed list. `from`: what this same server answers to a GET on
 * that path under /v1, which may hold earlier arguments (`/workspaces/{WORKSPACE}/members`); the list is the field
 * `rows` of the answer (or the whole answer), and each row gives the value with the template `value` and what a
 * person reads next to it with `label`. It only helps a person pick: the argument is passed the same way, and nothing
 * is asked of a script or an agent.
 */
export type CommandChoices = { values: string[] } | { from: string; rows?: string; value: Template; label?: Template };

/** The arguments a choices path takes: `/workspaces/{WORKSPACE}/members` → WORKSPACE. */
export const choicesArgs = (from: string): string[] => [...from.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]!);

const CHOICES_PATH = /^(\/(?:[A-Za-z0-9_.-]+|\{[A-Z][A-Z0-9_]*\}))+$/;
const ROW_FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;

/** What is wrong with an argument's choices, given the arguments before it; an empty list means nothing. */
export function checkChoices(c: CommandChoices, before: CommandArg[]): string[] {
  const out: string[] = [];
  if ("values" in c) {
    if (!Array.isArray(c.values) || !c.values.length || c.values.some((v) => typeof v !== "string" || !v.trim())) out.push("choices.values must be a list of words");
    return out;
  }
  if (typeof c.from !== "string" || !CHOICES_PATH.test(c.from) || c.from.split("/").some((seg) => seg === "." || seg === "..")) {
    out.push(`choices.from "${c.from}" is not a path under /v1 (like /workspaces/{WORKSPACE}/members)`);
  } else {
    for (const name of choicesArgs(c.from)) {
      if (!before.some((b) => b.name === name && !b.optional)) out.push(`{${name}} in ${c.from} is not a required argument that comes before`);
    }
  }
  if (c.rows !== undefined && !ROW_FIELD.test(c.rows)) out.push(`choices.rows "${c.rows}" doesn't name a field`);
  for (const t of [c.value, ...(c.label !== undefined ? [c.label] : [])]) {
    if (typeof t !== "string" || !t) {
      out.push("choices.value and choices.label are templates");
      continue;
    }
    out.push(...checkTemplate(t).map((p) => `choices: ${p}`));
    if (templateVars(t).length) out.push(`choices: "${t}" reads its row, never a {$variable}`);
  }
  return out;
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
  /**
   * The value names a file on this machine: the CLI reads it and sends its bytes, in base64, where `to` says (a
   * string flag, into the body). It refuses a file over `maxBytes` before reading it, so nothing too big is sent.
   */
  file?: { maxBytes: number };
  /** This word instead of a value sends null where `to` says (into the body): `--photo none` removes the photo */
  unset?: string;
  description: string;
}

/** A template: text with {field.path} or {field|filter|filter:arg} (see template.ts). */
export type Template = string;

export interface CommandColumn {
  header: string;
  value: Template;
  /** Left out when it comes out empty in every row: a column only some answers fill (`ls --last`) */
  optional?: boolean;
}

/**
 * Under each row of a table or of lines: one indented line per item of a list in that row (a commit's files). When
 * the row's field `total` is larger than the items, a last line says how many more there are.
 */
export interface CommandDetails {
  rows: string;
  line: Template;
  total?: string;
}

/**
 * Extras of a list output: lines under each row, and lines after them all, filled from the whole answer; a footer line
 * whose fields come out empty is left out (the next page's cursor when there is one).
 */
interface ListExtras {
  details?: CommandDetails;
  footer?: Template[];
}

export type CommandOutput =
  /** A table, one row per item of the list in `rows` (or of the whole answer if it is a list) */
  | ({ kind: "table"; rows?: string; columns: CommandColumn[]; empty?: string } & ListExtras)
  /** One line per item */
  | ({ kind: "lines"; rows?: string; line: Template; empty?: string } & ListExtras)
  /** A few lines about one object; lines that come out empty are left out. Then, maybe, a list in it */
  | { kind: "record"; lines: Template[]; list?: RecordList }
  | { kind: "message"; text: Template }
  /** The body as it comes (a file). With --json: the content plus these headers, by name */
  | { kind: "raw"; meta?: Record<string, string> };

/**
 * A list at the end of a record: a title, then one indented line per item of the list in `rows` (the folders of a
 * workspace). Nothing when the list is empty. A CLI that doesn't know it prints the record without it.
 */
export interface RecordList {
  title: Template;
  rows: string;
  line: Template;
}

/**
 * Every template of an output, to check it (the server's tests, and the CLI before it runs a command): its columns or
 * line, the lines under each row and the footer, or a record's lines and its list.
 */
export function outputTemplates(o: CommandOutput): Template[] {
  switch (o.kind) {
    case "table":
    case "lines":
      return [...(o.kind === "table" ? o.columns.map((c) => c.value) : [o.line]), ...(o.details ? [o.details.line] : []), ...(o.footer ?? [])];
    case "record":
      return [...o.lines, ...(o.list ? [o.list.title, o.list.line] : [])];
    case "message":
      return [o.text];
    case "raw":
      return [];
  }
}

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

/** On every answer to a call made with a token: when that token stops working, so a client can say so before it does. */
export const TOKEN_EXPIRES_HEADER = "fontego-token-expires";

/** Names of the path parameters in a route path: "/v1/workspaces/{workspace}/files/{+path}" → workspace, path. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{\+?([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!);
}

export function splitTarget(target: CommandTarget): { where: "path" | "query" | "body"; key: string } {
  const dot = target.indexOf(".");
  return { where: target.slice(0, dot) as "path" | "query" | "body", key: target.slice(dot + 1) };
}
