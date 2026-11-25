// `fontego mcp proxy`: a local MCP server over stdio that hands every message to the Fontego's /mcp with this
// machine's session, renewed when it ends. For agents that can't ask a program for their headers (Copilot, OpenCode,
// Cursor, Gemini CLI), so they too work as their person without a token written into their config. It doesn't speak
// the protocol: it forwards JSON-RPC as it comes, one line each way, adding the HTTP headers the protocol asks of a
// client (the revision and, from 2026-07-28 on, the method and the name).

import { ClientError, refuseRedirect } from "../client.ts";
import { forPerson } from "../terminal.ts";
import { USER_AGENT } from "../version.ts";

/** Where the requests go and how they prove who sends them. */
export interface ProxyTarget {
  /** The Fontego's /mcp */
  url: string;
  token: () => Promise<string>;
  /** After a 401: renew the session (or pick up a new sign-in), or throw why there is none */
  recover?: () => Promise<void>;
  agent: string | null;
}

type Message = Record<string, unknown> & { id?: unknown; method?: unknown; params?: Record<string, unknown> };

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** The headers the protocol asks of an HTTP client for one message (Streamable HTTP, both eras). */
export function headersFor(message: unknown, negotiated: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const m = (Array.isArray(message) ? message[0] : message) as Message | undefined;
  const envelope = (m?.params?._meta as Record<string, unknown> | undefined)?.[PROTOCOL_VERSION_KEY];
  if (typeof envelope === "string") {
    // 2026-07-28: every request says its revision, its method and, for a tool or a prompt, its name.
    h["mcp-protocol-version"] = envelope;
    if (typeof m?.method === "string") h["mcp-method"] = m.method;
    const name = m?.params?.name ?? m?.params?.uri;
    if (typeof name === "string") h["mcp-name"] = name;
  } else if (negotiated) {
    // 2025-11-25: after the handshake, the revision it agreed on.
    h["mcp-protocol-version"] = negotiated;
  }
  return h;
}

/** The JSON-RPC messages of an answer: a JSON body (one or a batch) or the events of an SSE stream. */
export function messagesOf(body: string, contentType: string): unknown[] {
  if (contentType.includes("text/event-stream")) {
    const out: unknown[] = [];
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(JSON.parse(data));
    }
    return out;
  }
  if (!body.trim()) return [];
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

const isRequest = (m: unknown): m is Message => !!m && typeof m === "object" && "method" in m && "id" in m && (m as Message).id !== undefined;

/** An answer to a request that never reached a result: what went wrong, and what to do. */
const failure = (id: unknown, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code: -32603, message, ...(data !== undefined ? { data } : {}) } });

/**
 * Runs the bridge until stdin ends and every request in flight is answered. `write` takes one message (a line);
 * `log` is for the agent's log (stderr).
 */
export async function runProxy(
  target: ProxyTarget,
  io: { lines: AsyncIterable<string>; write: (message: unknown) => void; log: (text: string) => void },
): Promise<void> {
  let negotiated: string | null = null;
  const inFlight = new Set<Promise<void>>();

  const post = async (message: unknown, retried = false): Promise<Response> => {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        ...headersFor(message, negotiated),
        authorization: `Bearer ${await target.token()}`,
        "user-agent": USER_AGENT,
        ...(target.agent ? { "fontego-agent": target.agent } : {}),
      },
      body: JSON.stringify(message),
      redirect: "manual",
    });
    refuseRedirect(res, target.url);
    if (res.status === 401 && !retried && target.recover) {
      await target.recover();
      return post(message, true);
    }
    return res;
  };

  const forward = async (message: unknown) => {
    const batch = Array.isArray(message);
    const requests = (batch ? message : [message]).filter(isRequest);
    const out: unknown[] = [];
    try {
      const res = await post(message);
      const type = res.headers.get("content-type") ?? "";
      const body = await res.text();
      if (!res.ok && !type.includes("json") && !type.includes("event-stream")) throw new Error(`HTTP ${res.status}`);
      let answers: unknown[] = [];
      if (res.status !== 202 && res.status !== 204) {
        try {
          answers = messagesOf(body, type);
        } catch {
          throw new Error(`HTTP ${res.status}: not JSON-RPC`);
        }
      }
      // A refusal before the protocol (Fontego's own error: not signed in, too many requests) answers each request.
      const fontego = answers.length === 1 && (answers[0] as { error?: { code?: unknown; message?: string; hint?: string } }).error;
      if (!res.ok && fontego && typeof fontego.code === "string") {
        for (const r of requests) out.push(failure(r.id, [fontego.message, fontego.hint].filter(Boolean).join(" "), { code: fontego.code }));
      } else {
        for (const a of answers) {
          const v = (a as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
          if (typeof v === "string" && requests.some((r) => r.method === "initialize")) negotiated = v;
          out.push(a);
        }
        // A request the answer left without its result (a stream cut short) is answered, so the agent doesn't wait.
        const answered = new Set(answers.map((a) => JSON.stringify((a as { id?: unknown }).id)));
        for (const r of requests) if (!answered.has(JSON.stringify(r.id))) out.push(failure(r.id, `${target.url} answered without a result for this request (HTTP ${res.status}).`));
      }
    } catch (e) {
      // The session that ended says how to sign in again; anything else is the way there.
      const hint = e instanceof ClientError ? e.hint : undefined;
      const why = [(e as Error).message, hint].filter(Boolean).join(" ");
      const said = e instanceof ClientError && e.status !== 0 ? why : `fontego couldn't reach ${target.url}: ${why}`;
      // Some of it may be the server's words, and an agent may show its log on a terminal
      io.log(forPerson(`fontego mcp proxy: ${said}`));
      for (const r of requests) out.push(failure(r.id, said));
    }
    // A batch is answered as one, as it came.
    if (batch) {
      if (out.length) io.write(out);
    } else for (const m of out) io.write(m);
  };

  for await (const line of io.lines) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      io.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: a line that isn't JSON." } });
      continue;
    }
    // The handshake goes first and alone: what follows needs the revision it agrees on.
    const initializing = (Array.isArray(message) ? message : [message]).some((m) => (m as Message)?.method === "initialize");
    const p = forward(message).finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (initializing) await p;
  }
  await Promise.all(inFlight);
}

/** stdin as lines, for runProxy. */
export async function* stdinLines(): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}
