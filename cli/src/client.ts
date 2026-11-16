// HTTP client of the API. Commands the server declares go through call(); sync, clone and the other built-in
// commands use the typed methods. Every answer says which version of the commands the server has, and the client
// remembers the last one so the CLI can tell when its saved list is stale.

import {
  COMMANDS_HEADER,
  type ChangeSetRequest,
  type ChangeSetResult,
  type CommandsManifest,
  type ErrorBody,
  type Me,
  type SyncResponse,
  type WorkspaceInfo,
} from "@fontego/core";

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

const enc = encodeURIComponent;
const encPath = (p: string) => p.split("/").map(enc).join("/");

export class Client {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly userAgent = "fontego-cli/0.1.0",
  ) {}

  /** Version of the server's commands, from the last answer that carried it */
  commandsVersion: string | null = null;

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl.replace(/\/+$/, "") + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "user-agent": this.userAgent,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      throw new ClientError(0, "unreachable", `Can't reach ${this.baseUrl}: ${(e as Error).message}`, "Check the URL and that the server is running.");
    }
    this.commandsVersion = res.headers.get(COMMANDS_HEADER) ?? this.commandsVersion;
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

  /** A one-time link that opens the web app already signed in (valid two minutes). */
  sessionCode() {
    return this.json<{ code: string; expiresAt: string; url: string }>("POST", "/v1/session/code");
  }

  workspace(ws: string) {
    return this.json<WorkspaceInfo>("GET", `/v1/workspaces/${enc(ws)}`);
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

  /** Opens the live event stream; calls onEvent for each event until the signal aborts. */
  async events(ws: string, onEvent: (type: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/v1/workspaces/${enc(ws)}/events`, {
      headers: { authorization: `Bearer ${this.token}`, "user-agent": this.userAgent, accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new ClientError(res.status, "events_failed", `Can't open the event stream (HTTP ${res.status}).`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
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
        if (data) onEvent(type, JSON.parse(data));
      }
    }
  }
}
