// Signing in to an instance and staying signed in.
//
// The CLI signs in with OAuth for native apps: it opens the browser on the instance's page, the person approves, and
// the browser comes back to a port on 127.0.0.1 with a code the CLI swaps for a session (authorization code with
// PKCE). Without a browser on this machine it uses the device flow: a short code to type in a browser anywhere.
//
// A session is an access token (one hour) and a refresh token that the server swaps for a new pair on every use. The
// CLI renews it by itself, under a lock, because two processes renewing with the same refresh token would make the
// server close the session.

import { CLI_CLIENT_ID, type DeviceAuthorization, type InstanceInfo, type TokenResponse } from "@fontego/core";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClientError, refuseRedirect, type AuthProvider } from "./client.ts";
import { normalizeUrl, setInstanceEmail, withLock, type Credential, type CredentialStore, type Instance } from "./config.ts";
import { USER_AGENT } from "./version.ts";

export const CLIENT_ID = CLI_CLIENT_ID;

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

/** The lock under which an instance's credential is renewed or replaced */
export const lockName = (url: string) => `session-${createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 16)}`;

/** How long a renewal waits for the server: well under how long another process waits for the lock (config.ts) */
const REFRESH_TIMEOUT_MS = 15_000;

/** The same credential: a token by its secret (what is noted with it, such as its end, may be added), a session whole. */
const same = (a: Credential | null, b: Credential | null) =>
  a?.type === "token" && b?.type === "token" ? a.token === b.token : JSON.stringify(a) === JSON.stringify(b);

/** The credential stored for an instance: a session that renews itself, or a token. */
export class StoredAuth implements AuthProvider {
  constructor(
    readonly instance: Instance,
    private readonly store: CredentialStore,
    private cred: Credential,
    private readonly opts: { refreshTimeoutMs?: number } = {},
  ) {}

  /** When the session ends if nothing else happens; null for a token */
  get expiresAt(): string | null {
    return this.cred.type === "session" ? this.cred.expiresAt : null;
  }

  /**
   * The secret to send: a token as it is, or the session's access token, renewed first when it has ended, or when it
   * has less than `minLeftMs` left (fontego mcp header, whose answer an agent keeps for a while).
   */
  async token(minLeftMs = 0): Promise<string> {
    if (this.cred.type === "token") return this.cred.token;
    if (Date.parse(this.cred.accessExpiresAt) - minLeftMs <= Date.now()) await this.renew(minLeftMs);
    return (this.cred as Extract<Credential, { type: "session" }>).accessToken;
  }

  recover(): Promise<void> {
    return this.renew();
  }

  /**
   * A token saved without its end (by an earlier fontego), or with another one, takes the one the server just said
   * (the fontego-token-expires header), so `fontego sessions` can show it. Under the lock, and only if the same token
   * is still the one saved.
   */
  async rememberTokenEnd(expiresAt: string): Promise<void> {
    const mine = this.cred;
    if (mine.type !== "token" || mine.expiresAt === expiresAt) return;
    const url = this.instance.url;
    await withLock(lockName(url), async () => {
      const latest = await this.store.get(url);
      if (latest?.type !== "token" || latest.token !== mine.token) return;
      this.cred = { ...latest, expiresAt };
      await this.store.set(url, this.cred);
    });
  }

  /**
   * Renews a session, or picks up a credential another process saved that has `minLeftMs` left. Throws session_ended
   * when there is none.
   */
  private renew(minLeftMs = 0): Promise<void> {
    const url = this.instance.url;
    return withLock(lockName(url), async () => {
      const latest = await this.store.get(url);
      if (!latest) throw sessionEnded(this.instance.alias);
      if (!same(latest, this.cred)) {
        // Signed in again, or renewed by another fontego: use that.
        this.cred = latest;
        if (latest.type === "token" || Date.parse(latest.accessExpiresAt) - minLeftMs > Date.now()) return;
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
          redirect: "manual",
          // A renewal that hung would keep the lock, and the others waiting
          signal: AbortSignal.timeout(this.opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS),
        });
      } catch (e) {
        throw new ClientError(0, "unreachable", `Can't reach ${url}: ${(e as Error).message}`, "Check the URL and that the server is running.");
      }
      refuseRedirect(res, url);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
        if (err.error === "invalid_grant") {
          // Only the credential this renewal spent: one saved meanwhile is someone's new sign-in.
          if (same(await this.store.get(url), current)) await this.store.delete(url);
          throw sessionEnded(this.instance.alias);
        }
        throw new ClientError(res.status, err.error ?? "http_error", err.error_description ?? `HTTP ${res.status}`);
      }
      this.cred = fromTokenResponse((await res.json()) as TokenResponse);
      await this.store.set(url, this.cred);
      // The account's address as the server says it now: a server admin may have changed it since this machine signed in.
      if (this.cred.email !== this.instance.email) {
        setInstanceEmail(this.instance.alias, this.cred.email);
        this.instance.email = this.cred.email;
      }
    });
  }
}


/**
 * What still works on the server after this machine let go of a credential: a token (fontego can't revoke one), or a
 * session the server didn't close because it couldn't be reached (it ends by itself at expiresAt).
 */
export type StillOpen = { credential: "token" } | { credential: "session"; sessionId: number; expiresAt: string };

/** Closes on the server what a credential opened, where fontego can; says what stays open. */
async function closeOnServer(url: string, c: Credential | null): Promise<StillOpen | null> {
  if (!c) return null;
  if (c.type === "token") return { credential: "token" };
  return (await revokeSession(url, c.refreshToken)) ? null : { credential: "session", sessionId: c.sessionId, expiresAt: c.expiresAt };
}

/**
 * Saves the credential of a new sign-in in place of the one there, under the renewal lock: a renewal running meanwhile
 * would save its session over this one, or delete it when the server refuses the old refresh token. The previous
 * session is closed on the server; what of the previous credential stays open there is returned.
 */
export function replaceCredential(url: string, store: CredentialStore, cred: Credential): Promise<StillOpen | null> {
  return withLock(lockName(url), async () => {
    const previous = await store.get(url);
    const open = previous && !(previous.type === "token" && cred.type === "token" && previous.token === cred.token) ? await closeOnServer(url, previous) : null;
    await store.set(url, cred);
    return open;
  });
}

/** Signs this machine out of an instance: its session closes on the server, the credential goes, and what stays open is returned. */
export function removeCredential(url: string, store: CredentialStore): Promise<StillOpen | null> {
  return withLock(lockName(url), async () => {
    const open = await closeOnServer(url, await store.get(url));
    await store.delete(url);
    return open;
  });
}

// --- signing in ---

/** What a server says about itself; also checks that it is a Fontego. */
export async function fetchInstance(url: string): Promise<InstanceInfo> {
  let res: Response;
  try {
    res = await fetch(`${normalizeUrl(url)}/v1/instance`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  } catch (e) {
    throw new ClientError(0, "unreachable", `Can't reach ${url}: ${(e as Error).message}`, "Check the URL and that the server is running.");
  }
  // Nothing secret goes in this request, but every later one would: say where the server points instead of following.
  const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (to) {
    let moved: string | null = null;
    try {
      moved = new URL(to, `${normalizeUrl(url)}/v1/instance`).href.replace(/\/v1\/instance$/, "");
    } catch {
      // not an address
    }
    throw new ClientError(
      res.status,
      "redirected",
      `${url} sends fontego ${moved ? `to ${moved}` : "elsewhere"}, and fontego doesn't follow redirects.`,
      moved ? `If that is the right address: fontego login ${moved}` : "Check the address: it is the one you open in the browser.",
    );
  }
  const info = res.ok ? ((await res.json().catch(() => null)) as InstanceInfo | null) : null;
  if (!info || info.software !== "fontego") {
    throw new ClientError(404, "not_fontego", `${url} doesn't look like a Fontego server.`, "Check the address: it is the one you open in the browser.");
  }
  return info;
}

/** What a machine's session is called when nobody names it (fontego login --name): the computer's name. */
export const machineName = () => hostname().split(".")[0] || "a computer";

/**
 * Whether to sign in through a browser here: no display (SSH, a container, a server) means the device flow. Setting
 * FONTEGO_BROWSER says how links open here ("none": only show them), so it means a browser too.
 */
export function hasBrowser(env = process.env): boolean {
  if (env.FONTEGO_BROWSER) return true;
  // Over SSH the browser to approve with is the person's own, where they are already signed in, on another machine:
  // a code to type there, also on Linux with a forwarded DISPLAY (or one a tmux kept from the desktop).
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * The program and arguments that open a link here, run without a shell; null when nothing should open. FONTEGO_BROWSER
 * names the program ("none" opens nothing). On Windows it is rundll32's FileProtocolHandler, never `cmd /c start`:
 * cmd.exe reads & | ^ < > in a link as its own (a sign-in link has &), and nothing on that line is quoted for it.
 */
export function openerCommand(target: string, platform: string = process.platform, env: Record<string, string | undefined> = process.env): string[] | null {
  if (env.FONTEGO_BROWSER === "none") return null;
  if (env.FONTEGO_BROWSER) return [env.FONTEGO_BROWSER, target];
  if (platform === "darwin") return ["open", target];
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", target];
  return ["xdg-open", target];
}

function launch(target: string, env: Record<string, string | undefined>): boolean {
  const cmd = openerCommand(target, process.platform, env);
  if (!cmd) return false;
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/** An http(s) link, as the URL parser writes it (no space or quote left), or null for anything else. */
function webLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Opens a link in the browser, and says whether it could. Only http(s): the opener would just as well run a file or
 * another program's scheme.
 */
export function openInBrowser(url: string, env = process.env): boolean {
  const link = webLink(url);
  return link ? launch(link, env) : false;
}

/** How long the page with a secret link stays for the browser to read it */
const PAGE_KEPT_MS = 5_000;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page that sends the browser on to `link` (by script, or by refresh and a link without it) */
const forwardingPage = (link: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Opening the web app</title>` +
  `<noscript><meta http-equiv="refresh" content="0; url=${escapeHtml(link)}"></noscript>` +
  `<script>location.replace(${JSON.stringify(link).replace(/</g, "\\u003c")})</script>` +
  `<p><a href="${escapeHtml(link)}">Continue</a></p>`;

/** The browser that would open a link here: where its program or its desktop entry is, and the entry's Exec lines */
export interface BrowserInUse {
  path: string | null;
  exec?: string | null;
}

/**
 * How a link with a secret opens: through a private page (see openPrivately), or straight to the browser when that
 * browser runs in a sandbox with a /tmp of its own (snap, flatpak: Ubuntu's default Firefox is a snap), which could
 * never read the page. The link then shows on the browser's command line, which other users of this machine can read:
 * a narrower risk than a sign-in that never works. When it can't be told, the page.
 */
export function secretLinkWay(platform: string, browser: BrowserInUse): "page" | "direct" {
  if (platform !== "linux" || !browser.path) return "page";
  const sandboxed =
    browser.path.startsWith("/snap/") ||
    browser.path.includes("/snapd/desktop/applications/") ||
    browser.path.includes("/exports/share/applications/") ||
    /\/snap\/bin\/|\bflatpak run\b/.test(browser.exec ?? "");
  return sandboxed ? "direct" : "page";
}

/** Where a desktop entry (google-chrome.desktop) is, searched as the XDG spec says: data home first, then data dirs. */
export function desktopEntryPath(id: string, env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): string | null {
  const dirs = [env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local/share"), ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  for (const dir of dirs.filter(Boolean)) {
    const path = join(dir, "applications", id);
    if (exists(path)) return path;
  }
  return null;
}

/** The output of a quick command, or "" if it isn't there or fails */
function ask(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 2000 });
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

/** The browser a link would open in here: FONTEGO_BROWSER's program, or the desktop's default browser (Linux). */
function browserInUse(env: Record<string, string | undefined>): BrowserInUse {
  if (env.FONTEGO_BROWSER) return { path: Bun.which(env.FONTEGO_BROWSER) };
  if (process.platform !== "linux") return { path: null };
  const id = ask(["xdg-settings", "get", "default-web-browser"]) || ask(["xdg-mime", "query", "default", "x-scheme-handler/https"]);
  const path = /^[\w.-]+\.desktop$/.test(id) ? desktopEntryPath(id, env) : null;
  if (!path) return { path: null };
  let exec = "";
  try {
    exec = readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith("Exec=")).join("\n");
  } catch {
    // unreadable: its place says enough
  }
  return { path, exec };
}

/**
 * Opens a link that carries a secret (a one-time code) without putting it on any command line, where every user of
 * this machine can read it (ps, /proc/PID/cmdline, for as long as a browser started with it runs). The link goes into
 * a page in a new private folder (0700, the page 0600) that sends the browser on, and the browser opens the page.
 * `opened` is called once it is on its way; the page is removed a few seconds later, when the browser has read it.
 * A browser in a sandbox gets the link itself (secretLinkWay). False when nothing could open it: the caller shows the
 * link instead.
 */
export async function openPrivately(url: string, opened: () => void, env = process.env, way = secretLinkWay(process.platform, browserInUse(env))): Promise<boolean> {
  const link = webLink(url);
  if (!link || !openerCommand(link, process.platform, env)) return false;
  if (way === "direct") {
    if (!launch(link, env)) return false;
    opened();
    return true;
  }
  const dir = mkdtempSync(join(tmpdir(), "fontego-open-"));
  try {
    const page = join(dir, "open.html");
    writeFileSync(page, forwardingPage(link), { flag: "wx", mode: 0o600 });
    if (!launch(pathToFileURL(page).href, env)) return false;
    opened();
    await Bun.sleep(PAGE_KEPT_MS);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A link an instance gave to open in the browser, which must be on that instance's own origin. */
export function instanceLink(link: string, instanceUrl: string): string {
  const web = webLink(link);
  if (web && new URL(web).origin === new URL(instanceUrl).origin) return web;
  const where = web ? new URL(web).origin : "something that isn't a web address";
  // An answer fontego won't use (500: an error), not a server it couldn't reach (502, 503, 504 leave with 6)
  throw new ClientError(
    500,
    "foreign_link",
    `${instanceUrl} gave a link to ${where}, not to itself, so fontego won't open it.`,
    `If this is your server, its public address (FONTEGO_PUBLIC_URL) should be ${instanceUrl}; else tell its admin.`,
  );
}

/** Where a sign-in goes, as the page that ends it names it */
export interface SignInPlace {
  name: string;
  url: string;
}

const PAGES = {
  connected: { title: "Connected", ok: true, text: "fontego is signed in. You can close this tab and go back to the terminal." },
  refused: { title: "Not connected", ok: false, text: "The sign-in was refused, so fontego isn't signed in. You can close this tab." },
  wrong: { title: "Not this one", ok: false, text: "This link isn't the one the terminal is waiting for. Go back to the terminal and open the link it shows." },
} as const;

/**
 * The page the browser shows when it comes back to fontego from signing in. It is fontego's own (the server's web app
 * can't be shown from here), so it carries the web app's look itself: its palette, light and dark as the system says,
 * and the same kind of mark. Nothing on it is loaded from anywhere and it runs no script; its policy says so.
 */
export function signInPage(kind: keyof typeof PAGES, place?: SignInPlace): string {
  const { title, ok, text } = PAGES[kind];
  const mark = ok
    ? `<path d="M4.5 12.5l5 5L19.5 7"/>`
    : `<path d="M6 6l12 12M18 6L6 18"/>`;
  const where = place
    ? `<p class="where">${escapeHtml(place.name)} <span>${escapeHtml(new URL(place.url).host)}</span></p>`
    : "";
  return (
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${title}</title>` +
    `<style>${PAGE_STYLE}</style>` +
    `<main class="card ${ok ? "ok" : "no"}">` +
    `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true">${mark}</svg>` +
    `<h1>${title}</h1><p>${text}</p>${where}</main>`
  );
}

/** The web app's palette (its app.css tokens) and a card, for signInPage */
const PAGE_STYLE =
  `:root{--bg:#f4f4f2;--card:#fff;--line:#dad9d5;--text:#1d1c1b;--soft:#5e5c58;--ok:#2f6b2a;--ok-soft:#dcebd5;` +
  `--no:#a8321c;--no-soft:#f6e1db;--shadow:0 1px 2px rgb(16 24 40/6%);` +
  `--font:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,"Helvetica Neue",Arial,sans-serif;` +
  `--mono:ui-monospace,"JetBrains Mono","SFMono-Regular",Menlo,Consolas,monospace}` +
  `@media (prefers-color-scheme:dark){:root{--bg:#1d1c1b;--card:#252423;--line:#363533;--text:#fff;--soft:#b3b1ae;` +
  `--ok:#9cc98f;--ok-soft:#1f2a1c;--no:#f0907a;--no-soft:#3a221c;--shadow:none}}` +
  `*{box-sizing:border-box}html,body{margin:0;min-height:100%}` +
  `body{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px 16px;background:var(--bg);` +
  `color:var(--text);font:15px/1.5 var(--font);-webkit-text-size-adjust:100%}` +
  `.card{width:100%;max-width:420px;padding:28px;background:var(--card);border:1px solid var(--line);border-radius:10px;` +
  `box-shadow:var(--shadow)}` +
  `.mark{width:44px;height:44px;padding:10px;border-radius:50%;fill:none;stroke-width:2.4;stroke-linecap:round;` +
  `stroke-linejoin:round}.ok .mark{color:var(--ok);background:var(--ok-soft);stroke:currentColor}` +
  `.no .mark{color:var(--no);background:var(--no-soft);stroke:currentColor}` +
  `h1{margin:16px 0 6px;font-size:22px;line-height:1.25;font-weight:650}p{margin:0;color:var(--soft)}` +
  `.where{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);color:var(--text);font-size:13.5px}` +
  `.where span{margin-left:6px;color:var(--soft);font-family:var(--mono);font-size:12.5px}`;

/**
 * The browser way: opens the instance's page, waits on 127.0.0.1 for the browser to come back with a code, and swaps
 * it for a session. `waiting` is told the link, for whoever has to open it. `machine`: the name the new session goes
 * by (machineName() unless given), which the page that approves it shows.
 */
export async function browserLogin(url: string, opts: { waiting: (link: string) => void; timeoutMs?: number; machine?: string; name?: string }): Promise<TokenResponse> {
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
      const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
      if (u.searchParams.get("state") !== state) return new Response(signInPage("wrong"), { status: 400, headers: html });
      const error = u.searchParams.get("error");
      settle({ code: u.searchParams.get("code") ?? undefined, error: error ?? undefined });
      return new Response(signInPage(error ? "refused" : "connected", { name: opts.name ?? new URL(base).host, url: base }), { headers: html });
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  const link =
    `${base}/oauth/authorize?` +
    new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, machine: opts.machine ?? machineName() });
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
export async function deviceLogin(url: string, opts: { waiting: (d: DeviceAuthorization) => void; machine?: string }): Promise<TokenResponse> {
  const base = normalizeUrl(url);
  const res = await fetch(`${base}/v1/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, machine: opts.machine ?? machineName() }),
    redirect: "manual",
  });
  refuseRedirect(res, url);
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
    redirect: "manual",
  });
  refuseRedirect(res, base);
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
      // A redirect is a failure: the refresh token never goes to where it points
      redirect: "manual",
    });
    return res.ok;
  } catch {
    return false;
  }
}
