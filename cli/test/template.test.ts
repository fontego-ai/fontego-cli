// The template language of declared commands: what each filter makes of a value. Most of it runs in cli.test.ts, on
// the server's own commands; here, the cases those don't reach.

import { expect, test } from "bun:test";
import { checkTemplate, renderTemplate } from "@fontego/core";

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
