// The template language of declared commands: what each filter makes of a value. Most of it runs in cli.test.ts, on
// the server's own commands; here, the cases those don't reach.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { checkTemplate, renderTemplate } from "@fontego/core";

const CORE = join(import.meta.dir, "../../core/src/index.ts");

/** What an expression of core gives in a process on that time zone and language (bun test always runs in UTC). */
function where(tz: string, expression: string): unknown {
  const code = `import * as core from ${JSON.stringify(CORE)}; console.log(JSON.stringify(${expression}));`;
  const r = Bun.spawnSync([process.execPath, "-e", code], { env: { PATH: process.env.PATH!, TZ: tz, LANG: "es_ES.UTF-8", LC_ALL: "es_ES.UTF-8" } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

test("dates and times are written in the time zone of whoever prints them, the same way in every language", () => {
  const answer = { at: "2026-11-22T23:30:05Z", day: "2026-11-16", none: null };
  const template = "{at|datetime} · {at|date} · {day|date} · {none|datetime|dash}";
  expect(where("UTC", `core.renderTemplate(${JSON.stringify(template)}, ${JSON.stringify(answer)})`)).toBe("2026-11-22 23:30 · 2026-11-22 · 2026-11-16 · -");
  // Madrid is an hour ahead in November: already the next day. A calendar date stays the day it is.
  expect(where("Europe/Madrid", `core.renderTemplate(${JSON.stringify(template)}, ${JSON.stringify(answer)})`)).toBe("2026-11-23 00:30 · 2026-11-23 · 2026-11-16 · -");
  expect(where("America/New_York", `[core.localDateTime("2026-11-22T23:30:05Z"), core.localTime("2026-11-22T23:30:05Z")]`)).toEqual(["2026-11-22 18:30", "18:30:05"]);
  // Something that isn't a date comes back as it was
  expect(where("Europe/Madrid", `[core.localDate("soon"), core.renderTemplate("{x|datetime}", { x: "soon" })]`)).toEqual(["soon", "soon"]);
});

test("join puts a list in one text: its items, or one field of each, leaving out empty ones", () => {
  expect(renderTemplate("{tags|join}", { tags: ["a", "b"] })).toBe("a, b");
  expect(renderTemplate("{ws|join:slug}", { ws: [{ slug: "alpha" }, {}, { slug: "beta" }] })).toBe("alpha, beta");
  expect(renderTemplate("{ws|join:owner.email}", { ws: [{ owner: { email: "ana@example.org" } }] })).toBe("ana@example.org");
  expect(renderTemplate("{ws|join:slug|dash}", { ws: [] })).toBe("-");
  // Not a list: left as it is
  expect(renderTemplate("{name|join}", { name: "Ana" })).toBe("Ana");
  expect(checkTemplate("{ws|join}")).toEqual([]);
  expect(checkTemplate("{ws|join:slug}")).toEqual([]);
});
