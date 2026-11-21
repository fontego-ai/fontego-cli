// What keeps a credential where it belongs, tested piece by piece inside this process: the addresses fontego accepts,
// where the client sends a request, and the private files of this machine. The sign-in tests (login.test.ts) check
// the same rules through the commands.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLogin, fetchInstance, StoredAuth } from "../src/auth.ts";
import { Client, ClientError } from "../src/client.ts";
import { credentialStore, instanceUrl, isLoopback, saveInstance, sameInstance, type Credential } from "../src/config.ts";
import { tempDir } from "./server.ts";

const dirs: string[] = [];
const scratch = (prefix: string) => {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
};
// A renewal takes its lock and saves the account's address in this process's config folder: a throwaway one.
const realConfig = process.env.XDG_CONFIG_HOME;
let home: string;
beforeAll(() => {
  home = scratch("fontego-safety-home-");
  process.env.XDG_CONFIG_HOME = home;
});
afterAll(() => {
  if (realConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realConfig;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A session whose access token has expired, so the next request renews it */
const expiredSession = (refreshToken = "fontego_rt_secret"): Credential => ({
  type: "session",
  accessToken: "fontego_at_old",
  accessExpiresAt: new Date(0).toISOString(),
  refreshToken,
  sessionId: 1,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  email: "ana@example.org",
});

/** A server that notes every request it gets ("METHOD /path authorization body") and answers with `answer`. */
function recorder(answer: (req: Request) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization") ?? ""} ${await req.text()}`.trim());
      return answer(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, seen, stop: () => server.stop(true) };
}

/** The error code of a promise that should fail */
const failsWith = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e) => (e instanceof ClientError ? e.code : String(e)),
  );

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

describe("where the client sends a request", () => {
  test("only to the instance's origin, under its /v1/: a path can't take the token to another server", async () => {
    const instance = recorder();
    const elsewhere = recorder();
    const client = new Client(instance.url, "fontego_at_secret");
    expect(await failsWith(client.call("GET", `@127.0.0.1:${elsewhere.port}/v1/x`))).toBe("bad_path");
    expect(await failsWith(client.call("GET", "/v1/../admin"))).toBe("bad_path");
    expect(await failsWith(client.call("GET", "/v1/%2e%2e/admin"))).toBe("bad_path");
    expect(await failsWith(client.call("GET", "v1/x"))).toBe("bad_path");
    expect(elsewhere.seen).toEqual([]);
    expect(instance.seen).toEqual([]);
    expect((await client.call("GET", "/v1/workspaces")).status).toBe(200);
    expect(instance.seen).toEqual(["GET /v1/workspaces Bearer fontego_at_secret"]);
    instance.stop();
    elsewhere.stop();
  });

  test("an instance under a path keeps its requests under that path", async () => {
    const server = recorder();
    const client = new Client(`${server.url}/team`, "fontego_at_secret");
    expect(await failsWith(client.call("GET", "/../v1/x"))).toBe("bad_path");
    expect(server.seen).toEqual([]);
    await client.call("GET", "/v1/x");
    expect(server.seen).toEqual(["GET /team/v1/x Bearer fontego_at_secret"]);
    server.stop();
  });
});

describe("redirects", () => {
  /** A server that sends everything to `to` with `status`, as a hostile or misconfigured one could */
  const redirecting = (to: string, status = 307) => recorder(() => new Response(null, { status, headers: { location: `${to}/stolen` } }));

  test("an API call that is redirected fails, and its body and token go nowhere", async () => {
    const sink = recorder();
    const server = redirecting(sink.url);
    const client = new Client(server.url, "fontego_at_secret");
    expect(await failsWith(client.call("POST", "/v1/account/password", { body: { password: "correct horse" } }))).toBe("redirected");
    expect(await failsWith(client.me())).toBe("redirected");
    expect(await failsWith(client.personEvents(() => {}))).toBe("redirected");
    expect(sink.seen).toEqual([]);
    server.stop();
    sink.stop();
  });

  test("a renewal that is redirected keeps its refresh token, and the credential", async () => {
    const sink = recorder();
    const server = redirecting(sink.url, 308);
    const env = { XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" };
    const store = await credentialStore(env);
    const cred = expiredSession();
    await store.set(server.url, cred);
    const auth = new StoredAuth({ ...instance(server.url), email: "ana@example.org" }, store, cred);
    expect(await failsWith(auth.token())).toBe("redirected");
    expect(sink.seen).toEqual([]);
    expect(await store.get(server.url)).toEqual(cred);
    server.stop();
    sink.stop();
  });

  test("signing in follows no redirect either, and says where the server points", async () => {
    const sink = recorder();
    const server = redirecting(sink.url);
    expect(await failsWith(deviceLogin(server.url, { waiting: () => {} }))).toBe("redirected");
    const moved = await fetchInstance(server.url).catch((e) => e as ClientError);
    expect(moved).toMatchObject({ code: "redirected", hint: `If that is the right address: fontego login ${sink.url}/stolen` });
    expect(sink.seen).toEqual([]);
    server.stop();
    sink.stop();
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
