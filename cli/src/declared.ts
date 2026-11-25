// Commands the server declares (GET /v1/commands): kept per server in a cache, checked, and run as plain API calls.
// The CLI never runs anything a server sends; it only builds the request the description asks for and prints the
// answer with the description's templates.

import {
  buildRequest as requestOf,
  checkChoices,
  checkTemplate,
  CommandInputError,
  isUnset,
  outputTemplates,
  textContent,
  pathParams,
  renderOutput,
  renderTemplate,
  rowsOf,
  templateVars,
  type CommandArg,
  type CommandFlag,
  type CommandSpec,
  type CommandsManifest,
  type TemplateVars,
} from "@fontego/core";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError, usageLine, type Parsed } from "./args.ts";
import type { ChoicesSource } from "./ask.ts";
import type { Client } from "./client.ts";
import { readSecret, readStdin, readStdinBytes, sizeText } from "./prompt.ts";
import { terminalWidth } from "./table.ts";
import { forPerson, unsafeForTerminal } from "./terminal.ts";

// --- The cache: one file per server ---

export interface CachedCommands extends CommandsManifest {
  url: string;
  fetchedAt: string;
  /** Who we are there, so help can leave out admin commands for everyone else */
  me: { email: string; isAdmin: boolean } | null;
  /** Commands the server declares that this CLI won't run (checkCommand), and why: a newer server, or a bad one */
  refused?: { name: string; problems: string[] }[];
}

/** Keeps only the commands this CLI can run safely; the others are listed apart, so `fontego X` can say why. */
function usable(cache: CachedCommands): CachedCommands {
  const commands: CommandSpec[] = [];
  const refused: { name: string; problems: string[] }[] = [];
  for (const c of cache.commands) {
    const problems = checkCommand(c, []);
    if (problems.length) refused.push({ name: typeof c?.name === "string" ? c.name : "?", problems });
    else commands.push(c);
  }
  return { ...cache, commands, refused };
}

export function commandsCachePath(url: string, env = process.env): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = url.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9.-]+/g, "_");
  return join(base, "fontego", "commands", `${key}.json`);
}

export function readCommands(url: string): CachedCommands | null {
  const path = commandsCachePath(url);
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CachedCommands;
    return c.url === url && Array.isArray(c.commands) ? usable(c) : null;
  } catch {
    return null; // a damaged cache is just a missing one
  }
}

export function forgetCommands(url: string) {
  rmSync(commandsCachePath(url), { force: true });
}

/** Asks the server for its commands (and who we are) and saves them. */
export async function refreshCommands(client: Client, timeoutMs?: number): Promise<CachedCommands> {
  const manifest = await client.commands(timeoutMs);
  let me: CachedCommands["me"] = null;
  try {
    const who = await client.me();
    me = { email: who.user.email, isAdmin: who.user.isAdmin };
  } catch {
    // not signed in there, or the token was revoked: commands still help
  }
  const cached: CachedCommands = { ...manifest, url: client.baseUrl, fetchedAt: new Date().toISOString(), me };
  // Private to this person: it says who they are on that server, and what it lists is what fontego runs.
  const path = commandsCachePath(client.baseUrl);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(cached, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
  return usable(cached);
}

export function findCommand(cache: CachedCommands, words: string[]): CommandSpec | null {
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const name = words.slice(0, n).join(" ");
    const c = cache.commands.find((x) => x.name === name || x.aliases?.includes(name));
    if (c) return c;
  }
  return null;
}

/** The words that named the command, so the rest can be read as its arguments. */
export function nameLength(spec: CommandSpec, words: string[]): number {
  for (const name of [spec.name, ...(spec.aliases ?? [])]) {
    const n = name.split(" ").length;
    if (words.slice(0, n).join(" ") === name) return n;
  }
  return spec.name.split(" ").length;
}

// --- Checking a declaration ---

const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/;
/** A request path: /v1, then plain words or {PARAM} / {+PARAM}, never "." or ".." (they would leave the route) */
const REQUEST_PATH = /^\/v1(\/(?!\.{1,2}(\/|$))([A-Za-z0-9._~-]+|\{\+?[A-Za-z0-9_]+\}))+$/;
/** An argument is shown in usage lines and asked for by name (a secret), so it is a plain uppercase word */
const ARG_NAME = /^[A-Z][A-Z0-9_]*$/;
const FLAG_NAME = /^[a-z][a-z0-9-]*$/;
/** The word that sends null: --photo none (NONE too) */
const UNSET_WORD = /^[a-z][a-z0-9-]{0,19}$/;
/**
 * What a flag that reads a file of this machine may be called: a name that says it is one. A path is also a text people
 * and agents pass (`fontego edit WS PATH --new TEXT`), so a server that declared --new as a file would get the file
 * that text happens to name.
 */
const FILE_FLAG_NAME = /^(photo|edits|file|[a-z][a-z0-9-]*-file)$/;
/**
 * The commands that read stdin for a value left out. What is on stdin isn't always for fontego (the rest of a script
 * run with `bash -s`, the list a `while read` goes through), so which commands take it is not the server's to say: a
 * value any other command leaves out has to be given.
 */
const READS_STDIN = new Set(["write", "admin settings set"]);
/** The most a declared command may send of one file, whatever the server says */
const MAX_FILE_FLAG = 64 * 1024 * 1024;
const COMMAND_NAME = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*){0,2}$/;
/** What a command says about itself is shown in help: one line each, so it can't pose as more lines of it */
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f]*$/;

/** What would keep this CLI from running a declared command; an empty list means it can. */
export function checkCommand(spec: CommandSpec, builtins: Iterable<string>): string[] {
  const out: string[] = [];
  if (typeof spec?.name !== "string" || !spec.request || !spec.output) return ["not a command declaration"];
  const at = `fontego ${spec.name}`;
  const taken = new Set(builtins);
  for (const name of [spec.name, ...(spec.aliases ?? [])]) if (!COMMAND_NAME.test(name)) out.push(`${at}: "${name}" isn't a plain command name`);
  for (const name of [spec.name, ...(spec.aliases ?? [])]) {
    if (taken.has(name.split(" ")[0]!)) out.push(`${at}: "${name}" clashes with a built-in command`);
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(spec.request.method)) out.push(`${at}: unknown method ${spec.request.method}`);
  if (!REQUEST_PATH.test(spec.request.path)) out.push(`${at}: the request must go to a plain path under /v1`);
  const args = spec.args ?? [];
  const flags = spec.flags ?? [];
  for (const t of [...args.map((a) => a.to), ...flags.map((f) => f.to)]) {
    if (!/^(path|query|body)\.[A-Za-z0-9_]+$/.test(t)) out.push(`${at}: "${t}" is not a place in a request`);
  }
  for (const p of pathParams(spec.request.path)) {
    if (!args.some((a) => a.to === `path.${p}` && !a.optional)) out.push(`${at}: nothing fills {${p}} in ${spec.request.path}`);
  }
  for (const a of args) if (!ARG_NAME.test(a.name)) out.push(`${at}: "${a.name}" isn't a plain argument name`);
  for (const f of flags) if (!FLAG_NAME.test(f.name)) out.push(`${at}: "--${f.name}" isn't a plain option name`);
  for (const f of flags) if (f.value !== undefined && !ARG_NAME.test(f.value)) out.push(`${at}: --${f.name} ${f.value} isn't a plain value name`);
  const said = [spec.summary, spec.group, ...args.map((a) => a.description), ...flags.map((f) => f.description)];
  if (said.some((t) => t !== undefined && (typeof t !== "string" || !ONE_LINE.test(t)))) out.push(`${at}: its summary, group and descriptions must be one line each`);
  for (const a of args) if (a.secret && !a.optional) out.push(`${at}: ${a.name} is a secret, so it must be optional (left out, it is asked for)`);
  if (args.some((a) => a.secret || a.stdin) && spec.aliases?.length) out.push(`${at}: it may read stdin, so it can't have other names`);
  for (const a of args) if (a.stdin && !a.optional) out.push(`${at}: ${a.name} comes from stdin when left out, so it must be optional`);
  args.forEach((a, i) => {
    if (a.choices) out.push(...checkChoices(a.choices, args.slice(0, i)).map((p) => `${at}: ${a.name}: ${p}`));
  });
  for (const f of flags) {
    if (!["string", "number", "boolean"].includes(f.type)) out.push(`${at}: --${f.name} has an unknown type`);
    if (f.short && !/^[A-Za-z]$/.test(f.short)) out.push(`${at}: -${f.short} must be one letter`);
    // A file of this machine goes to the server only when the person can see that it does: the usage says FILE
    if (f.file !== undefined && (f.type !== "string" || !f.to.startsWith("body.") || f.value !== "FILE" || !(f.file.maxBytes > 0) || f.file.maxBytes > MAX_FILE_FLAG)) {
      out.push(`${at}: --${f.name} names a file, so it must be a string into the body shown as FILE, of at most ${MAX_FILE_FLAG / 1024 / 1024} MB`);
    }
    // ...and only under a name that nobody passes a text with, by its long name
    if (f.file !== undefined && (!FILE_FLAG_NAME.test(f.name) || f.short !== undefined)) {
      out.push(`${at}: --${f.name} names a file, so it must be called photo, edits, file or something-file, with no short name`);
    }
    if (f.file !== undefined && f.file.json !== undefined && typeof f.file.json !== "boolean") out.push(`${at}: --${f.name}: file.json is true or false`);
    // Which file of this machine is read is the person's to say, never the server's
    if (f.file !== undefined && f.default !== undefined) out.push(`${at}: --${f.name} names a file, so it can't have a default`);
    if (f.unset !== undefined && (typeof f.unset !== "string" || !UNSET_WORD.test(f.unset) || f.type !== "string" || !f.to.startsWith("body."))) {
      out.push(`${at}: --${f.name} can send null only as a string flag into the body, with a plain lowercase word for it`);
    }
  }
  if (!["table", "lines", "record", "message", "raw"].includes(spec.output.kind)) out.push(`${at}: unknown output "${spec.output.kind}"`);
  if ((spec.output.kind === "table" || spec.output.kind === "lines") && spec.output.details) {
    const d = spec.output.details;
    for (const f of [d.rows, ...(d.total !== undefined ? [d.total] : [])]) if (!FIELD.test(f)) out.push(`${at}: "${f}" doesn't name a field`);
  }
  // A secret never goes into what is printed.
  const vars = new Set(["url", ...args.filter((a) => !a.secret).map((a) => a.name), ...flags.map((f) => f.name)]);
  for (const t of outputTemplates(spec.output)) {
    out.push(...checkTemplate(t).map((p) => `${at}: ${p}`));
    for (const v of templateVars(t)) if (!vars.has(v)) out.push(`${at}: {$${v}} is unknown`);
  }
  return out;
}

// --- Running one ---

export { renderOutput };

/**
 * The request a command makes with these arguments and flags (core's buildRequest, which the server's MCP uses too);
 * `files` holds what file flags read (readFileFlags), and a file flag given here always goes as what was read from
 * its file, never as the name typed. What can't go in is a usage error.
 */
export function buildRequest(spec: CommandSpec, parsed: Parsed, files: Record<string, unknown> = {}) {
  for (const f of spec.flags ?? []) {
    const v = parsed.flags[f.name];
    if (f.file && v !== undefined && !isUnset(f, v) && !(f.name in files)) throw new Error(`--${f.name}: the file wasn't read`);
  }
  try {
    return requestOf(spec, parsed, files);
  } catch (e) {
    if (e instanceof CommandInputError) throw new UsageError(e.missing ? usageLine(spec) : e.message);
    throw e;
  }
}

/**
 * Where a person picks a declared argument from: its fixed values, or the rows of a GET to this same server, with the
 * arguments already known in the path. Null when it has no list, and is typed.
 */
export function choicesSource(arg: CommandArg, args: Record<string, string>, client: Client): ChoicesSource {
  const c = arg.choices;
  if (!c) return null;
  if ("values" in c) return { local: true, load: async () => c.values.map((value) => ({ value })) };
  return {
    local: false,
    load: async () => {
      const path = `/v1${c.from.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => encodeURIComponent(args[name] ?? ""))}`;
      const data: unknown = await (await client.call("GET", path)).json();
      const seen = new Set<string>();
      return rowsOf(data, c.rows).flatMap((row) => {
        const value = renderTemplate(c.value, row);
        if (!value || seen.has(value)) return [];
        seen.add(value);
        const label = c.label ? renderTemplate(c.label, row).trim() : "";
        return [{ value, ...(label ? { label } : {}) }];
      });
    },
  };
}

/**
 * What a command was given that would read stdin: a `stdin` argument left out, a secret left out when stdin isn't a
 * terminal (readSecret), a file flag given `-`.
 */
function stdinReaders(spec: CommandSpec, parsed: Parsed): string[] {
  const fromStdin = (a: CommandArg) => a.stdin || (a.secret && !process.stdin.isTTY);
  const args = (spec.args ?? []).filter((a) => fromStdin(a) && parsed.args[a.name] === undefined).map((a) => a.name);
  const flags = (spec.flags ?? []).filter((f) => f.file && parsed.flags[f.name] === "-").map((f) => `--${f.name} -`);
  return [...args, ...flags];
}

/** A file flag's bytes as the request carries them: base64, or with `json` the JSON they hold. */
function fileValue(f: CommandFlag, from: string, bytes: Uint8Array): unknown {
  if (!f.file?.json) return Buffer.from(bytes).toString("base64");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw new UsageError(`--${f.name}: ${from} isn't JSON (${(e as Error).message}).`);
  }
}

/**
 * Reads the files that file flags name (`--photo me.jpg`), as base64 or, for a `json` one, the JSON they hold, each
 * checked against its size before it is read. `-` reads stdin, and nothing on it is an error. The word that sends
 * null (`--photo none`, in any capitals) reads nothing; a file called that way is `./none`, and one called `-` is `./-`.
 */
export async function readFileFlags(spec: CommandSpec, parsed: Parsed): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const f of spec.flags ?? []) {
    const v = parsed.flags[f.name];
    if (!f.file || typeof v !== "string" || isUnset(f, v)) continue;
    if (v === "-") {
      const usage = [`fontego ${spec.name}`, ...(spec.args ?? []).filter((a) => !a.optional).map((a) => a.name), `--${f.name} -`].join(" ");
      out[f.name] = fileValue(f, "what came on stdin", await readStdinBytes(`--${f.name}`, usage, f.file.maxBytes));
      continue;
    }
    const file = Bun.file(v);
    let size: number;
    try {
      const st = await file.stat();
      if (!st.isFile()) throw new UsageError(`--${f.name}: ${v} isn't a file.`);
      size = st.size;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError(`--${f.name}: there is no file ${v} (or it can't be read).${f.unset ? ` To send none, write --${f.name} ${f.unset}.` : ""}`);
    }
    if (size > f.file.maxBytes) {
      throw new UsageError(`--${f.name}: ${v} is ${sizeText(size)}; this Fontego takes at most ${sizeText(f.file.maxBytes)}. Make it smaller first.`);
    }
    out[f.name] = fileValue(f, v, new Uint8Array(await file.arrayBuffer()));
  }
  return out;
}

export async function runCommand(spec: CommandSpec, parsed: Parsed, client: Client, opts: { json: boolean }): Promise<void> {
  // stdin can be read once: two values that would both come from it is a mistake, said before reading either.
  const readers = stdinReaders(spec, parsed);
  if (!READS_STDIN.has(spec.name)) {
    const left = (spec.args ?? []).find((a) => readers.includes(a.name));
    if (left) throw new UsageError(`${left.name} is missing, and this fontego reads stdin only for ${[...READS_STDIN].map((n) => `fontego ${n}`).join(" and ")}: ${usageLine(spec)}`);
  }
  if (readers.length > 1) throw new UsageError(`Only one value can come from stdin, and ${readers.join(" and ")} would: give the others here. ${usageLine(spec)}`);
  // A secret left out is asked for; it lands in parsed, so trying the command again doesn't ask twice.
  for (const a of spec.args ?? []) {
    if (parsed.args[a.name] !== undefined) continue;
    if (a.secret) parsed.args[a.name] = await readSecret(a.name, opts.json);
    else if (a.stdin) parsed.args[a.name] = await readStdin(a.name, usageLine(spec));
  }
  const req = buildRequest(spec, parsed, await readFileFlags(spec, parsed));
  const res = await client.call(req.method, req.path, { query: req.query, body: req.body });
  const shown = Object.fromEntries(Object.entries(parsed.args).filter(([name]) => !spec.args?.find((a) => a.name === name)?.secret));
  const vars: TemplateVars = { url: client.baseUrl, ...shown, ...parsed.flags };

  if (spec.output.kind === "raw") {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!opts.json) {
      // Piped or redirected, the very same bytes. On a terminal, a file someone else wrote could act on it: text is
      // shown without control characters, and anything else is only written to a file.
      if (process.stdout.isTTY) {
        const text = textContent(bytes);
        if (text === null) throw new UsageError(`That isn't text, so it isn't shown here. Save it: ${usageLine(spec)} > FILE`);
        if (unsafeForTerminal(text)) return void process.stdout.write(forPerson(text));
      }
      process.stdout.write(bytes);
      return;
    }
    const meta = Object.fromEntries(Object.entries(spec.output.meta ?? {}).map(([k, header]) => [k, res.headers.get(header)]));
    // "content" only when it gives back the very same bytes; anything else (Latin-1, a BOM...) goes as base64.
    const content = textContent(bytes);
    console.log(
      JSON.stringify({ ...meta, text: content !== null, ...(content !== null ? { content } : { contentBase64: Buffer.from(bytes).toString("base64") }) }, null, 2),
    );
    return;
  }

  const data: unknown = (res.headers.get("content-type") ?? "").includes("json") ? await res.json() : await res.text();
  console.log(opts.json ? JSON.stringify(data, null, 2) : renderOutput(spec.output, data, vars, terminalWidth()));
}
