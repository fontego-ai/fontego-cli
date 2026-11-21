// Signing in to several Fontegos from one machine: through the browser (the test plays the browser and approves, as a
// person would), with a code typed on another device, or with a token; sessions that renew by themselves and end;
// which instance each command goes to; and the first version's login moving over by itself.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServer, tempDir, type TestServer } from "./server.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const GOOD = "correct horse battery staple";
let s: TestServer;
let s2: TestServer;
let home: string;
let cookie = "";

function env(extra: Record<string, string> = {}) {
  // Never the real keychain or browser: credentials go to a file in the test home, and links are not opened.
  return {
    ...process.env,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    FONTEGO_URL: "",
    FONTEGO_TOKEN: "",
    FONTEGO_INSTANCE: "",
    FONTEGO_AGENT: "",
    CLAUDECODE: "",
    FONTEGO_CREDENTIAL_STORE: "file",
    FONTEGO_BROWSER: "none",
    ...extra,
  };
}

async function fontego(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], { env: env(opts.env), cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

/** Starts fontego, waits for its first line on stdout (the "waiting" one), and hands back the rest for later. */
async function startWaiting(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", MAIN, ...args], { env: env(extra), stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`fontego ended early: ${await new Response(proc.stderr).text()}`);
    buf += dec.decode(value);
  }
  const first = JSON.parse(buf.slice(0, buf.indexOf("\n")));
  const finish = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    const code = await proc.exited;
    const lines = buf.trim().split("\n");
    return { code, last: JSON.parse(lines.at(-1)!), err: await new Response(proc.stderr).text() };
  };
  return { first, finish, proc };
}

/** Something that answers like a Fontego and notes the Authorization of every request it gets. */
function fakeFontego() {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization") ?? ""}`);
      if (new URL(req.url).pathname === "/v1/instance") return Response.json({ software: "fontego", name: "Elsewhere", version: "1" });
      return Response.json({ error: { code: "nope", message: "nope" } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

const credentialsFile = () => join(home, "fontego", "credentials.json");
const credentials = () => JSON.parse(readFileSync(credentialsFile(), "utf8"));

/** A person with a password, signed in to the web (the cookie the "browser" uses). */
async function personWithPassword(server: TestServer, email: string): Promise<string> {
  const link = (await server.call(server.adminToken, "POST", "/v1/admin/users/invitations", { email })).data.delivery.link;
  const res = await fetch(`${server.url}/v1/links/${/#\/link\/(\S+)/.exec(link)![1]}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: GOOD }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const browser = (c: string) => ({ cookie: c, "content-type": "application/json", "x-requested-with": "fontego-web" });

/** Signs ana in through the browser, in the config folder of `extra` (her own, for a test that needs a session). */
async function signInThroughBrowser(extra: Record<string, string>) {
  const { first, finish } = await startWaiting(["login", s.url, "--json"], extra);
  const q = Object.fromEntries(new URL(first.url).searchParams);
  const approved = await fetch(`${s.url}/v1/oauth/authorize`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ ...q, approve: true }) });
  await fetch(((await approved.json()) as any).redirect);
  const r = await finish();
  expect(r.last).toMatchObject({ ok: true, credential: "session" });
}

beforeAll(async () => {
  [s, s2] = await Promise.all([startTestServer(), startTestServer()]);
  home = tempDir("fontego-cli-login-");
  cookie = await personWithPassword(s, "ana@example.org");
  await s.call(s.adminToken, "POST", "/v1/workspaces", { slug: "notes" });
  await s.call(s.adminToken, "PUT", "/v1/workspaces/notes/members/ana@example.org", { role: "editor" });
});
afterAll(async () => {
  await Promise.all([s.stop(), s2.stop()]);
  rmSync(home, { recursive: true, force: true });
});

describe("signing in through the browser", () => {
  test("fontego login opens the instance's page, and the approval in the browser signs the CLI in", async () => {
    const { first, finish } = await startWaiting(["login", s.url, "--json"]);
    expect(first.status).toBe("waiting");
    const link = new URL(first.url);
    expect(link.pathname).toBe("/oauth/authorize");
    const q = Object.fromEntries(link.searchParams);
    expect(q.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The browser: the person approves, and the browser goes back to the CLI.
    const approved = await fetch(`${s.url}/v1/oauth/authorize`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ ...q, approve: true }) });
    const back = await fetch(((await approved.json()) as any).redirect);
    expect(await back.text()).toContain("Connected");

    const r = await finish();
    expect(r.code).toBe(0);
    expect(r.last).toMatchObject({ ok: true, alias: "fontego", credential: "session", user: { email: "ana@example.org" }, default: true });
    const me = JSON.parse((await fontego(["whoami", "--json"])).out);
    expect(me.credential).toMatchObject({ type: "session", kind: "cli" });
    // The secrets are in the credential store, never in config.json
    expect(statSync(credentialsFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "fontego", "config.json"), "utf8")).not.toContain("fontego_");
  });

  test("the access token renews by itself, and the session ending says what to do", async () => {
    const c = credentials();
    const before = c[s.url];
    c[s.url] = { ...before, accessExpiresAt: new Date(Date.now() - 1000).toISOString() };
    writeFileSync(credentialsFile(), JSON.stringify(c));
    expect((await fontego(["whoami"])).code).toBe(0);
    const renewed = credentials()[s.url];
    expect(renewed.refreshToken).not.toBe(before.refreshToken);
    expect(renewed.accessToken).not.toBe(before.accessToken);

    // A few days before the end, every command says so.
    writeFileSync(credentialsFile(), JSON.stringify({ ...credentials(), [s.url]: { ...renewed, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }));
    expect((await fontego(["whoami"])).err).toContain("Your session on fontego ends in 1 day(s)");

    // A refresh token the server doesn't know (the session ended): sign in again.
    writeFileSync(credentialsFile(), JSON.stringify({ ...credentials(), [s.url]: { ...renewed, accessExpiresAt: new Date(0).toISOString(), refreshToken: "fontego_rt_gone" } }));
    const ended = await fontego(["whoami"]);
    expect(ended.code).toBe(2);
    expect(ended.err).toContain("Your session on fontego ended");
    expect(ended.err).toContain("fontego login fontego");
  });

  test("on a machine without a browser, a code typed on another device", async () => {
    const { first, finish } = await startWaiting(["login", "fontego", "--device", "--json"]);
    const code: string = first.user_code;
    expect(first.status).toBe("waiting");
    expect(code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    const ok = await fetch(`${s.url}/v1/oauth/device/${code}`, { method: "POST", headers: browser(cookie), body: JSON.stringify({ approve: true }) });
    expect(ok.status).toBe(200);
    const r = await finish();
    expect(r.last).toMatchObject({ ok: true, alias: "fontego", credential: "session" });
    expect((await fontego(["whoami"])).code).toBe(0);
  }, 30_000);

  test("an event stream refused with its access token renews it and connects, as any call does", async () => {
    // The server refuses the token although it hasn't expired here (a clock off, a secret the server dropped)
    writeFileSync(credentialsFile(), JSON.stringify({ ...credentials(), [s.url]: { ...credentials()[s.url], accessToken: "fontego_at_refused" } }));
    const proc = Bun.spawn(["bun", MAIN, "events", "--json"], { env: env(), stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    let buf = "";
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    expect(JSON.parse(buf.split("\n")[0]!).type).toBe("ready");
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(0);
    expect(credentials()[s.url].accessToken).not.toBe("fontego_at_refused");
  }, 30_000);

  test("your own sessions, from the CLI; and an address a server admin changed shows after the next renewal", async () => {
    const mine = JSON.parse((await fontego(["account", "sessions", "--json"])).out).sessions as any[];
    expect(mine.filter((x) => x.current)).toEqual([expect.objectContaining({ kind: "cli" })]);
    expect((await fontego(["account", "sessions"])).out).toMatch(/cli\s+\S+ \(this one\)/);

    // Another browser of hers, signed out from here
    const web = await fetch(`${s.url}/v1/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ana@example.org", password: GOOD }) });
    const other = (web.headers.get("set-cookie") ?? "").split(";")[0]!;
    const id = JSON.parse((await fontego(["account", "sessions", "--json"])).out).sessions.find((x: any) => x.kind === "web" && !x.current).id;
    expect((await fontego(["account", "sessions", "close", String(id)])).out).toBe(`Session ${id} closed.\n`);
    expect((await fetch(`${s.url}/v1/me`, { headers: { cookie: other } })).status).toBe(401);

    const renew = async () => {
      const c = credentials();
      writeFileSync(credentialsFile(), JSON.stringify({ ...c, [s.url]: { ...c[s.url], accessExpiresAt: new Date(0).toISOString() } }));
      return fontego(["whoami"]);
    };
    expect((await s.call(s.adminToken, "PATCH", "/v1/admin/users/ana@example.org", { email: "ana@new.example.org" })).status).toBe(200);
    expect((await renew()).out).toContain("ana@new.example.org on");
    expect(JSON.parse((await fontego(["sessions", "--json"])).out).instances[0]).toMatchObject({ alias: "fontego", email: "ana@new.example.org" });
    expect((await s.call(s.adminToken, "PATCH", "/v1/admin/users/ana@new.example.org", { email: "ana@example.org" })).status).toBe(200);
    await renew();
    expect(JSON.parse((await fontego(["sessions", "--json"])).out).instances[0].email).toBe("ana@example.org");
  });

  test("signing out closes the session on the server too", async () => {
    const access = credentials()[s.url].accessToken;
    expect((await fontego(["logout"])).out).toContain("Signed out of fontego");
    expect((await fetch(`${s.url}/v1/me`, { headers: { authorization: `Bearer ${access}` } })).status).toBe(401);
    const st = JSON.parse((await fontego(["sessions", "--json"])).out);
    expect(st.instances[0]).toMatchObject({ alias: "fontego", status: "signed out" });
    expect((await fontego(["whoami"])).code).toBe(2);
  });
});

describe("several Fontegos on one machine", () => {
  test("each command goes to the default, to --instance, to FONTEGO_INSTANCE or to the synced folder's", async () => {
    expect((await fontego(["login", s.url, "--token", (await s.person("bea@example.org")).token])).code).toBe(0);
    await s.call(s.adminToken, "PUT", "/v1/workspaces/notes/members/bea@example.org", { role: "editor" });
    const work = await s2.person("cai@example.org");
    const added = JSON.parse((await fontego(["login", s2.url, "--token", work.token, "--alias", "work", "--json"])).out);
    expect(added).toMatchObject({ alias: "work", credential: "token", default: false });

    const list = JSON.parse((await fontego(["sessions", "--json"])).out);
    expect(list.instances.map((i: any) => [i.alias, i.status])).toEqual([
      ["fontego", "token"],
      ["work", "token"],
    ]);
    expect(list.default).toBe("fontego");
    const who = async (args: string[] = [], opts = {}) => JSON.parse((await fontego(["whoami", "--json", ...args], opts)).out).user.email;
    expect(await who()).toBe("bea@example.org");
    expect(await who(["--instance", "work"])).toBe("cai@example.org");
    expect(await who([], { env: { FONTEGO_INSTANCE: "work" } })).toBe("cai@example.org");

    expect((await fontego(["use", "work"])).code).toBe(0);
    expect(await who()).toBe("cai@example.org");

    // A folder synced from the first instance keeps going there, whatever the default.
    const dir = join(tempDir("fontego-cli-folder-"), "notes");
    expect((await fontego(["clone", "notes", dir, "--instance", "fontego"])).code).toBe(0);
    expect(await who([], { cwd: dir })).toBe("bea@example.org");
    await Bun.write(join(dir, "hello.md"), "hello\n");
    expect((await fontego(["sync"], { cwd: dir, env: { FONTEGO_AGENT: "test-agent" } })).out).toContain("hello.md");
    // The commit says who and how: the session or token, and the agent the CLI ran under.
    const log = JSON.parse((await fontego(["log", "notes", "--json"], { cwd: dir })).out);
    expect(log.commits[0].trailers).toMatchObject({ Agent: "test-agent", Token: expect.stringContaining("person") });
    expect((await fontego(["sync", "--instance", "work"], { cwd: dir })).err).toContain("belongs to");

    expect((await fontego(["sessions", "rename", "work", "office"])).code).toBe(0);
    expect(JSON.parse((await fontego(["sessions", "--json"])).out).default).toBe("office");
    expect((await fontego(["sessions", "forget", "office"])).code).toBe(0);
    expect(JSON.parse((await fontego(["sessions", "--json"])).out).instances.map((i: any) => i.alias)).toEqual(["fontego"]);
  });

  test("the first version's login moves over by itself", async () => {
    const old = tempDir("fontego-cli-legacy-");
    writeFileSync(join(old, "placeholder"), "");
    const dir = join(old, "fontego");
    await Bun.write(join(dir, "config.json"), JSON.stringify({ url: s.url, token: (await s.person("dan@example.org")).token }));
    const r = await fontego(["whoami", "--json"], { env: { XDG_CONFIG_HOME: old, XDG_CACHE_HOME: old } });
    expect(JSON.parse(r.out).user.email).toBe("dan@example.org");
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(config).toMatchObject({ version: 2, default: "fontego" });
    expect(JSON.stringify(config)).not.toContain("fontego_");
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")))).toEqual([s.url]);
    rmSync(old, { recursive: true, force: true });
  });

  test("without a sign-in, and with an unknown instance, it says what to do", async () => {
    const empty = tempDir("fontego-cli-none-");
    const none = await fontego(["whoami"], { env: { XDG_CONFIG_HOME: empty, XDG_CACHE_HOME: empty } });
    expect(none.code).toBe(2);
    expect(none.err).toContain("fontego login");
    expect((await fontego(["whoami", "--instance", "nope"])).err).toContain('No instance "nope"');
    expect((await fontego(["login", "--json"])).out).toContain("Yours: fontego");
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("the addresses it signs in to", () => {
  test("plain http to another machine is refused before anything is sent, unless accepted with --allow-http", async () => {
    const own = tempDir("fontego-cli-http-");
    const here = { XDG_CONFIG_HOME: own, XDG_CACHE_HOME: own };
    const refused = JSON.parse((await fontego(["login", "http://fontego.example.org", "--json"], { env: here })).out).error;
    expect(refused).toMatchObject({ code: "insecure_url", hint: expect.stringContaining("--allow-http") });
    const tricked = await fontego(["login", "https://good.example@127.0.0.1:1", "--json"], { env: here });
    expect(JSON.parse(tricked.out).error.code).toBe("bad_url");

    // 0.0.0.0 reaches this machine, but it isn't a loopback address: it stands for one on another machine.
    const remote = s.url.replace("127.0.0.1", "0.0.0.0");
    const { token } = await s.person("eli@example.org");
    expect(JSON.parse((await fontego(["login", remote, "--token", token, "--json"], { env: here })).out).error.code).toBe("insecure_url");
    expect(JSON.parse((await fontego(["login", remote, "--token", token, "--allow-http", "--json"], { env: here })).out)).toMatchObject({ ok: true, url: remote });
    // Remembered for that instance only
    expect(JSON.parse((await fontego(["sessions", "--json"], { env: here })).out).instances[0]).toMatchObject({ url: remote, allowHttp: true });
    expect(JSON.parse((await fontego(["whoami", "--json"], { env: here })).out).user.email).toBe("eli@example.org");

    // An instance saved without it (by hand, or before this check) is refused, with how to accept it.
    const config = join(own, "fontego", "config.json");
    const saved = JSON.parse(readFileSync(config, "utf8"));
    for (const i of Object.values(saved.instances) as any[]) delete i.allowHttp;
    writeFileSync(config, JSON.stringify(saved));
    const old = JSON.parse((await fontego(["whoami", "--json"], { env: here })).out).error;
    expect(old).toMatchObject({ code: "insecure_url", hint: expect.stringContaining("--allow-http") });
    rmSync(own, { recursive: true, force: true });
  });

  test("FONTEGO_URL is checked the same way, and FONTEGO_ALLOW_HTTP=1 accepts plain http", async () => {
    const { token } = await s.person("fay@example.org");
    const remote = s.url.replace("127.0.0.1", "0.0.0.0");
    const refused = JSON.parse((await fontego(["whoami", "--json"], { env: { FONTEGO_URL: remote, FONTEGO_TOKEN: token } })).out).error;
    expect(refused).toMatchObject({ code: "insecure_url", hint: expect.stringContaining("FONTEGO_ALLOW_HTTP=1") });
    const ok = await fontego(["whoami", "--json"], { env: { FONTEGO_URL: remote, FONTEGO_TOKEN: token, FONTEGO_ALLOW_HTTP: "1" } });
    expect(JSON.parse(ok.out).user.email).toBe("fay@example.org");
    expect(JSON.parse((await fontego(["whoami", "--json"], { env: { FONTEGO_URL: `https://x@${s.url.slice(7)}`, FONTEGO_TOKEN: token } })).out).error.code).toBe("bad_url");
  });
});

describe("FONTEGO_TOKEN", () => {
  test("signing in to another Fontego never sends the token exported for FONTEGO_URL", async () => {
    const elsewhere = fakeFontego();
    const own = tempDir("fontego-cli-envtoken-");
    const { first, proc } = await startWaiting(["login", elsewhere.url, "--json"], {
      XDG_CONFIG_HOME: own,
      XDG_CACHE_HOME: own,
      FONTEGO_URL: s.url,
      FONTEGO_TOKEN: "fontego_pt_work_secret",
    });
    // It signs in there as anyone would, through the browser
    expect(first.status).toBe("waiting");
    proc.kill();
    await proc.exited;
    expect(elsewhere.seen.join("\n")).not.toContain("fontego_pt_work_secret");
    elsewhere.stop();
    rmSync(own, { recursive: true, force: true });
  });

  test("with FONTEGO_URL naming the same Fontego, it is the token login uses", async () => {
    const own = tempDir("fontego-cli-envtoken-");
    const { token } = await s.person("gil@example.org");
    const r = await fontego(["login", `${s.url}/`, "--json"], { env: { XDG_CONFIG_HOME: own, XDG_CACHE_HOME: own, FONTEGO_URL: s.url, FONTEGO_TOKEN: token } });
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, credential: "token", user: { email: "gil@example.org" } });
    rmSync(own, { recursive: true, force: true });
  });
});

describe("opening the browser", () => {
  test("fontego open doesn't open a link that a server points elsewhere", async () => {
    const dir = tempDir("fontego-cli-open-");
    const log = join(dir, "opened.log");
    writeFileSync(join(dir, "browser.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
    for (const link of ["file:///etc/passwd", "https://evil.example/#/login?code=c"]) {
      const fake = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req) => (new URL(req.url).pathname === "/v1/session/code" ? Response.json({ code: "c", expiresAt: new Date().toISOString(), url: link }) : new Response("no", { status: 404 })),
      });
      const r = await fontego(["open"], { env: { FONTEGO_URL: `http://127.0.0.1:${fake.port}`, FONTEGO_TOKEN: "fontego_pt_x", FONTEGO_BROWSER: join(dir, "browser.sh") } });
      fake.stop(true);
      expect(r.code).toBe(1);
      expect(r.err).toContain("won't open it");
    }
    await Bun.sleep(300);
    expect(existsSync(log)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("fontego open's one-time code is on no command line: the browser opens a private page that sends it on", async () => {
    const own = tempDir("fontego-cli-open-");
    const here = { XDG_CONFIG_HOME: own, XDG_CACHE_HOME: own };
    await signInThroughBrowser(here);
    const log = join(own, "opened.log");
    writeFileSync(join(own, "browser.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, { mode: 0o755 });
    const proc = Bun.spawn(["bun", MAIN, "open", "notes"], { env: env({ ...here, FONTEGO_BROWSER: join(own, "browser.sh") }), stdout: "pipe", stderr: "pipe" });
    for (let i = 0; !existsSync(log) && i < 100; i++) await Bun.sleep(50);

    // What the browser was given: a page of ours, not the link
    const argv = readFileSync(log, "utf8").trim().split("\n");
    expect(argv).toEqual([expect.stringMatching(/^file:\/\/.*\.html$/)]);
    expect(argv[0]).not.toContain("code=");
    const page = fileURLToPath(argv[0]!);
    expect(statSync(dirname(page)).mode & 0o777).toBe(0o700);
    expect(statSync(page).mode & 0o777).toBe(0o600);
    const html = readFileSync(page, "utf8");
    const link = JSON.parse(/location\.replace\(("[^"]+")\)/.exec(html)![1]!) as string;
    expect(new URL(link).origin).toBe(s.url);
    expect(link).toMatch(/#\/login\?code=[^&]+&next=%2Fw%2Fnotes$/);

    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("Opening the web app in your browser");
    // Gone once the browser has had time to read it
    expect(existsSync(dirname(page))).toBe(false);
    rmSync(own, { recursive: true, force: true });
  }, 30_000);
});
