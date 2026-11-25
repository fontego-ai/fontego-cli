// How a declared command's answer reads for a person: its output description (commands.ts) filled from the answer
// with the templates (template.ts). The CLI prints it, fitted to its terminal; the server's MCP gives the same text to
// an agent, with no width, as the CLI does through a pipe.

import type { CommandColumn, CommandDetails, CommandOutput } from "./commands.ts";
import { formatTable } from "./table.ts";
import { renderTemplate, type TemplateVars } from "./template.ts";

/** The list in a field of the answer (or the answer itself, when it is a list); nothing else counts as one. */
export function rowsOf(data: unknown, field: string | undefined): unknown[] {
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

function table(rows: unknown[], all: CommandColumn[], details: CommandDetails | undefined, vars: TemplateVars, width: number | undefined): string {
  const rendered = rows.map((r) => all.map((c) => renderTemplate(c.value, r, vars)));
  // An optional column nobody filled is left out.
  const keep = all.map((c, i) => !c.optional || rendered.some((row) => row[i] !== ""));
  const header = all.filter((_, i) => keep[i]).map((c) => c.header);
  const cells = rendered.map((row) => row.filter((_, i) => keep[i]));
  return formatTable(header, cells, { width, under: (i) => detailLines(details, rows[i], vars) });
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

/**
 * The answer as text for a person (with --json the CLI prints the answer as the API sent it). `vars`: the command's
 * arguments and flags, and `url`. `width`: the terminal's, which a table fits in; none for a pipe, a file or an agent.
 */
export function renderOutput(output: CommandOutput, data: unknown, vars: TemplateVars, width?: number): string {
  switch (output.kind) {
    case "table": {
      const rows = rowsOf(data, output.rows);
      return withFooter(rows.length ? table(rows, output.columns, output.details, vars, width) : (output.empty ?? "(none)"), output.footer, data, vars);
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
