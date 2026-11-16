// HTTP client of the API. The CLI uses it today; the sync daemon and the MCP adapter will reuse it.

import type {
  ChangeSetRequest,
  ChangeSetResult,
  Commit,
  ErrorBody,
  FileMeta,
  Me,
  Member,
  SearchHit,
  SyncResponse,
  TreeResponse,
  WorkspaceInfo,
} from "@workspaces/core";

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
    private readonly userAgent = "ws-cli/0.1.0",
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
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
      });
    } catch (e) {
      throw new ClientError(0, "unreachable", `Can't reach ${this.baseUrl}: ${(e as Error).message}`, "Check the URL and that the server is running.");
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

  workspaces(category?: string) {
    return this.json<{ workspaces: WorkspaceInfo[] }>("GET", `/v1/workspaces${category ? `?category=${enc(category)}` : ""}`).then((r) => r.workspaces);
  }

  workspace(ws: string) {
    return this.json<WorkspaceInfo>("GET", `/v1/workspaces/${enc(ws)}`);
  }

  members(ws: string) {
    return this.json<{ members: Member[] }>("GET", `/v1/workspaces/${enc(ws)}/members`).then((r) => r.members);
  }

  tree(ws: string, opts: { path?: string; rev?: string; recursive?: boolean } = {}) {
    const q = new URLSearchParams();
    if (opts.path) q.set("path", opts.path);
    if (opts.rev) q.set("rev", opts.rev);
    if (opts.recursive) q.set("recursive", "1");
    return this.json<TreeResponse>("GET", `/v1/workspaces/${enc(ws)}/tree?${q}`);
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

  fileMeta(ws: string, path: string, rev?: string) {
    return this.json<FileMeta>("GET", `/v1/workspaces/${enc(ws)}/files/${encPath(path)}?meta=1${rev ? `&rev=${enc(rev)}` : ""}`);
  }

  history(ws: string, opts: { path?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (opts.path) q.set("path", opts.path);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.json<{ commits: Commit[] }>("GET", `/v1/workspaces/${enc(ws)}/history?${q}`).then((r) => r.commits);
  }

  search(ws: string, query: string, opts: { path?: string; limit?: number } = {}) {
    const q = new URLSearchParams({ q: query });
    if (opts.path) q.set("path", opts.path);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.json<{ hits: SearchHit[] }>("GET", `/v1/workspaces/${enc(ws)}/search?${q}`).then((r) => r.hits);
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
