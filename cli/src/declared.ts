// Commands the server declares (GET /v1/commands): kept per server in a cache, checked, and run as plain API calls.
// The CLI never runs anything a server sends; it only builds the request the description asks for and prints the
// answer with the description's templates.

import {
  checkTemplate,
  outputTemplates,
  textContent,
  pathParams,
  renderTemplate,
  splitTarget,
  templateVars,
  type CommandColumn,
  type CommandDetails,
  type CommandOutput,
  type CommandSpec,
  type CommandsManifest,
  type TemplateVars,
} from "@fontego/core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError, usageLine, type Parsed } from "./args.ts";
import type { Client } from "./client.ts";
import { readSecret, readStdin } from "./prompt.ts";

// --- The cache: one file per server ---

export interface CachedCommands extends CommandsManifest {
  url: string;
  fetchedAt: string;
  /** Who we are there, so help can leave out admin commands for everyone else */
  me: { email: string; isAdmin: boolean } | null;
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
    return c.url === url && Array.isArray(c.commands) ? c : null;
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
  const path = commandsCachePath(client.baseUrl);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cached, null, 2) + "\n");
  return cached;
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

/** What would keep this CLI from running a declared command; an empty list means it can. */
export function checkCommand(spec: CommandSpec, builtins: Iterable<string>): string[] {
  const out: string[] = [];
  const at = `fontego ${spec.name}`;
  const taken = new Set(builtins);
  for (const name of [spec.name, ...(spec.aliases ?? [])]) {
    if (taken.has(name.split(" ")[0]!)) out.push(`${at}: "${name}" clashes with a built-in command`);
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(spec.request.method)) out.push(`${at}: unknown method ${spec.request.method}`);
  if (!spec.request.path.startsWith("/v1/")) out.push(`${at}: the request must go to /v1`);
  const args = spec.args ?? [];
  const flags = spec.flags ?? [];
  for (const t of [...args.map((a) => a.to), ...flags.map((f) => f.to)]) {
    if (!/^(path|query|body)\.[A-Za-z0-9_]+$/.test(t)) out.push(`${at}: "${t}" is not a place in a request`);
  }
  for (const p of pathParams(spec.request.path)) {
    if (!args.some((a) => a.to === `path.${p}` && !a.optional)) out.push(`${at}: nothing fills {${p}} in ${spec.request.path}`);
  }
  for (const a of args) if (a.secret && !a.optional) out.push(`${at}: ${a.name} is a secret, so it must be optional (left out, it is asked for)`);
  for (const a of args) if (a.stdin && !a.optional) out.push(`${at}: ${a.name} comes from stdin when left out, so it must be optional`);
  for (const f of flags) {
    if (!["string", "number", "boolean"].includes(f.type)) out.push(`${at}: --${f.name} has an unknown type`);
    if (f.short && !/^[A-Za-z]$/.test(f.short)) out.push(`${at}: -${f.short} must be one letter`);
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

function encodeParam(value: string, spans: boolean): string {
  return spans ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
}

/** The request a command makes with these arguments and flags. */
export function buildRequest(spec: CommandSpec, parsed: Parsed): { method: string; path: string; query: URLSearchParams; body?: unknown } {
  const pathValues: Record<string, string> = {};
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let hasBody = false;

  const put = (to: string, value: string | number | boolean, set?: string | number | boolean) => {
    const { where, key } = splitTarget(to as never);
    if (where === "path") pathValues[key] = String(value);
    else if (where === "query") query.set(key, value === true ? String(set ?? "1") : String(value));
    else body[key] = value === true && set !== undefined ? set : value;
  };

  for (const a of spec.args ?? []) {
    if (a.to.startsWith("body.")) hasBody = true;
    const v = parsed.args[a.name];
    if (v !== undefined) put(a.to, v);
  }
  for (const f of spec.flags ?? []) {
    if (f.to.startsWith("body.")) hasBody = true;
    const v = parsed.flags[f.name] ?? f.default;
    if (v !== undefined) put(f.to, v, f.set);
  }

  const path = spec.request.path.replace(/\{(\+?)([A-Za-z0-9_]+)\}/g, (_, plus: string, key: string) => {
    const v = pathValues[key];
    if (v === undefined) throw new UsageError(usageLine(spec));
    return encodeParam(v, plus === "+");
  });
  return { method: spec.request.method, path, query, ...(hasBody ? { body } : {}) };
}

function rowsOf(data: unknown, field: string | undefined): unknown[] {
  const v = field ? (data as Record<string, unknown> | null)?.[field] : data;
  return Array.isArray(v) ? v : [];
}

/** The lines under one row: one per item of its list, then how many more there are when the list was cut. */
function detailLines(details: CommandDetails | undefined, row: unknown, vars: TemplateVars): string[] {
  if (!details) return [];
  const items = rowsOf(row, details.rows);
  const lines = items.map((item) => `  ${renderTemplate(details.line, item, vars)}`);
  const total = details.total !== undefined ? Number((row as Record<string, unknown> | null)?.[details.total]) : NaN;
  if (Number.isFinite(total) && total > items.length) lines.push(`  … ${total - items.length} more`);
  return lines;
}

function table(rows: unknown[], all: CommandColumn[], details: CommandDetails | undefined, vars: TemplateVars): string {
  const rendered = rows.map((r) => all.map((c) => renderTemplate(c.value, r, vars)));
  // An optional column nobody filled is left out.
  const keep = all.map((c, i) => !c.optional || rendered.some((row) => row[i] !== ""));
  const columns = all.filter((_, i) => keep[i]);
  const cells = rendered.map((row) => row.filter((_, i) => keep[i]));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((row) => row[i]!.length)));
  const line = (values: string[]) =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(columns.map((c) => c.header)), ...cells.flatMap((row, i) => [line(row), ...detailLines(details, rows[i], vars)])].join("\n");
}

/** A record line (or a footer) is left out when every field in it came out empty. */
function recordLine(template: string, data: unknown, vars: TemplateVars): string | null {
  const fields = template.match(/\{[^{}]*\}/g) ?? [];
  if (fields.length && fields.every((f) => renderTemplate(f, data, vars) === "")) return null;
  return renderTemplate(template, data, vars);
}

const withFooter = (text: string, footer: string[] | undefined, data: unknown, vars: TemplateVars) => {
  const lines = (footer ?? []).map((f) => recordLine(f, data, vars)).filter((l): l is string => l !== null);
  return lines.length ? `${text}\n\n${lines.join("\n")}` : text;
};

/** Text for a person; with --json the answer is printed as the API sent it. */
export function renderOutput(output: CommandOutput, data: unknown, vars: TemplateVars): string {
  switch (output.kind) {
    case "table": {
      const rows = rowsOf(data, output.rows);
      return withFooter(rows.length ? table(rows, output.columns, output.details, vars) : (output.empty ?? "(none)"), output.footer, data, vars);
    }
    case "lines": {
      const rows = rowsOf(data, output.rows);
      const text = rows.length
        ? rows.flatMap((r) => [renderTemplate(output.line, r, vars), ...detailLines(output.details, r, vars)]).join("\n")
        : (output.empty ?? "(none)");
      return withFooter(text, output.footer, data, vars);
    }
    case "record": {
      const lines = output.lines.map((l) => recordLine(l, data, vars)).filter((l): l is string => l !== null);
      const items = output.list ? rowsOf(data, output.list.rows) : [];
      if (output.list && items.length) {
        lines.push("", renderTemplate(output.list.title, data, vars), ...items.map((r) => `  ${renderTemplate(output.list!.line, r, vars)}`.trimEnd()));
      }
      return lines.join("\n");
    }
    case "message":
      return renderTemplate(output.text, data, vars);
    case "raw":
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
}

export async function runCommand(spec: CommandSpec, parsed: Parsed, client: Client, opts: { json: boolean }): Promise<void> {
  // A secret left out is asked for; it lands in parsed, so trying the command again doesn't ask twice.
  for (const a of spec.args ?? []) {
    if (parsed.args[a.name] !== undefined) continue;
    if (a.secret) parsed.args[a.name] = await readSecret(a.name, opts.json);
    else if (a.stdin) parsed.args[a.name] = await readStdin(a.name, usageLine(spec));
  }
  const req = buildRequest(spec, parsed);
  const res = await client.call(req.method, req.path, { query: req.query, body: req.body });
  const shown = Object.fromEntries(Object.entries(parsed.args).filter(([name]) => !spec.args?.find((a) => a.name === name)?.secret));
  const vars: TemplateVars = { url: client.baseUrl, ...shown, ...parsed.flags };

  if (spec.output.kind === "raw") {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!opts.json) {
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
  console.log(opts.json ? JSON.stringify(data, null, 2) : renderOutput(spec.output, data, vars));
}
