// What fontego promises the program that runs it: the exit code of each kind of error answer.

import { expect, test } from "bun:test";
import { EXIT, exitOf } from "../src/output.ts";

test("each error answer leaves with its code: a refused file and an archived workspace are not allowed", () => {
  expect(exitOf(0, "unreachable")).toBe(EXIT.unreachable);
  expect(exitOf(401, "unauthenticated")).toBe(EXIT.signedOut);
  expect(exitOf(403, "token_scope")).toBe(EXIT.forbidden);
  expect(exitOf(404, "not_found")).toBe(EXIT.notFound);
  expect(exitOf(409, "conflict")).toBe(EXIT.conflict);
  expect(exitOf(409, "exists")).toBe(EXIT.conflict);
  expect(exitOf(409, "archived")).toBe(EXIT.forbidden);
  // A 422 that names a file is the server refusing it; one that names none is a value it doesn't take.
  for (const code of ["path_protected", "path_rejected", "secret_file", "file_too_large", "path_escapes"]) {
    expect(exitOf(422, code, { path: "a/b.md" })).toBe(EXIT.forbidden);
  }
  expect(exitOf(422, "invalid_icon")).toBe(EXIT.error);
  expect(exitOf(422, "invalid_icon", { path: 3 })).toBe(EXIT.error);
  expect(exitOf(413, "photo_too_large")).toBe(EXIT.forbidden);
  // Not there now, or too busy: try again later
  for (const status of [502, 503, 504]) expect(exitOf(status, "busy")).toBe(EXIT.unreachable);
  expect(exitOf(500, "internal")).toBe(EXIT.error);
  expect(exitOf(400, "invalid_json")).toBe(EXIT.error);
  expect(exitOf(429, "too_many_requests")).toBe(EXIT.error);
});
