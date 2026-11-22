// A real fontego-server for the CLI's tests, used from the outside only: its admin commands and the HTTP API, never
// its code. It runs from a fontego-app checkout next to this repo (../fontego-app), or from FONTEGO_APP_DIR.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP_DIR = resolve(process.env.FONTEGO_APP_DIR ?? join(import.meta.dir, "../../../fontego-app"));
const SERVER_MAIN = join(APP_DIR, "server/src/main.ts");

export interface TestServer {
  url: string;
  /**
   * The server admin's credential: the access token of a CLI session (it lasts an hour), as `fontego login` leaves
   * one, since a token never acts as a server admin. Real tokens come from `token()`.
   */
  adminToken: string;
  stop(): Promise<void>;
  /** Stops the server process, keeping its data and port, as if the connection were lost */
  pause(): Promise<void>;
  /** Starts it again where it was */
  resume(): Promise<void>;
  /** Creates a person, signed in from a CLI (`token` is its session's access token) */
  person(email: string, name?: string): Promise<{ token: string; id: number }>;
  /** A real token of someone, as fontego-server makes it: by default every workspace of theirs, reading and writing */
  token(email: string, opts?: { workspaces?: string[]; read?: boolean; days?: number; name?: string }): string;
  call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any; res: Response }>;
}

export function tempDir(prefix = "fontego-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

export async function startTestServer(): Promise<TestServer> {
  if (!existsSync(SERVER_MAIN)) {
    throw new Error(`The CLI tests need fontego-server: clone fontego-app next to this repo or set FONTEGO_APP_DIR (looked in ${APP_DIR}).`);
  }
  const dir = tempDir("fontego-cli-server-");
  const port = freePort();
  const env = { ...process.env, FONTEGO_DATA_DIR: dir, FONTEGO_HOST: "127.0.0.1", FONTEGO_PORT: String(port) };

  /** Runs one fontego-server admin command and returns its --json output. */
  const admin = (args: string[]): any => {
    const r = Bun.spawnSync([process.execPath, SERVER_MAIN, ...args, "--json"], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`fontego-server ${args.join(" ")} failed: ${r.stderr.toString() || r.stdout.toString()}`);
    return JSON.parse(r.stdout.toString());
  };

  const setup: string = admin(["init", "admin@example.org", "--name", "Admin"]).setupLink;
  const url = `http://127.0.0.1:${port}`;
  const serve = async () => {
    const p = Bun.spawn([process.execPath, SERVER_MAIN, "serve"], { env, stdout: "ignore", stderr: "pipe" });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${url}/v1/health`)).ok) return p;
      } catch {
        // not listening yet
      }
      if (i >= 100 || p.exitCode !== null) {
        p.kill();
        throw new Error(`fontego-server did not start on ${url}: ${await new Response(p.stderr).text()}`);
      }
      await Bun.sleep(50);
    }
  };
  let proc = await serve();

  /**
   * Someone signed in from a CLI, the way a person does it, from the outside: their one-time link sets a password and
   * signs a browser in; that browser approves the CLI (OAuth with PKCE); the CLI swaps the code for its session.
   */
  const signIn = async (link: string): Promise<string> => {
    const json = { "content-type": "application/json" };
    const used = await fetch(`${url}/v1/links/${/#\/link\/(\S+)/.exec(link)![1]}`, { method: "POST", headers: json, body: JSON.stringify({ password: "a password for the tests" }) });
    if (!used.ok) throw new Error(`setting the password failed: ${used.status} ${await used.text()}`);
    const cookie = (used.headers.get("set-cookie") ?? "").split(";")[0]!;
    const { clientId } = ((await (await fetch(`${url}/v1/instance`)).json()) as { oauth: { clientId: string } }).oauth;
    const verifier = randomBytes(32).toString("base64url");
    const redirect = "http://127.0.0.1:9/callback";
    const authorize = {
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      machine: "test-machine",
      approve: true,
    };
    const approved = await fetch(`${url}/v1/oauth/authorize`, {
      method: "POST",
      headers: { ...json, cookie, "x-requested-with": "fontego-web" },
      body: JSON.stringify(authorize),
    });
    const code = new URL(((await approved.json()) as { redirect: string }).redirect).searchParams.get("code")!;
    const swapped = await fetch(`${url}/v1/oauth/token`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }),
    });
    if (!swapped.ok) throw new Error(`signing the CLI in failed: ${swapped.status} ${await swapped.text()}`);
    return ((await swapped.json()) as { access_token: string }).access_token;
  };
  const adminToken = await signIn(setup);

  return {
    url,
    adminToken,
    async stop() {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
    async pause() {
      proc.kill();
      await proc.exited;
    },
    async resume() {
      proc = await serve();
    },
    async person(email, name = "") {
      const { id } = admin(["user", "add", email, ...(name ? ["--name", name] : [])]);
      return { id, token: await signIn(admin(["admin-link", email]).link) };
    },
    token(email, opts = {}) {
      const which = opts.workspaces ? ["--workspaces", opts.workspaces.join(",")] : ["--all"];
      const days = opts.days ? ["--days", String(opts.days)] : [];
      return admin(["token", "create", email, "--name", opts.name ?? "test", ...which, ...(opts.read ? [] : ["--write"]), ...days]).token;
    },
    async call(token, method, path, body) {
      const res = await fetch(url + path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const type = res.headers.get("content-type") ?? "";
      const data = type.includes("json") ? await res.json() : await res.text();
      return { status: res.status, data, res };
    },
  };
}
