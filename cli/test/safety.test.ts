// What keeps a credential where it belongs, tested piece by piece inside this process: the private files of this
// machine. The sign-in tests (login.test.ts) check the same rules through the commands.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialStore, saveInstance } from "../src/config.ts";
import { tempDir } from "./server.ts";

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const instance = (url: string) => ({ alias: "here", url, name: "Here", email: null, addedAt: new Date().toISOString() });

describe("the private files of this machine", () => {
  test("a config folder others can look into is closed again, and nothing is left on the way", async () => {
    const home = scratch("fontego-safety-dir-");
    const env = { XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" };
    mkdirSync(join(home, "fontego"), { mode: 0o755 });
    chmodSync(join(home, "fontego"), 0o755);
    saveInstance(instance("https://fontego.example.org"), {}, env);
    await (await credentialStore(env)).set("https://fontego.example.org", { type: "token", token: "fontego_pt_x" });
    expect(statSync(join(home, "fontego")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "fontego", "credentials.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, "fontego")).sort()).toEqual(["config.json", "credentials.json"]);
  });

  test("a link planted where the file is written on its way is never written through", async () => {
    const home = scratch("fontego-safety-link-");
    const env = { XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" };
    const victim = join(scratch("fontego-safety-victim-"), "elsewhere");
    writeFileSync(victim, "untouched\n");
    mkdirSync(join(home, "fontego"), { mode: 0o700 });
    // The name a writer that only adds its pid would use
    symlinkSync(victim, join(home, "fontego", `credentials.json.${process.pid}.tmp`));
    await (await credentialStore(env)).set("https://fontego.example.org", { type: "token", token: "fontego_pt_secret" });
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(readFileSync(join(home, "fontego", "credentials.json"), "utf8")).toContain("fontego_pt_secret");
    expect(existsSync(victim)).toBe(true);
  });
});
