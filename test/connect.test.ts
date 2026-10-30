import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualEditError, proxyCommand, readEntry, targets, writeEntry } from "../src/agents.js";
import { type Api, ApiError } from "../src/api.js";
import { type Context, login, logout, normalizeServer, setup } from "../src/commands.js";
import { audit } from "../src/index.js";
import { runProxy } from "../src/proxy.js";
import { style } from "../src/report.js";
import { loadState, saveState, statePath } from "../src/state.js";

let home: string;
const env = () => ({ TOOLSTILE_CONFIG_DIR: join(home, "cfg") });
const target = (client: string) => targets({ home, platform: "linux", env: {} }).find((t) => t.client === client)!;
const command = (client: Parameters<typeof proxyCommand>[0]) => proxyCommand(client, "0.2.0", "linux");

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-connect-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("agent config entries", () => {
  it("adds, keeps and removes the entry in a JSON config without touching other keys", () => {
    const t = target("claude-code");
    put(t.path, JSON.stringify({ numStartups: 2, mcpServers: { github: { command: "gh" } } }, null, 2));
    expect(writeEntry(t, command("claude-code"))).toBe("added");
    const data = JSON.parse(readFileSync(t.path, "utf8"));
    expect(data.numStartups).toBe(2);
    expect(data.mcpServers.github).toEqual({ command: "gh" });
    expect(data.mcpServers.toolstile).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "toolstile@0.2.0", "mcp", "proxy", "--agent", "claude-code"],
    });
    expect(writeEntry(t, command("claude-code"))).toBe("unchanged");
    expect(writeEntry(t, null)).toBe("removed");
    expect(JSON.parse(readFileSync(t.path, "utf8")).mcpServers).toEqual({ github: { command: "gh" } });
  });

  it("creates the config file and keeps an existing file's permissions", () => {
    const cursor = target("cursor");
    expect(writeEntry(cursor, command("cursor"))).toBe("added");
    expect(readEntry(cursor)).toMatchObject({ command: "npx" });
    const vscode = target("vscode");
    put(vscode.path, "{}");
    chmodSync(vscode.path, 0o640);
    writeEntry(vscode, command("vscode"));
    expect(statSync(vscode.path).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(vscode.path, "utf8")).servers.toolstile.type).toBe("stdio");
  });

  it("edits Codex TOML in place, keeping comments and other tables", () => {
    const t = target("codex");
    const original = '# mine\nmodel = "o4"\n\n[mcp_servers.other]\ncommand = "uvx" # pinned\nargs = ["x==1"]\n';
    put(t.path, original);
    expect(writeEntry(t, command("codex"))).toBe("added");
    const text = readFileSync(t.path, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain('[mcp_servers.toolstile]\ncommand = "npx"');
    expect(writeEntry(t, command("codex"))).toBe("unchanged");
    put(t.path, `${text}\n[mcp_servers.toolstile.env]\nX = "1"\n\n[profiles.a]\nmodel = "b"\n`);
    expect(writeEntry(t, null)).toBe("removed");
    const after = readFileSync(t.path, "utf8");
    expect(after).not.toContain("toolstile");
    expect(after).toContain("[mcp_servers.other]");
    expect(after).toContain("[profiles.a]");
  });

  it("leaves commented JSON alone unless it must change, and never removes a hand-written entry", () => {
    const t = target("gemini");
    put(t.path, '{\n  // keep me\n  "theme": "dark"\n}\n');
    expect(() => writeEntry(t, command("gemini"))).toThrow(ManualEditError);
    expect(writeEntry(t, null)).toBe("unchanged");
    put(t.path, `{\n  // keep me\n  "mcpServers": { "toolstile": ${JSON.stringify(command("gemini"))} }\n}\n`);
    expect(writeEntry(t, command("gemini"))).toBe("unchanged");

    const cursor = target("cursor");
    put(cursor.path, JSON.stringify({ mcpServers: { toolstile: { url: "https://toolstile.com/mcp" } } }));
    expect(writeEntry(cursor, null)).toBe("unchanged");
    expect(readEntry(cursor)).toEqual({ url: "https://toolstile.com/mcp" });
    expect(writeEntry(cursor, command("cursor"))).toBe("replaced");
  });

  it("writes through a symlinked config instead of replacing the link", () => {
    const t = target("cursor");
    const real = join(home, "dotfiles", "mcp.json");
    put(real, "{}");
    mkdirSync(dirname(t.path), { recursive: true });
    symlinkSync(real, t.path);
    writeEntry(t, command("cursor"));
    expect(lstatSync(t.path).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8")).mcpServers.toolstile.command).toBe("npx");
  });

  it("refuses Codex entries it cannot edit instead of crashing", () => {
    const t = target("codex");
    put(t.path, "[mcp_servers]\ntoolstile = { url = \"https://toolstile.com/mcp\" }\n");
    expect(() => writeEntry(t, command("codex"))).toThrow(ManualEditError);
  });

  it("starts npx through cmd on Windows", () => {
    expect(proxyCommand("cursor", "0.2.0", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "toolstile@0.2.0", "mcp", "proxy", "--agent", "cursor"],
    });
  });

  it("does not report proxy entries as a server duplicated across clients", () => {
    for (const client of ["claude-code", "cursor", "codex"] as const) writeEntry(target(client), command(client));
    const result = audit({ home, cwd: null, platform: "linux", env: {} });
    expect(result.findings).toEqual([]);
  });
});

describe("credentials file", () => {
  it("is owner-only and survives a round trip", () => {
    const state = loadState({ home, env: env() });
    expect(state.server).toBe("https://toolstile.com");
    state.agents.cursor = { id: "a", workspaceId: "w", server: "https://toolstile.com", label: "Cursor", token: "ts_x" };
    saveState(state, { home, env: env() });
    expect(statSync(statePath({ home, env: env() })).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "cfg")).mode & 0o777).toBe(0o700);
    expect(loadState({ home, env: env() }).agents.cursor?.token).toBe("ts_x");
    // A project's environment cannot point saved tokens at another server.
    expect(loadState({ home, env: { ...env(), TOOLSTILE_URL: "https://evil.example" } }).server).toBe(
      "https://toolstile.com",
    );
  });

  it("accepts only https servers, or http on loopback", () => {
    expect(normalizeServer("https://toolstile.com/app")).toBe("https://toolstile.com");
    expect(normalizeServer("http://localhost:4311")).toBe("http://localhost:4311");
    expect(() => normalizeServer("http://toolstile.com")).toThrow(/https/);
  });
});

function fakeApi(overrides: Partial<Api> = {}) {
  const calls: string[] = [];
  let next = 0;
  const agents = new Map<string, string>();
  const api: Api = {
    deviceCode: async () => ({
      device_code: "dc",
      user_code: "ABCDEFGH",
      verification_uri: "https://t.test/device",
      verification_uri_complete: "https://t.test/device?user_code=ABCDEFGH",
      expires_in: 600,
      interval: 5,
    }),
    deviceToken: async () => ({ access_token: "session", expires_in: 1 }),
    account: async () => ({
      email: "me@test.invalid",
      name: "Me",
      expiresAt: "2030-01-01T00:00:00.000Z",
      workspaces: [{ id: "w1", slug: "personal", name: "Personal", personal: true }],
    }),
    signOut: async () => {
      calls.push("signOut");
    },
    device: async (_t, input) => {
      calls.push(`device:${input.label}`);
      return { id: input.id ?? "d1", label: input.label };
    },
    agents: async () => ({ agents: [...agents].map(([id, label]) => ({ id, label })) }),
    addAgent: async (_t, input) => {
      const id = `a${++next}`;
      agents.set(id, input.label);
      calls.push(`add:${input.label}`);
      return { id, label: input.label, token: `ts_${id}` };
    },
    removeAgent: async (_t, _w, id) => {
      if (!agents.delete(id)) throw new ApiError(404, "Agent not found");
      calls.push(`remove:${id}`);
    },
    ...overrides,
  };
  return { api, calls, agents };
}

function context(api: Api) {
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => {
    text += chunk;
  });
  const ctx: Context = {
    home,
    platform: "linux",
    env: env(),
    version: "0.2.0",
    api: () => api,
    stdin: new PassThrough(),
    stdout: out,
    stderr: new PassThrough(),
    style: style(false),
    sleep: async () => {},
    openBrowser: () => {},
  };
  return { ctx, output: () => text };
}

describe("auth and setup", () => {
  it("polls until the code is approved, backing off when asked to", async () => {
    const answers = ["authorization_pending", "slow_down"];
    const { api } = fakeApi({
      deviceToken: async () => {
        const code = answers.shift();
        if (code) throw new ApiError(400, code, code);
        return { access_token: "session", expires_in: 1 };
      },
    });
    const { ctx, output } = context(api);
    expect(await login(ctx, { browser: false })).toBe(0);
    // Only the bare page: the code is typed there, never carried in the link.
    expect(output()).toContain("https://t.test/device\n");
    expect(output()).not.toContain("user_code=");
    expect(output()).toContain("ABCD-EFGH");
    expect(loadState({ home, env: env() }).session).toMatchObject({ token: "session", email: "me@test.invalid" });
  });

  it("reports a denied code", async () => {
    const { api } = fakeApi({
      deviceToken: async () => {
        throw new ApiError(400, "denied", "access_denied");
      },
    });
    await expect(login(context(api).ctx, { browser: false })).rejects.toThrow(/denied/);
  });

  it("enables and disables agents, registering each under one device", async () => {
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const { api, calls } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    expect(await setup(ctx, { enable: "cursor,codex", deviceName: "box" })).toBe(0);
    let state = loadState({ home, env: env() });
    expect(state.device).toEqual({ id: "d1", label: "box" });
    expect(Object.keys(state.agents).sort()).toEqual(["codex", "cursor"]);
    expect(readEntry(target("cursor"))).toMatchObject({ args: expect.arrayContaining(["cursor"]) });
    expect(calls).toEqual(["device:box", "add:Cursor", "add:Codex"]);

    expect(await setup(ctx, { disable: "cursor" })).toBe(0);
    state = loadState({ home, env: env() });
    expect(Object.keys(state.agents)).toEqual(["codex"]);
    expect(readEntry(target("cursor"))).toBeUndefined();
    expect(calls.at(-1)).toBe("remove:a1");

    expect(await logout(ctx)).toBe(0);
    expect(loadState({ home, env: env() }).session).toBeUndefined();
    await expect(setup(ctx, {})).rejects.toThrow(/auth login/);
  });

  it("keeps tokens on the server that issued them", async () => {
    mkdirSync(join(home, ".cursor"));
    const servers: string[] = [];
    const { api } = fakeApi();
    const { ctx } = context(api);
    ctx.api = (server) => {
      servers.push(server);
      return api;
    };
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    ctx.env = { ...ctx.env, TOOLSTILE_URL: "https://other.example" };
    await login(ctx, { browser: false });
    // The old session is signed out where it was issued; the new one belongs to the new server.
    expect(servers).toEqual(["https://toolstile.com", "https://toolstile.com", "https://other.example", "https://toolstile.com"]);
    const state = loadState({ home, env: ctx.env });
    expect(state.session?.server).toBe("https://other.example");
    expect(state.agents.cursor?.server).toBe("https://toolstile.com");
  });

  it("re-creates an agent that was deleted from the dashboard", async () => {
    mkdirSync(join(home, ".cursor"));
    const { api, agents, calls } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    agents.clear();
    await setup(ctx, { enable: "cursor" });
    expect(calls.filter((c) => c.startsWith("add:"))).toEqual(["add:Cursor", "add:Cursor"]);
    expect(loadState({ home, env: env() }).agents.cursor?.token).toBe("ts_a2");
  });
});

describe("stdio proxy", () => {
  async function run(responses: ((init: RequestInit) => Response)[], lines: string[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: unknown[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) written.push(JSON.parse(line));
    });
    const requests: RequestInit[] = [];
    const logs: string[] = [];
    const done = runProxy({
      endpoint: "https://t.test/mcp",
      token: "ts_agent",
      input,
      output,
      log: (m) => logs.push(m),
      fetch: async (_url, init) => {
        // The server-initiated stream is optional; these tests use none.
        if (init?.method === "GET") return new Response(null, { status: 405 });
        requests.push(init ?? {});
        const next = responses.shift();
        return next ? next(init ?? {}) : new Response(null, { status: 405 });
      },
    });
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    await done;
    return { written, requests, logs };
  }

  it("forwards JSON and SSE responses and keeps the session", async () => {
    const { written, requests } = await run(
      [
        () =>
          Response.json(
            { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
            { headers: { "Mcp-Session-Id": "s1" } },
          ),
        () =>
          new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n', {
            headers: { "Content-Type": "text/event-stream" },
          }),
      ],
      [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ],
    );
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    const headers = requests[1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ts_agent");
    expect(headers["Mcp-Session-Id"]).toBe("s1");
    expect(headers["Mcp-Protocol-Version"]).toBe("2025-06-18");
    expect(requests.at(-1)!.method).toBe("DELETE");
  });

  it("opens a new session when the gateway has forgotten the old one", async () => {
    const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const { written, requests } = await run(
      [
        () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "Mcp-Session-Id": "s1" } }),
        () => new Response("Session not found", { status: 404 }),
        () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }, { headers: { "Mcp-Session-Id": "s2" } }),
        () => new Response(null, { status: 202 }),
        () => Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
      ],
      [init, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })],
    );
    // The replayed initialize reply is not shown to the agent a second time.
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    expect((requests[4]!.headers as Record<string, string>)["Mcp-Session-Id"]).toBe("s2");
    expect(requests.every((r) => r.redirect === "error")).toBe(true);
  });

  it("answers a request whose stream ended without a reply", async () => {
    const { written } = await run(
      [() => new Response("event: message\n\n", { headers: { "Content-Type": "text/event-stream" } })],
      [JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call" })],
    );
    expect(written).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: -32000, message: expect.any(String) } }]);
  });

  it("answers requests with an error the agent can show when access is revoked", async () => {
    const { written, logs } = await run(
      [() => new Response("Agent token invalid or expired", { status: 401 })],
      [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })],
    );
    expect(written).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: -32000, message: expect.stringMatching(/toolstile mcp setup/) } },
    ]);
    expect(logs[0]).toMatch(/toolstile mcp setup/);
  });
});
