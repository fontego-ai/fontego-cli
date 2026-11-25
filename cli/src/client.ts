// HTTP client of the API. Commands the server declares go through call(); sync, clone and the other built-in
// commands use the typed methods. Every answer says which version of the commands the server has, and the client
// remembers the last one so the CLI can tell when its saved list is stale.

import {
  COMMANDS_HEADER,
  TOKEN_EXPIRES_HEADER,
  type ChangeSetRequest,
  type ChangeSetResult,
  type CommandsManifest,
  type ErrorBody,
  type Me,
  type MySessionsResponse,
  type RenameSessionRequest,
  type SessionInfo,
  type SyncResponse,
  type WorkspaceInfo,
  type WorkspacesResponse,
} from "@fontego/core";
import { agentName } from "./agents.ts";
import { USER_AGENT } from "./version.ts";

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * fontego follows no redirect: a 307 or 308 sends the body again (a refresh token, a password, a file) to wherever it
 * points, which may be another server or plain http. Every fetch asks for `redirect: "manual"` and passes its answer
 * here, which turns a redirect into an error saying where it pointed.
 */
export function refuseRedirect(res: Response, from: string): Response {
  if (res.status < 300 || res.status > 399) return res;
  const to = res.headers.get("location");
  throw new ClientError(
    res.status,
    "redirected",
    `${from} answered with a redirect${to ? ` to ${to}` : ""}, and fontego doesn't follow redirects: what it sends goes only where you said.`,
    "Use the address the server answers on, the one you open in the browser: fontego login URL",
  );
}

const enc = encodeURIComponent;
const encPath = (p: string) => p.split("/").map(enc).join("/");

/** What a request needs to prove who it is: a stored session renews itself (auth.ts); a token is just a token. */
export interface AuthProvider {
  token(): Promise<string>;
  /** After a 401: gets a new credential to try (renewed, or signed in again elsewhere), or throws why there is none */
  recover?(): Promise<void>;
}

/** Whether a 401 says the token in use ended (token_expired); the answer stays readable. */
async function tokenEnded(res: Response): Promise<boolean> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as ErrorBody | null;
  return body?.error?.code === "token_expired";
}

export class Client {
  private readonly auth: AuthProvider;
  /** Which agent runs this CLI (agents.ts): the server's log then says "Ana, from claude-code". A label, not a guarantee. */
  private readonly agent = agentName();
  /** Where every request goes: this instance's origin, under its path's /v1/ */
  private readonly origin: string;
  private readonly apiPath: string;

  constructor(
    readonly baseUrl: string,
    auth: string | AuthProvider,
    private readonly userAgent = USER_AGENT,
  ) {
    this.auth = typeof auth === "string" ? { token: async () => auth } : auth;
    const base = new URL(baseUrl);
    this.origin = base.origin;
    this.apiPath = `${base.pathname.replace(/\/+$/, "")}/v1/`;
  }

  /**
   * The URL of an API path, which must stay on this instance and under its /v1/: the token goes with it, so a path
   * from a declared command such as `@other:8740/v1/x` or `/v1/../x` is refused instead of sent.
   */
  private urlOf(path: string): string {
    let u: URL | null = null;
    try {
      u = new URL(this.baseUrl.replace(/\/+$/, "") + path);
    } catch {
      // not a URL at all
    }
    if (!u || u.origin !== this.origin || u.username || u.password || !u.pathname.startsWith(this.apiPath)) {
      throw new ClientError(400, "bad_path", `fontego only sends requests to ${this.baseUrl}/v1/, and this one would go to ${path}.`, "A command from this server asks for something else: tell its admin.");
    }
    return u.href;
  }

  /** Version of the server's commands, from the last answer that carried it */
  commandsVersion: string | null = null;
  /** When the token in use stops working, as the last answer to it said (a session's end is the stored one) */
  tokenExpiresAt: string | null = null;

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.auth.token()}`,
      "user-agent": this.userAgent,
      ...(this.agent ? { "fontego-agent": this.agent } : {}),
      ...extra,
    };
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal, retried = false): Promise<Response> {
    const url = this.urlOf(path);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: await this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        redirect: "manual",
      });
    } catch (e) {
      if (e instanceof ClientError) throw e;
      throw new ClientError(0, "unreachable", `Can't reach ${this.baseUrl}: ${(e as Error).message}`, "Check the URL and that the server is running.");
    }
    refuseRedirect(res, this.baseUrl);
    this.commandsVersion = res.headers.get(COMMANDS_HEADER) ?? this.commandsVersion;
    this.tokenExpiresAt = res.headers.get(TOKEN_EXPIRES_HEADER) ?? this.tokenExpiresAt;
    // A refused credential: renew it (or pick up a new sign-in) and try once more. Not a token that ended: nothing
    // renews it, and the server's answer says how to make another.
    if (res.status === 401 && !retried && this.auth.recover && !(await tokenEnded(res))) {
      await this.auth.recover();
      return this.request(method, path, body, signal, true);
    }
    if (!res.ok) {
      let err: ErrorBody["error"] | undefined;
      try {
        err = ((await res.json()) as ErrorBody).error;
      } catch {
        // not JSON
      }
      throw new ClientError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`, err?.hint, err?.details);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }

  me() {
    return this.json<Me>("GET", "/v1/me");
  }

  /** Where this person is signed in: their open sessions, newest first, the one of this call marked current. */
  mySessions() {
    return this.json<MySessionsResponse>("GET", "/v1/me/sessions");
  }

  /** Gives one of this person's sessions another name. */
  renameSession(id: number, label: string) {
    return this.json<SessionInfo>("PATCH", `/v1/me/sessions/${id}`, { label } satisfies RenameSessionRequest);
  }

  /** A one-time link that opens the web app already signed in (valid two minutes). */
  sessionCode() {
    return this.json<{ code: string; expiresAt: string; url: string }>("POST", "/v1/session/code");
  }

  workspace(ws: string) {
    return this.json<WorkspaceInfo>("GET", `/v1/workspaces/${enc(ws)}`);
  }

  /** The workspaces this person can see, with their role in each */
  workspaces() {
    return this.json<WorkspacesResponse>("GET", "/v1/workspaces");
  }

  /** Any API call; the answer as it comes. Commands the server declares run through here. */
  call(method: string, path: string, opts: { query?: URLSearchParams; body?: unknown } = {}): Promise<Response> {
    const q = opts.query?.toString();
    return this.request(method, q ? `${path}?${q}` : path, opts.body);
  }

  /** The commands this server declares (see core/commands.ts). */
  async commands(timeoutMs?: number): Promise<CommandsManifest> {
    const res = await this.request("GET", "/v1/commands", undefined, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    return (await res.json()) as CommandsManifest;
  }

  async file(ws: string, path: string, rev?: string): Promise<{ bytes: Uint8Array; hash: string; mode: string; rev: string }> {
    const res = await this.request("GET", `/v1/workspaces/${enc(ws)}/files/${encPath(path)}${rev ? `?rev=${enc(rev)}` : ""}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      hash: res.headers.get("x-blob-hash") ?? "",
      mode: res.headers.get("x-file-mode") ?? "100644",
      rev: res.headers.get("x-rev") ?? "",
    };
  }

  sync(ws: string, since: string | null) {
    return this.json<SyncResponse>("GET", `/v1/workspaces/${enc(ws)}/sync${since ? `?since=${enc(since)}` : ""}`);
  }

  change(ws: string, cs: ChangeSetRequest) {
    return this.json<ChangeSetResult>("POST", `/v1/workspaces/${enc(ws)}/changes`, cs);
  }

  /** A workspace's live events (fontego watch): ready, then commit. Until the signal aborts or the line drops. */
  events(ws: string, onEvent: (type: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
    return this.stream(`/v1/workspaces/${enc(ws)}/events`, onEvent, signal);
  }

  /** The person's live events (fontego events): ready, then commit, presence and workspaces. */
  personEvents(onEvent: (type: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
    return this.stream("/v1/events", onEvent, signal);
  }

  /**
   * Reads a Server-Sent Events stream, calling onEvent for each event, until the signal aborts or the stream ends.
   * The server beats every `heartbeat` ms (it says so in ready); hearing nothing for more than two and a half beats,
   * the line is taken as dead (a network that dropped without telling) and this throws, so the caller connects again.
   */
  private async stream(path: string, onEvent: (type: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
    const url = this.urlOf(path);
    const local = new AbortController();
    const stop = () => local.abort();
    signal?.addEventListener("abort", stop, { once: true });
    let silent: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    let beat = 0;
    const heard = () => {
      if (silent) clearTimeout(silent);
      if (beat > 0) {
        silent = setTimeout(() => {
          dead = true;
          local.abort();
        }, beat * 2.5);
      }
    };
    try {
      const open = async () => {
        let res: Response;
        try {
          res = await fetch(url, { headers: await this.headers({ accept: "text/event-stream" }), signal: local.signal, redirect: "manual" });
        } catch (e) {
          if (signal?.aborted) return null;
          if (e instanceof ClientError) throw e;
          throw new ClientError(0, "unreachable", `Can't reach ${this.baseUrl}: ${(e as Error).message}`, "Check the URL and that the server is running.");
        }
        return refuseRedirect(res, this.baseUrl);
      };
      let res = await open();
      // A refused credential: renew it (or pick up a new sign-in) and try once more, as every other call does.
      if (res?.status === 401 && this.auth.recover && !(await tokenEnded(res))) {
        await this.auth.recover();
        res = await open();
      }
      if (!res) return;
      if (!res.ok || !res.body) {
        const err = await res
          .json()
          .then((b) => (b as ErrorBody).error)
          .catch(() => undefined);
        throw new ClientError(res.status, err?.code ?? "events_failed", err?.message ?? `Can't open the event stream (HTTP ${res.status}).`, err?.hint);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (signal?.aborted) return;
          if (dead) throw new ClientError(0, "unreachable", `Heard nothing from ${this.baseUrl} for ${Math.round((beat * 2.5) / 1000)} s.`);
          throw new ClientError(0, "unreachable", `Lost ${this.baseUrl}: ${(e as Error).message}`);
        }
        if (chunk.done) return;
        heard();
        buf += dec.decode(chunk.value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let type = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          const parsed = JSON.parse(data) as { heartbeat?: unknown };
          if (type === "ready" && typeof parsed.heartbeat === "number" && parsed.heartbeat > 0) {
            beat = parsed.heartbeat;
            heard();
          }
          onEvent(type, parsed);
        }
      }
    } finally {
      if (silent) clearTimeout(silent);
      signal?.removeEventListener("abort", stop);
    }
  }
}
