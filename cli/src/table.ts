// Tables for a person live in core (core/src/table.ts), so the server's MCP prints them as this CLI does. Here, only
// the width of this terminal.

export { columnWidths, formatTable, wrapCell } from "@fontego/core";

/** The width to fit a table in: the terminal's, when stdout is one; none when it goes to a pipe or a file. */
export const terminalWidth = (): number | undefined => (process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : undefined);
