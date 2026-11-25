// Tables for a person: the columns side by side, each as wide as its widest cell. On a terminal narrower than that,
// the widest columns get narrower and their cells go on as many lines as they need, broken at spaces, so every row
// stays in its place and nothing runs into the next line (`fontego admin settings`, with its long lists of paths, in
// 80 columns). Piped or written to a file there is no width, and nothing is broken: one row per line, for scripts.

/** Two spaces between columns */
const GAP = 2;
/** A column that wraps is never made narrower than this, nor than its header */
const NARROWEST = 12;

/** Columns a terminal shows, not characters: an accent made of two code points is one, a CJK character two. */
const widthOf = (text: string) => Bun.stringWidth(text);
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - widthOf(text)));
/** What a person sees as one character: an accent made of two code points, an emoji of several, never split */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How wide each column is, so that the table fits in `width` (when it can): the widest ones narrowed first. */
export function columnWidths(natural: number[], floors: number[], width: number | undefined): number[] {
  const total = (ws: number[]) => ws.reduce((a, b) => a + b, 0) + GAP * Math.max(0, ws.length - 1);
  if (width === undefined || total(natural) <= width) return natural;
  // The widest a column may be: lowered until the table fits, never taking a column below its floor.
  const at = (ceiling: number) => natural.map((n, i) => Math.min(n, Math.max(floors[i]!, ceiling)));
  // A column wider than the whole table never fits, so there is nothing to try above its width
  for (let ceiling = Math.min(Math.max(...natural) - 1, width); ceiling > 0; ceiling--) if (total(at(ceiling)) <= width) return at(ceiling);
  return at(0);
}

/** A cell in lines of at most `width` columns: broken at spaces, and a word longer than that wherever it has to. */
export function wrapCell(text: string, width: number): string[] {
  if (widthOf(text) <= width) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const joined = line ? `${line} ${word}` : word;
    if (widthOf(joined) <= width) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const { segment: ch } of GRAPHEMES.segment(word)) {
      if (widthOf(line + ch) > width && line) {
        lines.push(line);
        line = "";
      }
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A table: a header and its rows of cells, in `width` columns of a terminal when it is one. `under(i)` gives lines to
 * print under row i as they are (a commit's files), never wrapped.
 */
export function formatTable(header: string[], rows: string[][], opts: { width?: number; under?: (i: number) => string[] } = {}): string {
  // One by one: a list of a million rows is more arguments than a call takes
  const natural = header.map((h, c) => rows.reduce((widest, r) => Math.max(widest, widthOf(r[c] ?? "")), widthOf(h)));
  const floors = header.map((h, c) => Math.min(natural[c]!, Math.max(NARROWEST, widthOf(h))));
  const widths = columnWidths(natural, floors, opts.width);
  const last = header.length - 1;
  const lines = (cells: string[]) => {
    const wrapped = cells.map((cell, c) => (widths[c]! < natural[c]! ? wrapCell(cell, widths[c]!) : [cell]));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    return Array.from({ length: height }, (_, k) =>
      wrapped
        .map((w, c) => (c === last ? (w[k] ?? "") : pad(w[k] ?? "", widths[c]!)))
        .join(" ".repeat(GAP))
        .trimEnd(),
    );
  };
  return [...lines(header), ...rows.flatMap((row, i) => [...lines(row), ...(opts.under?.(i) ?? [])])].join("\n");
}

/** The width to fit a table in: the terminal's, when stdout is one; none when it goes to a pipe or a file. */
export const terminalWidth = (): number | undefined => (process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : undefined);
