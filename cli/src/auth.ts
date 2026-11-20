// Signing in to an instance and staying signed in.
//
// The CLI signs in with OAuth for native apps: it opens the browser on the instance's page, the person approves, and
// the browser comes back to a port on 127.0.0.1 with a code the CLI swaps for a session (authorization code with
// PKCE). Without a browser on this machine it uses the device flow: a short code to type in a browser anywhere.
//
// A session is an access token (one hour) and a refresh token that the server swaps for a new pair on every use. The
// CLI renews it by itself, under a lock, because two processes renewing with the same refresh token would make the
// server close the session.

import type { DeviceAuthorization, InstanceInfo, TokenResponse } from "@fontego/core";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { ClientError, type AuthProvider } from "./client.ts";
import { normalizeUrl, withLock, type Credential, type CredentialStore, type Instance } from "./config.ts";
import { USER_AGENT } from "./version.ts";

export const CLIENT_ID = "fontego-cli";

export const sessionEnded = (alias: string) =>
  new ClientError(401, "session_ended", `Your session on ${alias} ended.`, `Sign in again: fontego login ${alias}`);

export function fromTokenResponse(t: TokenResponse): Extract<Credential, { type: "session" }> {
  return {
    type: "session",
    accessToken: t.access_token,
    // A little early, so a request never carries a token that expires on the way
    accessExpiresAt: new Date(Date.now() + (t.expires_in - 30) * 1000).toISOString(),
    refreshToken: t.refresh_token,
    sessionId: t.session.id,
    expiresAt: t.session.expiresAt,
    email: t.session.email,
  };
}

const lockName = (url: string) => `session-${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;

/** The credential stored for an instance: a session that renews itself, or a token. */
export class StoredAuth implements AuthProvider {
  constructor(
    readonly instance: Instance,
    private readonly store: CredentialStore,
    private cred: Credential,
  ) {}

  /** When the session ends if nothing else happens; null for a token */
  get expiresAt(): string | null {
    return this.cred.type === "session" ? this.cred.expiresAt : null;
  }

  async token(): Promise<string> {
    if (this.cred.type === "token") return this.cred.token;
    if (Date.parse(this.cred.accessExpiresAt) <= Date.now()) await this.renew();
    return (this.cred as Extract<Credential, { type: "session" }>).accessToken;
  }

  recover(): Promise<void> {
    return this.renew();
  }

  /** Renews a session, or picks up a credential another process saved. Throws session_ended when there is none. */
  private renew(): Promise<void> {
    const url = this.instance.url;
    return withLock(lockName(url), async () => {
      const latest = await this.store.get(url);
      if (!latest) throw sessionEnded(this.instance.alias);
      if (JSON.stringify(latest) !== JSON.stringify(this.cred)) {
        // Signed in again, or renewed by another fontego: use that.
        this.cred = latest;
        if (latest.type === "token" || Date.parse(latest.accessExpiresAt) > Date.now()) return;
      } else if (latest.type === "token") {
        const alias = this.instance.alias;
        throw new ClientError(401, "token_refused", `The token saved for ${alias} was refused.`, `Sign in again: fontego login ${alias}`);
      }
      const current = this.cred as Extract<Credential, { type: "session" }>;
      let res: Response;
      try {
        res = await fetch(`${url}/v1/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLIENT_ID }),
        });
      } catch (e) {
        throw new ClientError(0, "unreachable", `Can't reach ${url}: ${(e as Error).message}`, "Check the URL and that the server is running.");
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
        if (err.error === "invalid_grant") {
          await this.store.delete(url);
          throw sessionEnded(this.instance.alias);
        }
        throw new ClientError(res.status, err.error ?? "http_error", err.error_description ?? `HTTP ${res.status}`);
      }
      this.cred = fromTokenResponse((await res.json()) as TokenResponse);
      await this.store.set(url, this.cred);
    });
  }
}


// --- signing in ---

/** What a server says about itself; also checks that it is a Fontego. */
export async function fetchInstance(url: string): Promise<InstanceInfo> {
  let res: Response;
  try {
    res = await fetch(`${normalizeUrl(url)}/v1/instance`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new ClientError(0, "unreachable", `Can't reach ${url}: ${(e as Error).message}`, "Check the URL and that the server is running.");
  }
  const info = res.ok ? ((await res.json().catch(() => null)) as InstanceInfo | null) : null;
  if (!info || info.software !== "fontego") {
    throw new ClientError(404, "not_fontego", `${url} doesn't look like a Fontego server.`, "Check the address: it is the one you open in the browser.");
  }
  return info;
}

export const machineName = () => hostname().split(".")[0] || "a computer";

/**
 * Whether to sign in through a browser here: no display (SSH, a container, a server) means the device flow. Setting
 * FONTEGO_BROWSER says how links open here ("none": only show them), so it means a browser too.
 */
export function hasBrowser(env = process.env): boolean {
  if (env.FONTEGO_BROWSER) return true;
  if (process.platform === "darwin" || process.platform === "win32") return !env.SSH_CONNECTION;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Opens a link in the browser: FONTEGO_BROWSER names the program ("none" opens nothing). */
export function openInBrowser(url: string, env = process.env): boolean {
  if (env.FONTEGO_BROWSER === "none") return false;
  const cmd = env.FONTEGO_BROWSER
    ? [env.FONTEGO_BROWSER, url]
    : process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4em auto;max-width:32em;padding:0 1em"><h1>${title}</h1><p>${text}</p>`;

/**
 * The browser way: opens the instance's page, waits on 127.0.0.1 for the browser to come back with a code, and swaps
 * it for a session. `waiting` is told the link, for whoever has to open it.
 */
export async function browserLogin(url: string, opts: { waiting: (link: string) => void; timeoutMs?: number }): Promise<TokenResponse> {
  const base = normalizeUrl(url);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  let settle!: (r: { code?: string; error?: string }) => void;
  const answered = new Promise<{ code?: string; error?: string }>((r) => (settle = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (u.searchParams.get("state") !== state) return new Response(PAGE("Not this one", "This link isn't the one the terminal is waiting for."), { status: 400, headers: { "content-type": "text/html" } });
      const error = u.searchParams.get("error");
      settle({ code: u.searchParams.get("code") ?? undefined, error: error ?? undefined });
      return new Response(error ? PAGE("Not connected", "The CLI was told no. You can close this tab.") : PAGE("Connected", "You can close this tab and go back to the terminal."), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const link =
    `${base}/oauth/authorize?` +
    new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, machine: machineName() });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    opts.waiting(link);
    const timeout = new Promise<{ error: string }>((r) => (timer = setTimeout(() => r({ error: "timeout" }), opts.timeoutMs ?? 5 * 60_000)));
    const r: { code?: string; error?: string } = await Promise.race([answered, timeout]);
    if (r.error === "timeout") throw new ClientError(408, "timeout", "Nobody approved the sign-in in the browser within five minutes.", "Run fontego login again.");
    if (r.error || !r.code) throw new ClientError(403, "access_denied", "The sign-in was refused in the browser.");
    return await tokenRequest(base, { grant_type: "authorization_code", code: r.code, code_verifier: verifier, redirect_uri: redirectUri, client_id: CLIENT_ID });
  } finally {
    clearTimeout(timer); // a pending timer would keep the process alive
    server.stop(true);
  }
}

/** The device way: a code to type in a browser anywhere, and asking until it is approved. */
export async function deviceLogin(url: string, opts: { waiting: (d: DeviceAuthorization) => void }): Promise<TokenResponse> {
  const base = normalizeUrl(url);
  const res = await fetch(`${base}/v1/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, machine: machineName() }),
  });
  if (!res.ok) throw new ClientError(res.status, "device_failed", `The server refused to start the sign-in (HTTP ${res.status}).`);
  const d = (await res.json()) as DeviceAuthorization;
  opts.waiting(d);
  let interval = d.interval;
  const until = Date.now() + d.expires_in * 1000;
  while (Date.now() < until) {
    await Bun.sleep(interval * 1000);
    try {
      return await tokenRequest(base, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: CLIENT_ID });
    } catch (e) {
      if (!(e instanceof ClientError)) throw e;
      if (e.code === "authorization_pending") continue;
      if (e.code === "slow_down") {
        interval += 5;
        continue;
      }
      if (e.code === "access_denied") throw new ClientError(403, "access_denied", "The sign-in was refused in the browser.");
      if (e.code === "expired_token") break;
      throw e;
    }
  }
  throw new ClientError(408, "timeout", "The code expired before anyone approved it.", "Run fontego login again.");
}

async function tokenRequest(base: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${base}/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new ClientError(res.status, body.error ?? "http_error", body.error_description ?? `HTTP ${res.status}`);
  return body;
}

/** Closes a session on the server (RFC 7009). Best effort: a server that can't be reached closes it when it expires. */
export async function revokeSession(url: string, refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeUrl(url)}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
