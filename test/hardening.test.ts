import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runProxy } from "../src/proxy.js";
import { createApi } from "../src/api.js";
import { loadState, saveState } from "../src/state.js";
import { withFileLock } from "../src/file-lock.js";
import { writeEntry, writeText } from "../src/agents.js";
import { boundedText } from "../src/bounds.js";

afterEach(() => vi.useRealTimers());
const json = (body: unknown, session?: string) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) },
});
function proxy(fetcher: typeof fetch, output: Writable = new PassThrough()) {
  const input = new PassThrough();
  let text = "";
  if (output instanceof PassThrough) output.on("data", (chunk) => { text += chunk; });
  const done = runProxy({ input, output, fetch: fetcher, endpoint: "https://gateway.invalid/mcp", token: "fixture", log: () => {} });
  return { input, done, messages: () => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

it("rejects null, primitives, empty and mixed batches without losing valid requests", async () => {
  const seen: unknown[] = [];
  const p = proxy((async (_url, init) => {
    const body = JSON.parse(String(init?.body)); seen.push(body);
    const list = Array.isArray(body) ? body : [body];
    return json(list.filter((m) => m.id !== undefined).map((m) => ({ jsonrpc: "2.0", id: m.id, result: {} })));
  }) as typeof fetch);
  p.input.end('null\n42\n[]\n[null,{"jsonrpc":"2.0","id":7,"method":"ping"},false]\n');
  await p.done;
  expect(p.messages().filter((m) => m.error?.code === -32600)).toHaveLength(5);
  expect(p.messages().some((m) => m.id === 7 && m.result)).toBe(true);
  expect(seen).toHaveLength(1);
});

it("bounds shutdown when DELETE ignores abort", async () => {
  vi.useFakeTimers();
  let deleted = false;
  const p = proxy((async (_url, init) => {
    if (init?.method === "DELETE") { deleted = true; return new Promise(() => {}); }
    return json({ jsonrpc: "2.0", id: 1, result: {} }, "one");
  }) as typeof fetch);
  p.input.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  await vi.advanceTimersByTimeAsync(3001);
  await p.done;
  expect(deleted).toBe(true);
});

it("bounds REST fetches and response bodies", async () => {
  vi.useFakeTimers();
  const fetchHang = createApi("https://api.invalid", (() => new Promise(() => {})) as typeof fetch).account("fixture");
  const assertion = expect(fetchHang).rejects.toThrow("Could not reach");
  await vi.advanceTimersByTimeAsync(30_001); await assertion;
  const bodyHang = createApi("https://api.invalid", (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch).account("fixture");
  const bodyAssertion = expect(bodyHang).rejects.toThrow("Could not reach");
  await vi.advanceTimersByTimeAsync(30_001); await bodyAssertion;
});

it("cancels an oversized body while streaming", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } }));
  await expect(boundedText(response, 10)).rejects.toThrow("size limit");
  expect(cancelled).toBe(true);
});

it("rejects stale credentials and a competing config update", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-race-"));
  const opts = { env: { TOOLSTILE_CONFIG_DIR: dir } };
  try {
    const first = loadState(opts), second = loadState(opts);
    first.device = { id: "one", label: "one" }; saveState(first, opts);
    second.device = { id: "two", label: "two" };
    expect(() => saveState(second, opts)).toThrow("changed in another command");
    expect(loadState(opts).device?.id).toBe("one");
    const target = { client: "cursor" as const, name: "Cursor", path: join(dir, "mcp.json"), format: "mcpServers" as const, detected: true };
    withFileLock(target.path, () => {
      expect(() => writeEntry(target, { command: "npx", args: ["toolstile", "mcp", "proxy"] })).toThrow("Another command");
    });
    writeEntry(target, { command: "npx", args: ["toolstile", "mcp", "proxy"] });
    expect(JSON.parse(readFileSync(target.path, "utf8")).mcpServers.toolstile.command).toBe("npx");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("coalesces reopen and starts a new GET after replacing an active stream", async () => {
  let opens = 0;
  const gets: string[] = [];
  const p = proxy((async (_url, init) => {
    const session = (init?.headers as Record<string, string>)["Mcp-Session-Id"];
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "GET") {
      gets.push(session!);
      return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      opens++;
      await tick();
      return json({ jsonrpc: "2.0", id: body.id, result: {} }, `session-${opens}`);
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (session === "session-1") { await tick(); return new Response(null, { status: 404 }); }
    return json({ jsonrpc: "2.0", id: body.id, result: {} });
  }) as typeof fetch);
  p.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  for (let i = 0; i < 10; i++) await tick();
  p.input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
  for (let i = 0; i < 20; i++) await tick();
  p.input.end(); await p.done;
  expect(opens).toBe(2);
  expect(gets).toEqual(["session-1", "session-2"]);
  expect(p.messages().filter((m) => [2, 3].includes(m.id) && m.result)).toHaveLength(2);
});

it("waits for stdout before consuming another SSE reply", async () => {
  let release: (() => void) | undefined;
  let writes = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { writes++; release = () => callback(); } });
  const p = proxy((async () => new Response('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\ndata: {"jsonrpc":"2.0","method":"notice"}\n\n', { headers: { "content-type": "text/event-stream" } })) as typeof fetch, output);
  p.input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  for (let i = 0; i < 5; i++) await tick();
  expect(writes).toBe(1); release!();
  for (let i = 0; i < 5; i++) await tick();
  expect(writes).toBe(2); release!();
  p.input.end(); await p.done;
});

it("bounds pending POSTs and shuts down even when all transports ignore abort", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const p = proxy((() => { calls++; return new Promise(() => {}); }) as typeof fetch);
  p.input.end(Array.from({ length: 100 }, (_, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })).join("\n") + "\n");
  await vi.advanceTimersByTimeAsync(3001);
  await p.done;
  expect(calls).toBeLessThanOrEqual(64);
});

it("rejects oversized SSE events and error bodies without buffering to EOF", async () => {
  for (const sse of [false, true]) {
    let cancelled = false;
    const p = proxy((async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse ? `data: ${"x".repeat(1024 * 1024 + 1)}` : "x".repeat(5000))); },
      cancel() { cancelled = true; },
    }), { status: sse ? 200 : 403, headers: { "content-type": sse ? "text/event-stream" : "text/plain" } })) as typeof fetch);
    p.input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    await p.done;
    expect(cancelled).toBe(true);
    expect(p.messages().some((m) => m.id === 1 && m.error)).toBe(true);
  }
});

it("bounds shutdown when stdout never completes its write", async () => {
  vi.useFakeTimers();
  const output = new Writable({ write() {} });
  const p = proxy((async () => json({ jsonrpc: "2.0", id: 1, result: {} })) as typeof fetch, output);
  p.input.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await vi.advanceTimersByTimeAsync(3001);
  await p.done;
});


it("detects credentials saved by another process after this command loaded them", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-process-race-"));
  const opts = { env: { TOOLSTILE_CONFIG_DIR: dir } };
  try {
    const stale = loadState(opts);
    const module = new URL("../dist/state.js", import.meta.url).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { loadState, saveState } = await import(${JSON.stringify(module)});
      const opts = { env: { TOOLSTILE_CONFIG_DIR: ${JSON.stringify(dir)} } };
      const state = loadState(opts);
      state.device = { id: "other-process", label: "fixture" };
      saveState(state, opts);
    `]);
    expect(() => saveState(stale, opts)).toThrow("changed in another command");
    expect(loadState(opts).device?.id).toBe("other-process");
    const config = join(dir, "config.json");
    writeText(config, "first"); writeText(config, "second");
    expect(() => writeText(config, "stale", "first")).toThrow("changed while");
    expect(readFileSync(config, "utf8")).toBe("second");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("forwards server replies and cancellation with all request slots occupied, including a mixed batch", async () => {
  const releases = new Map<number, () => void>();
  const controls: unknown[] = [];
  let active = 0, peak = 0;
  const p = proxy((async (_url, init) => {
    const parsed = JSON.parse(String(init?.body));
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.every((m) => m.method === undefined || m.method === "notifications/cancelled")) {
      controls.push(...messages);
      return new Response(null, { status: 202 });
    }
    const message = messages[0];
    active++; peak = Math.max(peak, active);
    if (message.id === 0) {
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":"server","method":"sampling/createMessage","params":{}}\n\n'));
        releases.set(0, () => {
          active--;
          c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":0,"result":{}}\n\n'));
          c.close();
        });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Promise<Response>((resolve) => releases.set(message.id, () => {
      active--; resolve(json({ jsonrpc: "2.0", id: message.id, result: {} }));
    }));
  }) as typeof fetch);
  p.input.write(Array.from({ length: 64 }, (_, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call" })).join("\n") + "\n");
  await vi.waitFor(() => expect(releases.size).toBe(64));
  expect(p.messages()).toContainEqual(expect.objectContaining({ id: "server", method: "sampling/createMessage" }));
  const reply = { jsonrpc: "2.0", id: "server", result: { content: [] } };
  const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } };
  p.input.write(JSON.stringify([{ jsonrpc: "2.0", id: 64, method: "ping" }, reply, cancel]) + "\n");
  await vi.waitFor(() => expect(controls).toEqual([reply, cancel]));
  expect(p.messages()).toContainEqual(expect.objectContaining({ id: 64, error: expect.objectContaining({ code: -32000 }) }));
  expect(peak).toBe(64);
  for (const release of releases.values()) release();
  await vi.waitFor(() => expect(p.messages().filter((m) => m.result)).toHaveLength(64));
  // Capacity is reusable after completion, without having queued the rejected request.
  p.input.write('{"jsonrpc":"2.0","id":65,"method":"ping"}\n');
  await vi.waitFor(() => expect(releases.has(65)).toBe(true));
  releases.get(65)!();
  p.input.end(); await p.done;
});

it("bounds control traffic independently when its transports never finish", async () => {
  let calls = 0;
  const p = proxy((() => { calls++; return new Promise(() => {}); }) as typeof fetch);
  p.input.write(Array.from({ length: 1000 }, (_, id) => JSON.stringify({ jsonrpc: "2.0", id, result: {} })).join("\n") + "\n");
  await p.done;
  expect(calls).toBe(64);
});

it.each(["{", "null", "[]", "[null,false]", JSON.stringify(Array(65).fill(null))])(
  "bounds failure output under a malformed-input flood: %s", async (line) => {
    let writes = 0, calls = 0;
    const output = new Writable({ write() { writes++; } });
    const p = proxy((async () => { calls++; return new Response(null, { status: 202 }); }) as typeof fetch, output);
    // Keep stdin open: bounded termination must not depend on EOF or a timer.
    p.input.write((line + "\n").repeat(1000));
    await p.done;
    expect(writes).toBe(1);
    expect(calls).toBe(0);
  },
);

it.each(["http", "transport", "body", "early-end"])(
  "awaits each failure write within a batch and retains capacity until stdout completes: %s", async (mode) => {
    let writes = 0, calls = 0;
    const callbacks: (() => void)[] = [];
    const output = new Writable({ write(_chunk, _encoding, callback) { writes++; callbacks.push(callback); } });
    const p = proxy((async () => {
      calls++;
      if (mode === "transport") throw new Error("offline fixture");
      if (mode === "http") return new Response("denied", { status: 403 });
      if (mode === "body") return new Response("{", { headers: { "content-type": "application/json" } });
      return new Response(null, { status: 202 });
    }) as typeof fetch, output);
    p.input.write(JSON.stringify(Array.from({ length: 64 }, (_, id) => ({ jsonrpc: "2.0", id, method: "ping" }))) + "\n");
    for (let i = 0; i < 10; i++) await tick();
    expect(calls).toBe(1); expect(writes).toBe(1);
    // All 64 request slots remain held by the failing batch until its errors drain.
    p.input.write('{"jsonrpc":"2.0","id":99,"method":"ping"}\n');
    for (let i = 0; i < 5; i++) await tick();
    expect(calls).toBe(1); expect(writes).toBe(1);
    for (let i = 0; i < 65; i++) {
      callbacks.shift()!();
      for (let j = 0; j < 3; j++) await tick();
    }
    expect(writes).toBe(65);
    p.input.end(); await p.done;
  },
);

it("closes on oversized unterminated stdin instead of accumulating a line", async () => {
  let calls = 0;
  const p = proxy((async () => { calls++; return new Response(null, { status: 202 }); }) as typeof fetch);
  p.input.write("x".repeat(1024 * 1024 + 1));
  await p.done;
  expect(calls).toBe(0);
});

it("allows a mixed-batch server reply during initialize without waiting for its final reply", async () => {
  let answer!: () => void;
  let gotReply = false;
  const p = proxy((async (_url, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const parsed = JSON.parse(String(init?.body));
    const message = Array.isArray(parsed) ? parsed[0] : parsed;
    if (message.method === "initialize") return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":"server","method":"ping"}\n\n'));
      answer = () => {
        c.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));
        c.close();
      };
    } }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "initializing" } });
    expect((init?.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("initializing");
    if (message.method === "ping") {
      expect(gotReply).toBe(true);
      return json({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    gotReply = true;
    answer();
    return new Response(null, { status: 202 });
  }) as typeof fetch);
  p.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  await vi.waitFor(() => expect(p.messages()).toContainEqual(expect.objectContaining({ id: "server" })));
  p.input.write('[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","id":"server","result":{}}]\n');
  await vi.waitFor(() => expect(gotReply).toBe(true));
  p.input.end(); await p.done;
  expect(p.messages()).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
  expect(p.messages()).toContainEqual({ jsonrpc: "2.0", id: 2, result: {} });
});

it.each(["separate", "combined", "64KiB"])("accepts bounded SSE events independent of %s transport chunks", async (mode) => {
  const reply = `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(1_048_000) } })}\n\n`;
  const notice = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notice", params: { text: "x".repeat(2_000) } })}\n\n`;
  const wire = notice + reply + notice;
  const chunks = mode === "separate" ? [notice, reply, notice] : mode === "combined" ? [wire] :
    Array.from({ length: Math.ceil(wire.length / 65536) }, (_, i) => wire.slice(i * 65536, (i + 1) * 65536));
  const p = proxy((async () => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
  p.input.end('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await p.done;
  expect(p.messages().filter((message) => message.id === 1 && message.result)).toHaveLength(1);
  expect(p.messages().filter((message) => message.method === "notice")).toHaveLength(2);
  expect(p.messages().some((message) => message.error)).toBe(false);
});

it.each([405, 500])("cancels an unfinished rejected GET body and signal (%s)", async (status) => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const p = proxy((async (_url, init) => {
    if (init?.method === "GET") {
      signal = init.signal!;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init?.body));
    return message.method === "initialize" ? json({ jsonrpc: "2.0", id: message.id, result: {} }, "session") : new Response(null, { status: 202 });
  }) as typeof fetch);
  p.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(signal?.aborted).toBe(true);
  p.input.end();
  await p.done;
});

it("exits its process after an HTTP server leaves a rejected GET body open", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { default: EventEmitter } = await import("node:events");
  const once = EventEmitter.once;
  let getStarted = false, getClosed = false;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      getStarted = true;
      request.on("close", () => { getClosed = true; });
      response.writeHead(405, { "content-type": "text/plain" });
      response.write("Stream unsupported");
      return;
    }
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const message = JSON.parse(text);
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      } else { response.writeHead(202); response.end(); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as import("node:net").AddressInfo).port;
  const moduleUrl = new URL("../dist/proxy.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runProxy } from ${JSON.stringify(moduleUrl)};
    await runProxy({ input: process.stdin, output: process.stdout, endpoint: "http://127.0.0.1:${port}/mcp", token: "fixture", log: () => {} });
  `], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.resume(); child.stderr.resume();
  const exited = once(child, "exit");
  let timer: NodeJS.Timeout | undefined;
  try {
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await vi.waitFor(() => expect(getStarted).toBe(true));
    child.stdin.end();
    const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Proxy process did not exit")), 4000); })]);
    expect(result).toEqual([0, null]);
    await vi.waitFor(() => expect(getClosed).toBe(true));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    server.closeAllConnections(); server.close(); await once(server, "close");
  }
});

it("serializes config and credential removal against a second Node process", () => {
  const script = new URL("./fixtures/process-disable-race.mjs", import.meta.url);
  const result = JSON.parse(execFileSync(process.execPath, [script.pathname], { encoding: "utf8", timeout: 10000 }));
  expect(result).toEqual({ enabling: { code: 0 }, disabling: 0, credential: "fresh", configured: true, remote: ["fresh"] });
});
