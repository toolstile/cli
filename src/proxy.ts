import { boundedText, deadline } from "./bounds.js";
import { StringDecoder } from "node:string_decoder";
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

// Replies and notifications can unblock an active request, even during initialization.
const urgent = (message: Message) => message.method === undefined ||
  (message.id === undefined && message.method !== "notifications/initialized");

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return false;
  if ("id" in m && m.id !== null && typeof m.id !== "string" && !(typeof m.id === "number" && Number.isFinite(m.id))) return false;
  if ("method" in m) return typeof m.method === "string" && !("result" in m) && !("error" in m) &&
    (!("params" in m) || (m.params !== null && typeof m.params === "object"));
  if (!("id" in m) || (("result" in m) === ("error" in m))) return false;
  if ("error" in m) {
    const e = m.error as Record<string, unknown> | null;
    return !!e && typeof e === "object" && Number.isInteger(e.code) && typeof e.message === "string";
  }
  return true;
}

/** Yields each SSE event's data and id. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ data: string; id?: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let id: string | undefined;
  let eventBytes = 0;
  let lineBytes = 0;
  const append = (part: string) => {
    lineBytes += Buffer.byteLength(part, "utf8");
    if (lineBytes > 1024 * 1024) throw new Error("SSE line exceeded the size limit");
    buffer += part;
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      append(text.slice(start, newline));
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      lineBytes = 0;
      start = newline + 1;
      if (line === "") {
        if (data.length) yield { data: data.join("\n"), id };
        data = [];
        eventBytes = 0;
        continue;
      }
      eventBytes += Buffer.byteLength(line, "utf8");
      if (eventBytes > 1024 * 1024) throw new Error("SSE event exceeded the size limit");
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    append(text.slice(start));
  }
  append(decoder.decode());
  if (data.length) yield { data: data.join("\n"), id };
}

/** Frame incrementally rather than letting readline queue unbounded complete lines. */
async function* inputLines(input: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const append = (part: string) => {
    if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > 1024 * 1024)
      throw new Error("Input line exceeded the size limit");
    buffer += part;
  };
  for await (const chunk of input) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      append(text.slice(start, newline));
      yield buffer;
      buffer = "";
      start = newline + 1;
    }
    append(text.slice(start));
  }
  append(decoder.end());
  if (buffer) yield buffer;
}

/** How long in-flight requests may finish after the agent closes stdin. */
const CLOSE_GRACE_MS = 3000;

export function runProxy(options: ProxyOptions): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  /** The agent's own `initialize`, replayed if the gateway forgets the session. */
  let opening: string | undefined;
  let listener: AbortController | undefined;
  let recovering: Promise<boolean> | undefined;
  let closed = false;
  /** Aborts every request and the listener's waits once the agent has gone. */
  const shutdown = new AbortController();
  const pending = new Set<Promise<void>>();
  /** Later messages wait for `initialize`, so they carry the session it opens. */
  let initialized: Promise<void> = Promise.resolve();

  // Requests and control messages have independent budgets. No waiting input queue:
  // overload is answered locally, and exhausted control/output budgets close the proxy.
  const LIMIT = 64;
  let requestCount = 0;
  let controlCount = 0;
  let finishForced: () => void;
  const forced = new Promise<void>((resolve) => { finishForced = resolve; });
  const stop = () => {
    closed = true;
    shutdown.abort();
    options.input.destroy();
    finishForced();
  };
  let writes: Promise<void> = Promise.resolve();
  let queuedWrites = 0;
  let queuedBytes = 0;
  const write = (message: unknown) => {
    if (closed) return Promise.resolve();
    const text = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(text);
    if (queuedWrites >= 128 || queuedBytes + bytes > 8 * 1024 * 1024) {
      options.log("Proxy output limit exceeded; closing the connection.");
      stop();
      return Promise.resolve();
    }
    queuedWrites++;
    queuedBytes += bytes;
    writes = writes.then(() => new Promise<void>((resolve, reject) => {
      if (closed || options.output.writableEnded) return resolve();
      const finish = (error?: Error | null) => error ? reject(error) : resolve();
      options.output.write(text, finish);
    })).finally(() => { queuedWrites--; queuedBytes -= bytes; });
    // Observe immediately; send/readBody await the same promise to apply backpressure.
    void writes.catch(stop);
    return writes;
  };
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${options.token}`,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    ...(protocolVersion ? { "Mcp-Protocol-Version": protocolVersion } : {}),
    ...extra,
  });
  /** Never follow a redirect: the token is only for the gateway endpoint. */
  const request = (init: RequestInit) =>
    shutdown.signal.aborted
      ? Promise.reject(new Error("The agent closed the connection"))
      : fetcher(options.endpoint, { ...init, redirect: "error", signal: init.signal ?? shutdown.signal });
  const post = (body: string) =>
    request({
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
      body,
    });
  const explain = (status: number, text: string) =>
    status === 401
      ? "Toolstile no longer accepts this agent's access (removed from the dashboard?). Run `toolstile mcp setup` to enable it again."
      : status === 403
        ? `Toolstile refused this agent: ${text || "access denied"}`
        : status === 429
          ? "Toolstile is rate limiting this agent; try again shortly."
          : `Toolstile returned ${status}${text ? `: ${text}` : ""}`;

  const deliver = (message: Message, answered?: Set<unknown>) => {
    if (message.id !== undefined && message.result && typeof message.result === "object") {
      const version = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof version === "string") protocolVersion = version;
    }
    if (message.method === undefined && message.id !== undefined) answered?.add(message.id);
    return write(message);
  };

  async function readBody(response: Response, answered: Set<unknown>, quiet = false) {
    const type = response.headers.get("content-type") ?? "";
    const take = async (message: unknown) => {
      if (!isMessage(message)) throw new Error("Invalid JSON-RPC response");
      if (quiet) answered.add(message.id);
      else await deliver(message, answered);
    };
    if (!response.body) return;
    if (type.includes("text/event-stream")) {
      for await (const event of events(response.body)) {
        try {
          await take(JSON.parse(event.data));
        } catch {
          options.log("Ignored a malformed message from Toolstile.");
        }
      }
      return;
    }
    if (type.includes("application/json")) {
      const body: unknown = JSON.parse(await boundedText(response));
      for (const message of Array.isArray(body) ? body : [body]) await take(message);
    }
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      if (shutdown.signal.aborted) done();
      else shutdown.signal.addEventListener("abort", done, { once: true });
    });

  /** Server-initiated messages (list changes, approvals) arrive on a long-lived GET stream. */
  async function listen() {
    if (listener || !sessionId || closed) return;
    const current = listener = new AbortController();
    const stop = () => current.abort();
    shutdown.signal.addEventListener("abort", stop, { once: true });
    let lastEventId: string | undefined;
    try {
      for (let attempt = 0; !closed && !current.signal.aborted && attempt < 8; attempt++) {
        try {
          const response = await request({
            method: "GET",
            signal: current.signal,
            headers: headers({ Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }),
          });
          // 405: this server offers no stream; that is allowed.
          if (response.status === 405 || !response.ok || !response.body) {
            void response.body?.cancel().catch(() => undefined);
            break;
          }
          attempt = 0;
          for await (const event of events(response.body)) {
            if (current.signal.aborted) break;
            if (event.id) lastEventId = event.id;
            try {
              const message: unknown = JSON.parse(event.data);
              if (isMessage(message)) await deliver(message);
            } catch {}
          }
        } catch {
          if (closed) break;
        }
        if (current.signal.aborted) break;
        await wait(Math.min(30_000, 1000 * 2 ** attempt));
      }
    } finally {
      current.abort();
      shutdown.signal.removeEventListener("abort", stop);
      if (listener === current) listener = undefined;
    }
  }

  /**
   * The gateway answers 404 for a session it no longer has (for example after a restart).
   * Open a new one with the agent's original `initialize`, without showing its reply again.
   */
  async function replaceSession(): Promise<boolean> {
    if (!opening) return false;
    listener?.abort();
    listener = undefined;
    sessionId = undefined;
    const response = await post(opening);
    sessionId = response.headers.get("mcp-session-id") ?? undefined;
    if (!response.ok) return false;
    await readBody(response, new Set(), true);
    await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })).then((r) => r.body?.cancel());
    void listen().catch((error) => options.log(String(error)));
    return true;
  }

  function reopen(stale: string): Promise<boolean> {
    if (recovering) return recovering;
    if (sessionId !== stale) return Promise.resolve(true);
    recovering = replaceSession().finally(() => { recovering = undefined; });
    return recovering;
  }

  async function send(messages: Message[], batch: boolean) {
    const line = JSON.stringify(batch ? messages : messages[0]);
    const requests = messages.filter((m) => m.method !== undefined && m.id !== undefined);
    const answered = new Set<unknown>();
    const fail = async (message: string) => {
      for (const request of requests)
        if (!answered.has(request.id)) await write({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
    };
    if (messages.some((m) => m.method === "initialize")) opening = line;
    try {
      if (recovering && !messages.every(urgent)) await recovering;
      const stale = sessionId;
      let response = await post(line);
      if (response.status === 404 && stale && !messages.some((m) => m.method === "initialize")) {
        await response.body?.cancel();
        if (await reopen(stale)) response = await post(line);
      }
      const session = response.headers.get("mcp-session-id");
      if (session && (sessionId === stale || messages.some((m) => m.method === "initialize"))) sessionId = session;
      if (!response.ok) {
        const text = (await boundedText(response, 4096).catch(() => "")).trim().slice(0, 300);
        const message = explain(response.status, text);
        options.log(message);
        await fail(message);
        return;
      }
      await readBody(response, answered);
      if (messages.some((m) => m.method === "notifications/initialized")) void listen().catch((error) => options.log(String(error)));
      // A stream that ended early must still answer every request, or the agent waits forever.
      await fail("Toolstile closed the connection before answering. Try again.");
    } catch (error) {
      if (closed) return fail("The agent closed the connection.");
      const message = `Could not reach Toolstile: ${(error as Error).message}`;
      options.log(message);
      await fail(message);
    }
  }

  const invalid = (code: number, message: string, id: Message["id"] = null) => {
    // Immediate observation plus the global write budgets also bound parse/overload errors.
    void write({ jsonrpc: "2.0", id, error: { code, message } }).catch(stop);
  };
  const accept = (line: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { invalid(-32700, "Parse error"); return; }
    const batch = Array.isArray(parsed);
    const values: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length > LIMIT) { invalid(-32600, "Batch exceeds the request limit"); return; }
    if (!values.length) { invalid(-32600, "Invalid Request"); return; }
    const messages: Message[] = [];
    let requests = 0;
    let controls = 0;
    for (const value of values) {
      if (!isMessage(value)) { invalid(-32600, "Invalid Request"); continue; }
      if (value.method !== undefined && value.id !== undefined) {
        if (requestCount + requests >= LIMIT) {
          invalid(-32000, "Proxy request limit reached; try again after a request finishes.", value.id);
          continue;
        }
        requests++;
      } else {
        if (controlCount + controls >= LIMIT) {
          options.log("Proxy control limit exceeded; closing the connection.");
          stop();
          return;
        }
        controls++;
      }
      messages.push(value);
    }
    if (!messages.length || closed) return;
    // A mixed batch must not leave a server reply behind the initialize it unblocks.
    const immediate = messages.filter(urgent);
    const regular = messages.filter((message) => !urgent(message));
    if (regular.length) schedule(regular, batch, requests, controls - immediate.length);
    if (immediate.length) schedule(immediate, batch, 0, immediate.length);
  };
  const schedule = (messages: Message[], batch: boolean, requests: number, controls: number) => {
    requestCount += requests;
    controlCount += controls;
    const opens = messages.some((message) => message.method === "initialize");
    const task = (opens || messages.every(urgent) ? send(messages, batch) : initialized.then(() => send(messages, batch)))
      .catch((error) => options.log(`Proxy task failed: ${String(error)}`))
      .finally(() => {
        pending.delete(task);
        requestCount -= requests;
        controlCount -= controls;
      });
    if (opens) initialized = task;
    pending.add(task);
  };
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const inputEnded = () => {
    closeTimer = setTimeout(stop, CLOSE_GRACE_MS);
  };
  options.input.once("end", inputEnded);
  const outputError = () => stop();
  options.output.on("error", outputError);
  const work = (async () => {
    try {
      for await (const line of inputLines(options.input)) {
        if (closed) break;
        if (line.trim()) accept(line);
      }
    } catch (error) {
      options.log(`Proxy input failed: ${String(error)}`);
      stop();
    }
    // One total deadline covers in-flight work, blocked stdout and best-effort DELETE.
    await deadline(async (signal) => {
      await Promise.allSettled([...pending]);
      await writes;
      closed = true;
      shutdown.abort();
      if (sessionId) {
        const response = await fetcher(options.endpoint, { method: "DELETE", headers: headers(), redirect: "error", signal });
        void response.body?.cancel().catch(() => {});
      }
    }, CLOSE_GRACE_MS).catch(() => {});
    closed = true;
    shutdown.abort();
  })();
  return Promise.race([work, forced]).finally(() => {
    clearTimeout(closeTimer);
    options.input.removeListener("end", inputEnded);
    closed = true;
    shutdown.abort();
    void writes.then(
      () => options.output.removeListener("error", outputError),
      () => options.output.removeListener("error", outputError),
    );
  });
}
