// The small template language commands use to print answers. It only reads values and formats them; it can't run
// anything. The server checks its templates with checkTemplate, and the CLI renders them with renderTemplate.
//
//   {path}                a field of the answer (or of the current row): {name}, {author.email}
//   {$NAME}               a value the CLI knows: an argument or flag of the command ({$WORKSPACE}), or {$url}
//   {field|filter|...}    filters, applied left to right:
//     short               the first 10 characters (commit ids)
//     date, datetime      2026-11-16, 2026-11-16 21:04: in the time zone of whoever prints it (dates.ts)
//     firstLine           the first line
//     bytes               1234 → 1.2 KB
//     dash                "-" when empty
//     if:TEXT             TEXT when the value is set and not false, otherwise nothing
//     or:PATH             the value at PATH when this one is empty
//     map:a=x,b=y         x for a, y for b, nothing for anything else
//     join, join:FIELD    a list as one text, "a, b": its items, or that field of each ({workspaces|join:slug})
//     relative            a date from now, by the clock of whoever prints it: "in 89 days", "3 hours ago"

import { localDate, localDateTime } from "./dates.ts";

export type TemplateVars = Record<string, unknown>;

const TOKEN = /\{([^{}]*)\}/g;
const FILTERS_WITH_ARG = new Set(["if", "or", "map"]);
const FILTERS = new Set(["short", "date", "datetime", "firstLine", "bytes", "dash", "join", "relative", ...FILTERS_WITH_ARG]);

function valueAt(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const key of path.split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const empty = (v: unknown) => v === null || v === undefined || v === "";

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function bytes(v: unknown): string {
  if (typeof v !== "number") return "";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far a date is from now, in the largest whole unit: "in 89 days", "in 5 hours", "3 minutes ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  const ms = at - now;
  const span = Math.abs(ms);
  const [n, unit] = span >= DAY ? [Math.round(span / DAY), "day"] : span >= HOUR ? [Math.round(span / HOUR), "hour"] : [Math.max(1, Math.round(span / MINUTE)), "minute"];
  const amount = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ms < 0 ? `${amount} ago` : `in ${amount}`;
}

function applyFilter(v: unknown, filter: string, data: unknown, vars: TemplateVars): unknown {
  const colon = filter.indexOf(":");
  const name = colon < 0 ? filter : filter.slice(0, colon);
  const arg = colon < 0 ? "" : filter.slice(colon + 1);
  switch (name) {
    case "short":
      return text(v).slice(0, 10);
    case "date":
      return empty(v) ? "" : localDate(text(v));
    case "datetime":
      return empty(v) ? "" : localDateTime(text(v));
    case "firstLine":
      return text(v).split("\n")[0];
    case "bytes":
      return bytes(v);
    case "relative":
      return empty(v) ? "" : relativeTime(text(v));
    case "dash":
      return empty(v) ? "-" : v;
    case "if":
      return !empty(v) && v !== false ? arg : "";
    case "or":
      return empty(v) ? resolve(arg, data, vars) : v;
    case "join":
      return Array.isArray(v) ? v.map((item) => text(arg ? valueAt(item, arg) : item)).filter((t) => t !== "").join(", ") : v;
    case "map": {
      for (const pair of arg.split(",")) {
        const eq = pair.indexOf("=");
        if (eq >= 0 && pair.slice(0, eq) === text(v)) return pair.slice(eq + 1);
      }
      return "";
    }
    default:
      return v;
  }
}

function resolve(source: string, data: unknown, vars: TemplateVars): unknown {
  return source.startsWith("$") ? vars[source.slice(1)] : valueAt(data, source);
}

/** Fills a template from one object (an answer, or one row of it) and the CLI's variables. */
export function renderTemplate(template: string, data: unknown, vars: TemplateVars = {}): string {
  return template.replace(TOKEN, (_, expr: string) => {
    const [source = "", ...filters] = expr.split("|");
    let v = resolve(source.trim(), data, vars);
    for (const f of filters) v = applyFilter(v, f, data, vars);
    return text(v);
  });
}

/** The $variables a template uses, without the $. */
export function templateVars(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const source = m[1]!.split("|")[0]!.trim();
    if (source.startsWith("$")) out.push(source.slice(1));
  }
  return out;
}

/** What is wrong with a template; an empty list means it is fine. */
export function checkTemplate(template: string): string[] {
  const problems: string[] = [];
  const stray = template.replace(TOKEN, "");
  if (stray.includes("{") || stray.includes("}")) problems.push(`unbalanced braces in "${template}"`);
  for (const m of template.matchAll(TOKEN)) {
    const [source = "", ...filters] = m[1]!.split("|");
    if (!/^\$?[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(source.trim())) problems.push(`"{${m[1]}}" doesn't name a field`);
    for (const f of filters) {
      const name = f.split(":")[0]!;
      if (!FILTERS.has(name)) problems.push(`unknown filter "${name}" in "{${m[1]}}"`);
      else if (FILTERS_WITH_ARG.has(name) && !f.includes(":")) problems.push(`filter "${name}" needs a value, as in ${name}:...`);
    }
  }
  return problems;
}
