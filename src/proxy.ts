import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Bridges an agent's stdio MCP connection to the Toolstile gateway's Streamable HTTP endpoint,
 * so the agent's config holds a command instead of a credential. Messages pass through
 * unchanged; only the transport differs.
 */
export interface ProxyOptions {
  endpoint: string;
  token: string;
  input: Readable;
  output: Writable;
  log: (message: string) => void;
  fetch?: typeof fetch;
}

type Message = { jsonrpc: "2.0"; id?: string | number | null; method?: string; result?: unknown; error?: unknown };

/** Yields each SSE event's data and id. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ data: string; id?: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let id: string | undefined;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
      if (line === "") {
        if (data.length) yield { data: data.join("\n"), id };
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }
  if (data.length) yield { data: data.join("\n"), id };
}

export function runProxy(options: ProxyOptions): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let listening = false;
  let closed = false;
  const listener = new AbortController();
  const pending = new Set<Promise<void>>();
  /** Later messages wait for `initialize`, so they carry the session it opens. */
  let initialized: Promise<void> = Promise.resolve();

  const write = (message: unknown) => {
    if (!options.output.writableEnded) options.output.write(`${JSON.stringify(message)}\n`);
  };
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${options.token}`,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    ...(protocolVersion ? { "Mcp-Protocol-Version": protocolVersion } : {}),
    ...extra,
  });
  const explain = (status: number, text: string) =>
    status === 401
      ? "Toolstile no longer accepts this agent's access (removed from the dashboard?). Run `toolstile mcp setup` to enable it again."
      : status === 403
        ? `Toolstile refused this agent: ${text || "access denied"}`
        : status === 429
          ? "Toolstile is rate limiting this agent; try again shortly."
          : `Toolstile returned ${status}${text ? `: ${text}` : ""}`;

  const deliver = (message: Message) => {
    if (message.id !== undefined && message.result && typeof message.result === "object") {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === "string") protocolVersion = version;
    }
    write(message);
  };

  async function readBody(response: Response) {
    const type = response.headers.get("content-type") ?? "";
    if (!response.body) return;
    if (type.includes("text/event-stream")) {
      for await (const event of events(response.body)) {
        try {
          deliver(JSON.parse(event.data) as Message);
        } catch {
          options.log("Ignored a malformed message from Toolstile.");
        }
      }
      return;
    }
    if (type.includes("application/json")) {
      const body = (await response.json()) as Message | Message[];
      for (const message of Array.isArray(body) ? body : [body]) deliver(message);
    }
  }

  /** Server-initiated messages (list changes, approvals) arrive on a long-lived GET stream. */
  async function listen() {
    if (listening || !sessionId) return;
    listening = true;
    let lastEventId: string | undefined;
    for (let attempt = 0; !closed && attempt < 8; attempt++) {
      try {
        const response = await fetcher(options.endpoint, {
          method: "GET",
          headers: headers({ Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }),
          signal: listener.signal,
        });
        // 405: this server offers no stream; that is allowed.
        if (response.status === 405 || !response.ok || !response.body) return;
        attempt = 0;
        for await (const event of events(response.body)) {
          if (event.id) lastEventId = event.id;
          try {
            deliver(JSON.parse(event.data) as Message);
          } catch {}
        }
      } catch {
        if (closed) return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
    }
  }

  async function send(line: string) {
    let messages: Message[];
    try {
      const parsed = JSON.parse(line) as Message | Message[];
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const requests = messages.filter((m) => m.method !== undefined && m.id !== undefined);
    const fail = (message: string) => {
      for (const request of requests)
        write({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
    };
    try {
      const response = await fetcher(options.endpoint, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
        body: line,
      });
      const session = response.headers.get("mcp-session-id");
      if (session) sessionId = session;
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).trim().slice(0, 300);
        const message = explain(response.status, text);
        options.log(message);
        fail(message);
        return;
      }
      await readBody(response);
      if (messages.some((m) => m.method === "notifications/initialized")) void listen();
    } catch (error) {
      const message = `Could not reach Toolstile: ${(error as Error).message}`;
      options.log(message);
      fail(message);
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      const opening = /"method"\s*:\s*"initialize"/.test(line);
      const task = (opening ? send(line) : initialized.then(() => send(line))).finally(() => pending.delete(task));
      if (opening) initialized = task;
      pending.add(task);
    });
    lines.on("close", async () => {
      await Promise.allSettled([...pending]);
      closed = true;
      listener.abort();
      if (sessionId)
        await fetcher(options.endpoint, { method: "DELETE", headers: headers() }).catch(() => undefined);
      resolve();
    });
  });
}
