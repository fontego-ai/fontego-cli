// What keeps a credential where it belongs, tested piece by piece inside this process: the addresses fontego accepts
// and the private files of this machine. The sign-in tests (login.test.ts) check the same rules through the commands.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClientError } from "../src/client.ts";
import { credentialStore, instanceUrl, isLoopback, saveInstance, sameInstance } from "../src/config.ts";
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

/** The error code instanceUrl gives for an address, or the address it keeps */
const checked = (input: string, allowHttp = false) => {
  try {
    return instanceUrl(input, { allowHttp });
  } catch (e) {
    return (e as ClientError).code;
  }
};

describe("the addresses fontego accepts", () => {
  test("https anywhere, kept as origin and path without the trailing slash", () => {
    expect(checked("https://fontego.example.org/")).toBe("https://fontego.example.org");
    expect(checked(" HTTPS://Fontego.Example.org:443/team/ ")).toBe("https://fontego.example.org/team");
  });

  test("plain http only on this machine, unless the person accepts it", () => {
    for (const local of ["http://127.0.0.1:8740", "http://127.9.9.9", "http://localhost:8740/", "http://[::1]:8740"]) expect(checked(local)).toStartWith("http://");
    for (const remote of ["http://fontego.example.org", "http://192.168.1.10:8740", "http://0.0.0.0:8740", "http://localhost.example.org"]) {
      expect(checked(remote)).toBe("insecure_url");
      expect(checked(remote, true)).toStartWith("http://");
    }
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("128.0.0.1")).toBe(false);
  });

  test("no user name, password, query or fragment, and only http(s)", () => {
    // It reads as good.example, but it goes to evil.example
    expect(checked("https://good.example@evil.example")).toBe("bad_url");
    expect(checked("https://user:pass@fontego.example.org")).toBe("bad_url");
    expect(checked("https://fontego.example.org/?next=https://evil.example")).toBe("bad_url");
    expect(checked("https://fontego.example.org/#x")).toBe("bad_url");
    for (const other of ["file:///etc/passwd", "javascript:alert(1)", "ftp://fontego.example.org", "fontego.example.org"]) expect(checked(other)).toBe("bad_url");
  });

  test("the same Fontego however it is written", () => {
    expect(sameInstance("https://Fontego.example.org/", "https://fontego.example.org")).toBe(true);
    expect(sameInstance("https://fontego.example.org", "https://fontego.example.org.evil.example")).toBe(false);
    expect(sameInstance("not an address", "not an address")).toBe(false);
  });
});

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
