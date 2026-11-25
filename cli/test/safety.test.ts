// What keeps a credential where it belongs, tested piece by piece inside this process: the addresses fontego accepts,
// where the client sends a request, what it opens in the browser, the renewal lock, and the private files of this
// machine. The sign-in tests (login.test.ts) check
// the same rules through the commands.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  desktopEntryPath,
  deviceLogin,
  fetchInstance,
  instanceLink,
  lockName,
  openerCommand,
  openInBrowser,
  openPrivately,
  replaceCredential,
  secretLinkWay,
  StoredAuth,
} from "../src/auth.ts";
import { Client, ClientError } from "../src/client.ts";
import { credentialStore, instanceUrl, isLoopback, saveInstance, sameInstance, withLock, type Credential } from "../src/config.ts";
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

/** A FONTEGO_BROWSER that writes down what it was asked to open, one line each */
function fakeBrowser() {
  const dir = scratch("fontego-safety-browser-");
  const log = join(dir, "opened.log");
  const program = join(dir, "browser.sh");
  writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
  const opened = async () => {
    await Bun.sleep(300);
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  };
  return { program, opened };
}

describe("what fontego opens in the browser", () => {
  const link = "https://fontego.example.org/#/login?code=abc&next=%2Fw%2Fnotes";

  test("the command for each system runs no shell, so & in a link is just a character", () => {
    expect(openerCommand(link, "win32", {})).toEqual(["rundll32", "url.dll,FileProtocolHandler", link]);
    expect(openerCommand(link, "darwin", {})).toEqual(["open", link]);
    expect(openerCommand(link, "linux", {})).toEqual(["xdg-open", link]);
    expect(openerCommand(link, "win32", { FONTEGO_BROWSER: "firefox" })).toEqual(["firefox", link]);
    expect(openerCommand(link, "linux", { FONTEGO_BROWSER: "none" })).toBeNull();
  });

  test("only http(s) links open", async () => {
    const browser = fakeBrowser();
    const env = { FONTEGO_BROWSER: browser.program };
    for (const other of ["file:///etc/passwd", "javascript:alert(1)", "ms-settings:", "not a link"]) expect(openInBrowser(other, env)).toBe(false);
    expect(openInBrowser("https://fontego.example.org/a b", env)).toBe(true);
    // Written by the URL parser: nothing a program would split on
    expect(await browser.opened()).toEqual(["https://fontego.example.org/a%20b"]);
  });

  test("a secret link goes through the private page, unless the browser is in a sandbox that can't read it", () => {
    const way = (path: string | null, exec?: string) => secretLinkWay("linux", { path, exec });
    expect(way("/usr/share/applications/google-chrome.desktop", "Exec=/usr/bin/google-chrome-stable %U")).toBe("page");
    // Ubuntu's Firefox is a snap, with a /tmp of its own; flatpak browsers too, system-wide or the person's own
    expect(way("/var/lib/snapd/desktop/applications/firefox_firefox.desktop")).toBe("direct");
    expect(way("/var/lib/flatpak/exports/share/applications/org.mozilla.firefox.desktop")).toBe("direct");
    expect(way("/home/ana/.local/share/flatpak/exports/share/applications/com.google.Chrome.desktop")).toBe("direct");
    // A copy of their entry elsewhere still runs them sandboxed
    expect(way("/home/ana/.local/share/applications/firefox.desktop", "Exec=/snap/bin/firefox %u")).toBe("direct");
    expect(way("/home/ana/.local/share/applications/browser.desktop", "Exec=/usr/bin/flatpak run --branch=stable org.mozilla.firefox @@u %u @@")).toBe("direct");
    // FONTEGO_BROWSER naming a snap's program
    expect(way("/snap/bin/firefox")).toBe("direct");
    // Not known: the page
    expect(way(null)).toBe("page");
    expect(secretLinkWay("darwin", { path: "/snap/bin/firefox" })).toBe("page");
    expect(secretLinkWay("win32", { path: "/var/lib/snapd/desktop/applications/x.desktop" })).toBe("page");
  });

  test("the default browser's desktop entry is looked for as XDG says: data home, then each data dir", () => {
    const there = (paths: string[]) => (p: string) => paths.includes(p);
    const env = { HOME: "/home/ana", XDG_DATA_DIRS: "/usr/share:/var/lib/snapd/desktop" };
    expect(desktopEntryPath("firefox_firefox.desktop", env, there(["/var/lib/snapd/desktop/applications/firefox_firefox.desktop"]))).toBe(
      "/var/lib/snapd/desktop/applications/firefox_firefox.desktop",
    );
    expect(desktopEntryPath("b.desktop", env, there(["/usr/share/applications/b.desktop", "/home/ana/.local/share/applications/b.desktop"]))).toBe(
      "/home/ana/.local/share/applications/b.desktop",
    );
    expect(desktopEntryPath("b.desktop", { HOME: "/h" }, there(["/usr/local/share/applications/b.desktop"]))).toBe("/usr/local/share/applications/b.desktop");
    expect(desktopEntryPath("b.desktop", env, there([]))).toBeNull();
  });

  test("to a sandboxed browser the link goes straight, with no page and no wait", async () => {
    const browser = fakeBrowser();
    const started = Date.now();
    let told = false;
    expect(await openPrivately(link, () => (told = true), { FONTEGO_BROWSER: browser.program }, "direct")).toBe(true);
    expect(told).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await browser.opened()).toEqual([link]);
  });

  test("a link an instance gives is opened only on that instance's origin", () => {
    expect(instanceLink(link, "https://fontego.example.org")).toBe(link);
    expect(instanceLink("https://fontego.example.org/team/#/login?code=a", "https://fontego.example.org/team")).toContain("/team/");
    for (const foreign of ["https://evil.example/#/login?code=a", "http://fontego.example.org/#/login", "https://fontego.example.org:8443/", "file:///etc/passwd"]) {
      expect(() => instanceLink(foreign, "https://fontego.example.org")).toThrow(/won't open it/);
    }
  });
});

describe("the renewal lock", () => {
  const lockFile = (name: string) => join(home, "fontego", "locks", `${name}.lock`);
  /** Leaves a lock as another process would, `age` ms old */
  const plant = (name: string, owner: unknown, age = 0) => {
    mkdirSync(join(home, "fontego", "locks"), { recursive: true });
    writeFileSync(lockFile(name), JSON.stringify(owner));
    const t = (Date.now() - age) / 1000;
    utimesSync(lockFile(name), t, t);
  };
  /** Takes the lock and says when it got in */
  const enter = (name: string) => {
    let inside = false;
    const done = withLock(name, async () => {
      inside = true;
    });
    return { done, inside: () => inside };
  };

  test("a lock whose process still runs is never taken from it, however long it has held it", async () => {
    // A renewal slower than half a minute (a slow server) used to lose its lock to the next one
    plant("busy", { pid: process.pid, host: hostname(), id: "other" }, 60_000);
    const waiting = enter("busy");
    await Bun.sleep(600);
    expect(waiting.inside()).toBe(false);
    rmSync(lockFile("busy")); // its holder lets go
    await waiting.done;
    expect(waiting.inside()).toBe(true);
  });

  test("a lock left by a process that is gone is taken at once", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    plant("left", { pid: gone.pid, host: hostname(), id: "dead" });
    const started = Date.now();
    await enter("left").done;
    expect(Date.now() - started).toBeLessThan(1000);
    // The first versions wrote the pid alone
    plant("left", gone.pid);
    await enter("left").done;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a lock is removed only by whoever holds it", async () => {
    await withLock("mine", async () => {
      // Taken from us meanwhile (by an older fontego, say): that one is someone else's now
      writeFileSync(lockFile("mine"), JSON.stringify({ pid: process.pid, host: hostname(), id: "theirs" }));
    });
    expect(JSON.parse(readFileSync(lockFile("mine"), "utf8")).id).toBe("theirs");
    rmSync(lockFile("mine"));
  });

  test("a renewal gives up on a server that doesn't answer, and lets go of the lock", async () => {
    const silent = recorder(() => new Promise<Response>(() => {}));
    const store = await credentialStore({ XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" });
    const cred = expiredSession();
    await store.set(silent.url, cred);
    const auth = new StoredAuth(instance(silent.url), store, cred, { refreshTimeoutMs: 300 });
    expect(await failsWith(auth.token())).toBe("unreachable");
    expect(readdirSync(join(home, "fontego", "locks")).filter((f) => f.startsWith("session-"))).toEqual([]);
    silent.stop();
  });

  test("a session the server ended deletes only the credential it spent, not one saved meanwhile", async () => {
    const store = await credentialStore({ XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" });
    const newer = expiredSession("fontego_rt_newer");
    let url = "";
    const refusing = recorder(async () => {
      await store.set(url, newer); // a sign-in that finished while this renewal was on its way
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    url = refusing.url;
    const cred = expiredSession("fontego_rt_spent");
    await store.set(url, cred);
    expect(await failsWith(new StoredAuth(instance(url), store, cred).token())).toBe("session_ended");
    expect(await store.get(url)).toEqual(newer);
    refusing.stop();
  });

  test("a token refused is refused, even when another fontego noted its end meanwhile: it isn't a new sign-in", async () => {
    const store = await credentialStore({ XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" });
    const refusing = recorder(() => Response.json({ error: { code: "unauthenticated", message: "Not signed in." } }, { status: 401 }));
    const mine = { type: "token" as const, token: "fontego_pat_revoked" };
    await store.set(refusing.url, { ...mine, expiresAt: "2027-01-01T00:00:00.000Z" });
    const client = new Client(refusing.url, new StoredAuth(instance(refusing.url), store, mine));
    expect(await failsWith(client.me())).toBe("token_refused");
    refusing.stop();
  });

  test("a new sign-in waits for a renewal under way before it saves its credential", async () => {
    const store = await credentialStore({ XDG_CONFIG_HOME: home, FONTEGO_CREDENTIAL_STORE: "file" });
    const url = "https://lock.example.org";
    let renewing!: () => void;
    const renewal = new Promise<void>((r) => (renewing = r));
    // The lock a renewal of that instance takes, held until we say
    const held = withLock(lockName(url), () => renewal);
    await Bun.sleep(100);
    const saved = replaceCredential(url, store, { type: "token", token: "fontego_pt_new" });
    await Bun.sleep(400);
    expect(await store.get(url)).toBeNull();
    renewing();
    await Promise.all([held, saved]);
    expect(await store.get(url)).toEqual({ type: "token", token: "fontego_pt_new" });
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
