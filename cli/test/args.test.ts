// Reading the command line: which words are options and which are values.

import { describe, expect, test } from "bun:test";
import { isFlag, leadingWords, parseCommand, UsageError, type Usage } from "../src/args.ts";

const SET: Usage = {
  name: "admin settings set",
  summary: "",
  group: "",
  args: [{ name: "KEY" }, { name: "VALUE" }],
  flags: [
    { name: "days", type: "number", value: "N", description: "" },
    { name: "force", short: "f", type: "boolean", description: "" },
  ],
};

describe("options and values", () => {
  test("a negative number is a value, not an option: an option's letter is never a digit", () => {
    for (const n of ["-3", "-0.5", "-.5", "-10e2"]) expect(isFlag(n)).toBe(false);
    for (const f of ["-f", "--days", "--days=3", "-x"]) expect(isFlag(f)).toBe(true);
    expect(isFlag("-")).toBe(false); // stdin's name
    expect(parseCommand(SET, ["sessions.web.idleDays", "-3"]).args).toEqual({ KEY: "sessions.web.idleDays", VALUE: "-3" });
    expect(parseCommand(SET, ["k", "-0.5", "-f"])).toMatchObject({ args: { KEY: "k", VALUE: "-0.5" }, flags: { force: true } });
    expect(parseCommand(SET, ["k", "v", "--days", "-3"]).flags).toEqual({ days: -3 });
    expect(leadingWords(["admin", "settings", "set", "k", "-3", "--json"])).toEqual(["admin", "settings", "set", "k", "-3"]);
  });

  test("an option the command doesn't have is still a usage error", () => {
    expect(() => parseCommand(SET, ["k", "-x"])).toThrow(UsageError);
    expect(() => parseCommand(SET, ["k", "v", "--nope"])).toThrow("has no option --nope");
  });
});
