// A real fontego-server for the CLI's tests, used from the outside only: its admin commands and the HTTP API, never
// its code. It runs from a fontego-app checkout next to this repo (../fontego-app), or from FONTEGO_APP_DIR.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP_DIR = resolve(process.env.FONTEGO_APP_DIR ?? join(import.meta.dir, "../../../fontego-app"));
const SERVER_MAIN = join(APP_DIR, "server/src/main.ts");

export interface TestServer {
  url: string;
  adminToken: string;
  stop(): Promise<void>;
  /** Stops the server process, keeping its data and port, as if the connection were lost */
  pause(): Promise<void>;
  /** Starts it again where it was */
  resume(): Promise<void>;
  /** Creates a person with a token */
  person(email: string, name?: string): Promise<{ token: string; id: number }>;
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

  const adminToken: string = admin(["init", "admin@example.org", "--name", "Admin", "--token"]).token;
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
      const { token } = admin(["token", "create", email, "--label", "test"]);
      return { id, token };
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
