import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readEntry, targets } from "../src/agents.js";
import { createApi } from "../src/api.js";
import { type Context, login, logout, normalizeServer, proxy, setup, status, whoami } from "../src/commands.js";
import { style } from "../src/report.js";
import { chooseServer, DEFAULT_LOCAL_SERVER, localDataDir, localServer } from "../src/servers.js";
import { loadState, saveState, statePath } from "../src/state.js";

const CLOUD = "https://app.toolstile.com";
const LOCAL = "http://127.0.0.1:4310";
const SECRET = "FAKE-SECRET-do-not-print";

let home: string;
const env = (extra: Record<string, string> = {}) => ({ TOOLSTILE_CONFIG_DIR: join(home, "cfg"), ...extra });
const opts = () => ({ home, env: env() });
const target = (client: string) => targets({ home, platform: "linux", env: {} }).find((t) => t.client === client)!;

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-targets-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Recorded {
  method: string;
  url: URL;
  body: Record<string, unknown> | undefined;
  auth: string | undefined;
}

/**
 * A Toolstile server that follows the CLI contract. Self-hosted servers reject any `workspaceId`;
 * Cloud servers require one. `edition: undefined` is a Cloud server from before the field existed.
 */
function fakeServer(origin: string, options: { edition?: "cloud" | "self-hosted"; email?: string; mcpUrl?: string } = {}) {
  const selfHosted = options.edition === "self-hosted";
  const requests: Recorded[] = [];
  const agents = new Map<string, string>();
  const host = new URL(origin).host;
  let issued = 0;
  let next = 0;
  let session = "";
  const handle = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ method, url, body, auth });
    const path = url.pathname;
    const page = selfHosted ? "/auth/device" : "/device";
    if (path === "/api/auth/device/code")
      return Response.json({
        device_code: "dc",
        user_code: "ABCDEFGH",
        verification_uri: `${origin}${page}`,
        verification_uri_complete: `${origin}${page}?user_code=ABCDEFGH`,
        expires_in: 600,
        interval: 1,
      });
    if (path === "/api/auth/device/token") {
      session = `session-${host}-${++issued}`;
      return Response.json({ access_token: session, expires_in: 3600 });
    }
    if (!session || auth !== `Bearer ${session}`) return Response.json({ message: "Unauthorized" }, { status: 401 });
    const workspaceId = url.searchParams.get("workspaceId") ?? body?.workspaceId;
    if (path.startsWith("/api/cli/") && path !== "/api/cli/account" && path !== "/api/cli/sign-out") {
      if (selfHosted && workspaceId !== undefined && workspaceId !== null)
        return Response.json({ message: "No workspaces here" }, { status: 400 });
      if (!selfHosted && workspaceId !== "w1") return Response.json({ message: "workspaceId required" }, { status: 400 });
    }
    if (path === "/api/cli/account")
      return Response.json({
        email: options.email ?? `me@${host}`,
        name: "Me",
        expiresAt: "2030-01-01T00:00:00.000Z",
        ...(options.edition ? { edition: options.edition } : {}),
        ...(options.mcpUrl ? { mcpUrl: options.mcpUrl } : {}),
        workspaces: selfHosted ? [] : [{ id: "w1", slug: "personal", name: "Personal", personal: true }],
      });
    if (path === "/api/cli/sign-out") {
      session = "";
      return new Response(null, { status: 204 });
    }
    if (path === "/api/cli/device") return Response.json({ id: body?.id ?? `device-${host}`, label: body?.label });
    if (path === "/api/cli/agents" && method === "GET")
      return Response.json({ agents: [...agents].map(([id, label]) => ({ id, label })) });
    if (path === "/api/cli/agents" && method === "POST") {
      const id = `agent-${++next}`;
      agents.set(id, String(body?.label));
      return Response.json({ id, label: body?.label, token: `token-${host}-${id}` });
    }
    if (path.startsWith("/api/cli/agents/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/cli/agents/".length));
      return agents.delete(id) ? new Response(null, { status: 204 }) : Response.json({ message: "Not found" }, { status: 404 });
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  };
  return { origin, requests, agents, handle, session: () => session };
}

type Fake = ReturnType<typeof fakeServer>;

/** Routes requests to the fake servers by origin; any other address is unreachable. */
function network(...servers: Fake[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const server = servers.find((s) => s.origin === url.origin);
    if (!server) throw new TypeError("fetch failed");
    return server.handle(url, init ?? {});
  }) as typeof fetch;
}

function context(fetcher: typeof fetch, extraEnv: Record<string, string> = {}) {
  let out = "";
  let err = "";
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (chunk) => (out += chunk));
  stderr.on("data", (chunk) => (err += chunk));
  const ctx: Context = {
    home,
    platform: "linux",
    env: env(extraEnv),
    version: "0.2.0",
    api: (server) => createApi(server, fetcher),
    stdin: new PassThrough(),
    stdout,
    stderr,
    style: style(false),
    sleep: async () => {},
    hostname: () => "box",
    openBrowser: () => {},
  };
  return { ctx, output: () => out, errors: () => err };
}

/** A terminal on both ends, so setup prompts. */
function terminal(ctx: Context) {
  ctx.stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode() {} });
  const stdout = ctx.stdout as PassThrough;
  ctx.stdout = Object.assign(stdout, { isTTY: true, columns: 120, rows: 40 });
  return ctx.stdin as PassThrough;
}

const signOuts = (server: Fake) => server.requests.filter((r) => r.url.pathname === "/api/cli/sign-out").map((r) => r.auth);
const codes = (server: Fake) => server.requests.filter((r) => r.url.pathname === "/api/auth/device/code").length;

describe("state file migration", () => {
  /** What 0.7.1 and earlier wrote: one sign-in at the top level. */
  const previous = {
    server: CLOUD,
    session: { token: "saved-session", email: "me@test.invalid", expiresAt: "2030-01-01T00:00:00.000Z", server: CLOUD },
    workspace: { id: "w1", slug: "personal", name: "Personal" },
    device: { id: "saved-device", label: "Studio" },
    agents: {
      cursor: {
        id: "agent-old",
        workspaceId: "w1",
        server: CLOUD,
        endpoint: "https://mcp.toolstile.com/mcp",
        label: "Cursor",
        token: "agent-token",
      },
    },
  };

  it("keeps the sign-in, device and agent links from the single sign-in format", () => {
    put(statePath(opts()), JSON.stringify(previous));
    chmodSync(statePath(opts()), 0o600);
    const state = loadState(opts());
    expect(state).toEqual({
      version: 2,
      current: CLOUD,
      servers: {
        [CLOUD]: {
          session: { token: "saved-session", email: "me@test.invalid", expiresAt: "2030-01-01T00:00:00.000Z" },
          workspace: previous.workspace,
          device: previous.device,
        },
      },
      agents: previous.agents,
    });
  });

  it("rewrites the file in place on the next save, owner-only and readable by older proxies", async () => {
    put(statePath(opts()), JSON.stringify(previous));
    chmodSync(statePath(opts()), 0o600);
    mkdirSync(join(home, ".codex"));
    const cloud = fakeServer(CLOUD, { mcpUrl: "https://mcp.toolstile.com/mcp" });
    // The saved session is still valid on the server.
    await cloud.handle(new URL(`${CLOUD}/api/auth/device/token`), { method: "POST" });
    const state = loadState(opts());
    state.servers[CLOUD]!.session!.token = cloud.session();
    saveState(state, opts());
    cloud.agents.set("agent-old", "Cursor");
    const { ctx } = context(network(cloud));
    expect(await setup(ctx, { enable: "codex" })).toBe(0);
    // No new sign-in; the saved device and workspace were used.
    expect(codes(cloud)).toBe(0);
    const device = cloud.requests.find((r) => r.url.pathname === "/api/cli/device");
    expect(device?.body).toMatchObject({ id: "saved-device", workspaceId: "w1" });

    const text = readFileSync(statePath(opts()), "utf8");
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["agents", "current", "servers", "version"]);
    expect(statSync(statePath(opts())).mode & 0o777).toBe(0o600);
    // An agent config pinned to an older CLI reads `agents.<client>` and nothing else.
    expect((file.agents as Record<string, unknown>).cursor).toEqual(previous.agents.cursor);
    expect((file.agents as Record<string, { server: string }>).codex?.server).toBe(CLOUD);
  });

  it("folds in a sign-in an older release wrote next to the new format", () => {
    put(
      statePath(opts()),
      JSON.stringify({
        version: 2,
        current: LOCAL,
        servers: { [LOCAL]: { edition: "self-hosted", session: { token: "l", email: "l@x", expiresAt: "2030" } } },
        agents: {},
        server: CLOUD,
        session: { token: "newer", email: "me@test.invalid", expiresAt: "2031", server: CLOUD },
      }),
    );
    const state = loadState(opts());
    expect(state.current).toBe(CLOUD);
    expect(state.servers[CLOUD]?.session?.token).toBe("newer");
    expect(state.servers[LOCAL]?.session?.token).toBe("l");
  });

  it("drops server keys that are not HTTPS or loopback origins", () => {
    put(
      statePath(opts()),
      JSON.stringify({ version: 2, current: "http://evil.example", servers: { "http://evil.example": {}, x: {} }, agents: {} }),
    );
    const state = loadState(opts());
    expect(state.current).toBe(CLOUD);
    expect(state.servers).toEqual({});
  });
});

describe("server selection", () => {
  const pick = (choice: { server?: string; local?: boolean }, extra: Record<string, string> = {}, current = CLOUD) =>
    chooseServer({ home, env: { ...extra }, current }, choice);

  it("uses the flag, then TOOLSTILE_SERVER, then TOOLSTILE_URL, then the current server", () => {
    const vars = { TOOLSTILE_SERVER: "https://env.example", TOOLSTILE_URL: "https://alias.example" };
    expect(pick({ server: "https://flag.example/x" }, vars)).toBe("https://flag.example");
    expect(pick({ local: true }, vars)).toBe(DEFAULT_LOCAL_SERVER);
    expect(pick({}, vars)).toBe("https://env.example");
    expect(pick({}, { TOOLSTILE_URL: "https://alias.example" })).toBe("https://alias.example");
    expect(pick({}, {}, "https://current.example")).toBe("https://current.example");
    expect(() => pick({ server: CLOUD, local: true })).toThrow("Use either --server or --local, not both.");
    expect(() => pick({}, { TOOLSTILE_SERVER: "http://env.example" })).toThrow(/^TOOLSTILE_SERVER must use https:\/\//);
  });

  it("accepts plain http only for loopback hosts", () => {
    for (const ok of ["http://localhost:4310", "http://127.0.0.1:4310", "http://127.8.9.10", "http://[::1]:4310", "http://127.1"])
      expect(normalizeServer(ok), ok).toMatch(/^http:\/\/(localhost|127\.|\[::1\])/);
    for (const bad of [
      "http://192.168.1.20:4310",
      "http://10.0.0.1",
      "http://toolstile.local",
      "http://localhost.evil.test",
      "http://127.0.0.1.nip.io",
      "http://[::ffff:127.0.0.1]",
      "http://0.0.0.0:4310",
    ])
      expect(() => normalizeServer(bad), bad).toThrow(/https:\/\//);
    expect(() => normalizeServer("https://user:pass@app.toolstile.com")).toThrow(/user name or password/);
    expect(() => normalizeServer("ftp://app.toolstile.com")).toThrow(/https/);
  });

  it("keeps one sign-in per server and makes the latest one current", async () => {
    const cloud = fakeServer(CLOUD);
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx } = context(network(cloud, local));
    await login(ctx, { browser: false });
    await login(ctx, { browser: false, local: true });
    let state = loadState(opts());
    expect(state.current).toBe(LOCAL);
    expect(Object.keys(state.servers).sort()).toEqual([LOCAL, CLOUD].sort());
    expect(state.servers[CLOUD]).toMatchObject({ edition: "cloud", session: { email: "me@app.toolstile.com" } });
    expect(state.servers[LOCAL]).toMatchObject({ edition: "self-hosted", session: { email: "me@127.0.0.1:4310" } });
    // Signing in to the local server did not end the Cloud session.
    expect(signOuts(cloud)).toEqual([]);

    // Signing in to the same server again replaces only that server's session.
    await login(ctx, { browser: false, server: CLOUD });
    state = loadState(opts());
    expect(state.current).toBe(CLOUD);
    expect(signOuts(cloud)).toEqual(["Bearer session-app.toolstile.com-1"]);
    expect(state.servers[LOCAL]?.session?.token).toBe("session-127.0.0.1:4310-1");
  });

  it("lets TOOLSTILE_SERVER pick a saved sign-in, and --server win over it", async () => {
    const cloud = fakeServer(CLOUD);
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx, output } = context(network(cloud, local));
    await login(ctx, { browser: false, local: true });
    await login(ctx, { browser: false, server: CLOUD });
    expect(loadState(opts()).current).toBe(CLOUD);
    ctx.env = env({ TOOLSTILE_SERVER: LOCAL });
    expect(whoami(ctx, {})).toBe(0);
    expect(output()).toContain("me@127.0.0.1:4310 on http://127.0.0.1:4310 (self-hosted), expires 2030-01-01T00:00:00.000Z");
    expect(whoami(ctx, { server: CLOUD })).toBe(0);
    expect(output()).toContain("me@app.toolstile.com on https://app.toolstile.com (cloud)");
    // The alias still works.
    ctx.env = env({ TOOLSTILE_URL: LOCAL });
    expect(whoami(ctx, { json: true })).toBe(0);
    expect(JSON.parse(output().slice(output().lastIndexOf("{\n")))).toEqual({
      signedIn: true,
      server: LOCAL,
      edition: "self-hosted",
      email: "me@127.0.0.1:4310",
      expiresAt: "2030-01-01T00:00:00.000Z",
      expired: false,
    });
  });
});

describe("--local", () => {
  const instance = (data: unknown) => {
    const dir = join(home, "data");
    put(join(dir, "instance.json"), typeof data === "string" ? data : JSON.stringify(data));
    return { TOOLSTILE_DATA_DIR: dir };
  };

  it("defaults to 127.0.0.1:4310 and ~/.local/share/toolstile", () => {
    expect(localDataDir({ home, env: {} })).toBe(join(home, ".local", "share", "toolstile"));
    expect(localServer({ home, env: {} })).toBe(DEFAULT_LOCAL_SERVER);
    put(join(home, ".local", "share", "toolstile", "instance.json"), JSON.stringify({ origin: "http://127.0.0.1:4555" }));
    expect(localServer({ home, env: {} })).toBe("http://127.0.0.1:4555");
  });

  it("signs in to the origin in instance.json without reading its secrets into output or credentials", async () => {
    const dataEnv = instance({
      version: 1,
      origin: "http://localhost:4399",
      host: "127.0.0.1",
      port: 4399,
      authSecret: SECRET,
      encryptionKey: `${SECRET}-key`,
    });
    const local = fakeServer("http://localhost:4399", { edition: "self-hosted" });
    const { ctx, output, errors } = context(network(local), dataEnv);
    expect(await login(ctx, { browser: false, local: true })).toBe(0);
    expect(output()).toContain("http://localhost:4399/auth/device?user_code=ABCDEFGH&device_name=box");
    expect(status(ctx, { json: true })).toBe(0);
    const credentials = readFileSync(statePath(opts()), "utf8");
    for (const text of [output(), errors(), credentials]) expect(text).not.toContain(SECRET);
    expect(loadState(opts()).current).toBe("http://localhost:4399");
  });

  it("reports a broken instance.json without quoting it", () => {
    for (const data of [`{"authSecret": "${SECRET}",`, { origin: `http://192.168.1.5:4310/${SECRET}`, authSecret: SECRET }, { origin: 42 }]) {
      const dataEnv = instance(data);
      let message = "";
      try {
        localServer({ home, env: dataEnv });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/instance\.json (is not valid JSON|has no valid origin)\. Use --server <url> instead of --local\.$/);
      expect(message).not.toContain(SECRET);
    }
  });

  it("works from the command line, and never prints the instance's secrets", () => {
    const dataEnv = instance({ origin: "http://127.0.0.1:9", authSecret: SECRET });
    const cli = join(import.meta.dirname, "..", "dist", "cli.js");
    const { TOOLSTILE_URL: _, TOOLSTILE_SERVER: __, ...inherited } = process.env;
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, ...args], { env: { ...inherited, ...env(dataEnv), HOME: home }, encoding: "utf8" });
    const setupRun = run("mcp", "setup", "--local", "--enable", "cursor", "--no-browser");
    expect(setupRun.status).toBe(1);
    expect(setupRun.stderr).toContain("Could not reach http://127.0.0.1:9");
    const loginRun = run("auth", "login", "--local", "--no-browser");
    expect(loginRun.stderr).toContain("Could not reach http://127.0.0.1:9");
    for (const result of [setupRun, loginRun]) expect(result.stdout + result.stderr).not.toContain(SECRET);
    expect(run("auth", "login", "--local", "--server", CLOUD).stderr).toContain("Use either --server or --local, not both.");
    expect(run("auth", "logout", "--all", "--local").stderr).toContain("--all signs out of every server");
    const who = run("whoami", "--json");
    expect(who.status).toBe(1);
    expect(JSON.parse(who.stdout)).toEqual({ signedIn: false, server: CLOUD });
    expect(run("auth", "status").stdout).toContain(`Not signed in. Current server: ${CLOUD}`);
    expect(run("auth", "--help").stdout).toContain("--local");
    expect(run("mcp", "setup", "--help").stdout).toContain("--switch");
  });
});

describe("editions", () => {
  it("sends no workspaceId to a self-hosted server and asks for no workspace", async () => {
    mkdirSync(join(home, ".cursor"));
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx, output } = context(network(local));
    expect(await setup(ctx, { local: true, enable: "cursor" })).toBe(0);
    expect(output()).toContain(`${LOCAL}/auth/device?user_code=ABCDEFGH&device_name=box&next=setup`);
    expect(output()).toContain(`Choose which MCP servers they can use in the dashboard at ${LOCAL}`);
    const link = loadState(opts()).agents.cursor!;
    expect(link).toEqual({
      id: "agent-1",
      server: LOCAL,
      endpoint: `${LOCAL}/mcp`,
      label: "Cursor",
      token: "token-127.0.0.1:4310-agent-1",
    });
    expect(loadState(opts()).servers[LOCAL]).not.toHaveProperty("workspace");
    expect(await setup(ctx, { local: true, disable: "cursor" })).toBe(0);
    expect(local.agents.size).toBe(0);
    const cli = local.requests.filter((r) => r.url.pathname.startsWith("/api/cli/") && r.url.pathname !== "/api/cli/account");
    expect(cli.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/cli/device",
      "POST /api/cli/agents",
      "GET /api/cli/agents",
      "DELETE /api/cli/agents/agent-1",
    ]);
    for (const request of cli) {
      expect(request.url.search, request.url.href).not.toContain("workspaceId");
      expect(request.body ?? {}).not.toHaveProperty("workspaceId");
    }
  });

  it("treats a server that reports no edition as Toolstile Cloud", async () => {
    mkdirSync(join(home, ".cursor"));
    const cloud = fakeServer(CLOUD);
    const { ctx, output } = context(network(cloud));
    expect(await setup(ctx, { enable: "cursor" })).toBe(0);
    expect(loadState(opts()).servers[CLOUD]).toMatchObject({ edition: "cloud", workspace: { id: "w1" } });
    expect(loadState(opts()).agents.cursor?.workspaceId).toBe("w1");
    expect(cloud.requests.find((r) => r.method === "POST" && r.url.pathname === "/api/cli/agents")?.body).toMatchObject({
      workspaceId: "w1",
    });
    expect(output()).toContain(`Choose which MCP servers they can use: ${CLOUD}/personal/access`);
    status(ctx, {});
    expect(output()).toContain("* me@app.toolstile.com on https://app.toolstile.com (cloud)");
  });

  it("keeps a self-hosted gateway on the server's own origin, and Cloud's on its own host", async () => {
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const local = fakeServer(LOCAL, { edition: "self-hosted", mcpUrl: "https://elsewhere.example/mcp" });
    const cloud = fakeServer(CLOUD, { edition: "cloud", mcpUrl: "https://mcp.toolstile.com/mcp" });
    const { ctx } = context(network(local, cloud));
    expect(await setup(ctx, { local: true, enable: "cursor" })).toBe(0);
    expect(loadState(opts()).agents.cursor?.endpoint).toBe(`${LOCAL}/mcp`);
    expect(await setup(ctx, { server: CLOUD, enable: "codex" })).toBe(0);
    expect(loadState(opts()).agents.codex?.endpoint).toBe("https://mcp.toolstile.com/mcp");
  });

  it("rejects --workspace on a self-hosted server", async () => {
    mkdirSync(join(home, ".cursor"));
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx } = context(network(local));
    const message = `--workspace only applies to Toolstile Cloud; ${LOCAL} is a self-hosted server and has no workspaces.`;
    // First sign-in: the edition is only known once the server answers, and nothing is set up.
    await expect(setup(ctx, { local: true, enable: "cursor", workspace: "personal" })).rejects.toThrow(message);
    expect(local.agents.size).toBe(0);
    expect(loadState(opts()).agents).toEqual({});
    // Afterwards the saved edition rejects it before any request.
    const before = local.requests.length;
    await expect(setup(ctx, { local: true, enable: "cursor", workspace: "personal" })).rejects.toThrow(message);
    expect(local.requests.length).toBe(before);
    expect(message).not.toContain("\n");
  });
});

describe("logout", () => {
  async function signedInTwice() {
    const cloud = fakeServer(CLOUD);
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx, output } = context(network(cloud, local));
    await login(ctx, { browser: false });
    await login(ctx, { browser: false, local: true });
    return { cloud, local, ctx, output };
  }

  it("signs out of the current server only", async () => {
    const { cloud, local, ctx, output } = await signedInTwice();
    expect(await logout(ctx)).toBe(0);
    expect(output()).toContain(`Signed out of ${LOCAL}.`);
    expect(signOuts(local)).toEqual(["Bearer session-127.0.0.1:4310-1"]);
    expect(signOuts(cloud)).toEqual([]);
    const state = loadState(opts());
    expect(state.servers[LOCAL]?.session).toBeUndefined();
    expect(state.servers[CLOUD]?.session).toBeDefined();
    expect(await logout(ctx)).toBe(0);
    expect(output()).toContain(`Not signed in to ${LOCAL}.`);
  });

  it("signs out of the server named by --server or --local", async () => {
    const { cloud, local, ctx } = await signedInTwice();
    expect(await logout(ctx, { server: CLOUD })).toBe(0);
    expect(signOuts(cloud)).toHaveLength(1);
    expect(loadState(opts()).servers[LOCAL]?.session).toBeDefined();
    ctx.env = env({ TOOLSTILE_SERVER: CLOUD });
    expect(await logout(ctx, { local: true })).toBe(0);
    expect(signOuts(local)).toHaveLength(1);
  });

  it("signs out everywhere with --all, each session at its own server", async () => {
    const { cloud, local, ctx, output } = await signedInTwice();
    mkdirSync(join(home, "cfg"), { recursive: true });
    expect(await logout(ctx, { all: true })).toBe(0);
    expect(signOuts(cloud)).toEqual(["Bearer session-app.toolstile.com-1"]);
    expect(signOuts(local)).toEqual(["Bearer session-127.0.0.1:4310-1"]);
    expect(output()).toContain(`Signed out of ${CLOUD}.`);
    expect(output()).toContain(`Signed out of ${LOCAL}.`);
    expect(Object.values(loadState(opts()).servers).every((entry) => !entry.session)).toBe(true);
    expect(await logout(ctx, { all: true })).toBe(0);
    expect(output()).toContain("Not signed in.");
    await expect(logout(ctx, { all: true, server: CLOUD })).rejects.toThrow("--all");
  });

  it("names the server in the sign-in hint when it is not the one plain auth login would use", async () => {
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx, output } = context(network(local));
    await login(ctx, { browser: false, local: true });
    expect(whoami(ctx, { server: CLOUD })).toBe(1);
    expect(output()).toContain(`Not signed in to ${CLOUD}. Sign in with toolstile auth login --server ${CLOUD}`);
  });

  it("quotes an IPv6 origin in the hint and ignores an invalid TOOLSTILE_SERVER when --server is given", () => {
    const { ctx, output } = context(network(), { TOOLSTILE_SERVER: "not a url" });
    expect(whoami(ctx, { server: "http://[::1]:4310" })).toBe(1);
    expect(output()).toContain("Sign in with toolstile auth login --server 'http://[::1]:4310'");
    expect(whoami(ctx, { server: "https://o'brien.example" })).toBe(1);
    expect(output()).toContain(`Sign in with toolstile auth login --server 'https://o'\\''brien.example'`);
    ctx.platform = "win32";
    expect(whoami(ctx, { server: "http://[::1]:4310" })).toBe(1);
    expect(output()).toContain(`Sign in with toolstile auth login --server "http://[::1]:4310"`);
    expect(whoami(ctx, { server: "https://a$b.example" })).toBe(1);
    expect(output()).toContain("Sign in with toolstile auth login --server <address>, with https://a$b.example as the address");
    expect(whoami(ctx, { server: CLOUD, json: true })).toBe(1);
    expect(output()).toContain('"signedIn": false');
  });

  it("lists sign-ins in auth status", async () => {
    const { ctx, output } = await signedInTwice();
    expect(status(ctx, { json: true })).toBe(0);
    expect(JSON.parse(output().slice(output().lastIndexOf("{\n  \"current\"")))).toEqual({
      current: LOCAL,
      signIns: [
        { server: CLOUD, edition: "cloud", email: "me@app.toolstile.com", expiresAt: "2030-01-01T00:00:00.000Z", expired: false, current: false },
        { server: LOCAL, edition: "self-hosted", email: "me@127.0.0.1:4310", expiresAt: "2030-01-01T00:00:00.000Z", expired: false, current: true },
      ],
    });
    ctx.now = () => Date.parse("2031-01-01T00:00:00.000Z");
    expect(status(ctx, {})).toBe(0);
    expect(output()).toContain(`  me@app.toolstile.com on ${CLOUD} (cloud), expired 2030-01-01T00:00:00.000Z`);
    expect(output()).toContain(`* me@127.0.0.1:4310 on ${LOCAL} (self-hosted), expired`);
    expect(whoami(ctx, {})).toBe(1);
  });
});

describe("agents on several servers", () => {
  async function cursorOnCloud(options: { local?: boolean } = {}) {
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const cloud = fakeServer(CLOUD);
    const local = fakeServer(LOCAL, { edition: "self-hosted" });
    const { ctx, output } = context(network(cloud, local));
    await setup(ctx, { enable: "cursor" });
    if (options.local) await login(ctx, { browser: false, local: true });
    return { cloud, local, ctx, output };
  }

  it("lets agents use different servers side by side", async () => {
    const { cloud, local, ctx } = await cursorOnCloud();
    expect(await setup(ctx, { local: true, enable: "codex" })).toBe(0);
    const { agents } = loadState(opts());
    expect(agents.cursor?.server).toBe(CLOUD);
    expect(agents.codex?.server).toBe(LOCAL);
    expect(readEntry(target("cursor"))).toBeDefined();
    expect(cloud.agents.size).toBe(1);
    expect(local.agents.size).toBe(1);
    // Setup on the local server leaves the Cloud agent alone, even when it is not selected.
    expect(await setup(ctx, { local: true, disable: "codex" })).toBe(0);
    expect(loadState(opts()).agents.cursor?.server).toBe(CLOUD);
    expect(cloud.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("needs --switch to move an agent to another server without a terminal", async () => {
    const { cloud, local, ctx } = await cursorOnCloud({ local: true });
    const before = local.requests.length;
    await expect(setup(ctx, { local: true, enable: "cursor" })).rejects.toThrow(
      `Cursor uses ${CLOUD}. Add --switch to move it to ${LOCAL}.`,
    );
    expect(local.requests.length).toBe(before);
    expect(loadState(opts()).agents.cursor?.server).toBe(CLOUD);

    expect(await setup(ctx, { local: true, enable: "cursor", switch: true })).toBe(0);
    const link = loadState(opts()).agents.cursor!;
    expect(link.server).toBe(LOCAL);
    expect(link.workspaceId).toBeUndefined();
    // The Cloud authorization was removed with the Cloud sign-in.
    const removal = cloud.requests.find((r) => r.method === "DELETE");
    expect(removal?.auth).toBe(`Bearer ${cloud.session()}`);
    expect(removal?.url.searchParams.get("workspaceId")).toBe("w1");
    expect(cloud.agents.size).toBe(0);
  });

  it("asks before moving an agent when there is a terminal", async () => {
    const { local, ctx, output } = await cursorOnCloud({ local: true });
    const keys = terminal(ctx);
    const answer = async (...input: string[]) => {
      await vi.waitFor(() => expect(output()).toContain(`Cursor uses ${CLOUD}. Switch it to ${LOCAL}?`));
      for (const key of input) keys.write(key);
    };
    let run = setup(ctx, { local: true, enable: "cursor" });
    await answer("\r");
    expect(await run).toBe(0);
    expect(loadState(opts()).agents.cursor?.server).toBe(CLOUD);
    expect(local.agents.size).toBe(0);

    (ctx.stdout as PassThrough).write("\n---\n");
    run = setup(ctx, { local: true, enable: "cursor" });
    await vi.waitFor(() => expect(output().split("---").at(-1)).toContain("Switch it to"));
    keys.write("j");
    keys.write("\r");
    expect(await run).toBe(0);
    expect(loadState(opts()).agents.cursor?.server).toBe(LOCAL);
  });

  it("turns off an agent on another server with --disable, revoking it there", async () => {
    const { cloud, ctx } = await cursorOnCloud({ local: true });
    expect(await setup(ctx, { local: true, disable: "cursor" })).toBe(0);
    expect(loadState(opts()).agents.cursor).toBeUndefined();
    expect(readEntry(target("cursor"))).toBeUndefined();
    expect(cloud.agents.size).toBe(0);
  });

  it("reports an old authorization it could not remove because that server is unreachable", async () => {
    const { local, ctx, cloud } = await cursorOnCloud({ local: true });
    const { ctx: offline, errors } = context(network(local));
    expect(await setup({ ...ctx, api: offline.api, stderr: offline.stderr }, { local: true, enable: "cursor", switch: true })).toBe(0);
    expect(loadState(opts()).agents.cursor?.server).toBe(LOCAL);
    expect(cloud.agents.size).toBe(1);
    expect(errors()).toContain(`Could not confirm removal of the old Cursor authorization (agent-1) at ${CLOUD}.`);
  });

  it("warns when the old server refuses the removal during a switch", async () => {
    const { local, ctx, cloud } = await cursorOnCloud({ local: true });
    const refusing = network(local, cloud);
    const { ctx: other, errors } = context(((input: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE" && String(input).startsWith(CLOUD)
        ? Promise.resolve(Response.json({ message: "Forbidden" }, { status: 403 }))
        : refusing(input, init)) as typeof fetch);
    expect(await setup({ ...ctx, api: other.api, stderr: other.stderr }, { local: true, enable: "cursor", switch: true })).toBe(0);
    expect(cloud.agents.size).toBe(1);
    expect(errors()).toContain(`Could not confirm removal of the old Cursor authorization (agent-1) at ${CLOUD}.`);
  });

  it("says where to remove access it could not revoke", async () => {
    const { cloud, ctx, output } = await cursorOnCloud({ local: true });
    await logout(ctx, { server: CLOUD });
    expect(await setup(ctx, { local: true, enable: "cursor", switch: true })).toBe(0);
    expect(cloud.agents.size).toBe(1);
    expect(output()).toContain(`Cursor's access on ${CLOUD} was not removed because this machine is not signed in there.`);
  });
});

describe("proxy pinning", () => {
  function linked() {
    const state = loadState(opts());
    state.agents.cursor = { id: "a", workspaceId: "w1", server: CLOUD, endpoint: "https://mcp.toolstile.com/mcp", label: "Cursor", token: "cloud-token" };
    state.agents.codex = { id: "b", server: LOCAL, endpoint: `${LOCAL}/mcp`, label: "Codex", token: "local-token" };
    saveState(state, opts());
  }

  async function relay(ctx: Context, agent: string) {
    const input = new PassThrough();
    ctx.stdin = input;
    const done = proxy(ctx, agent);
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    return done;
  }

  it("sends each agent's token only to the server that issued it", async () => {
    linked();
    const seen: { url: string; auth: string | undefined; redirect: RequestRedirect | undefined }[] = [];
    // A project's environment and flags cannot move the proxy elsewhere.
    const { ctx } = context(network(), { TOOLSTILE_SERVER: "https://evil.example" });
    ctx.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization, redirect: init?.redirect });
      if (init?.method === "GET" || init?.method === "DELETE") return new Response(null, { status: 405 });
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    }) as typeof fetch;
    expect(await relay(ctx, "cursor")).toBe(0);
    expect(await relay(ctx, "codex")).toBe(0);
    const byToken = (token: string) => new Set(seen.filter((s) => s.auth === `Bearer ${token}`).map((s) => new URL(s.url).origin));
    expect(byToken("cloud-token")).toEqual(new Set(["https://mcp.toolstile.com"]));
    expect(byToken("local-token")).toEqual(new Set([LOCAL]));
    expect(seen.some((s) => s.url.includes("evil"))).toBe(false);
    expect(seen.every((s) => s.redirect === "error")).toBe(true);
  });

  it("does not follow a redirect to another server", async () => {
    const hits: { server: string; auth: string | undefined }[] = [];
    const other = createServer((request, response) => {
      hits.push({ server: "other", auth: request.headers.authorization });
      response.end();
    });
    other.listen(0, "127.0.0.1");
    await once(other, "listening");
    const otherPort = (other.address() as AddressInfo).port;
    const gateway = createServer((request, response) => {
      hits.push({ server: "gateway", auth: request.headers.authorization });
      response.writeHead(307, { location: `http://127.0.0.1:${otherPort}/mcp` }).end();
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const gatewayPort = (gateway.address() as AddressInfo).port;
    try {
      const state = loadState(opts());
      state.agents.cursor = { id: "a", server: `http://127.0.0.1:${gatewayPort}`, label: "Cursor", token: "pinned-token" };
      saveState(state, opts());
      const { ctx } = context(network());
      expect(await relay(ctx, "cursor")).toBe(0);
      expect(hits.filter((h) => h.server === "gateway").every((h) => h.auth === "Bearer pinned-token")).toBe(true);
      expect(hits.some((h) => h.server === "gateway")).toBe(true);
      expect(hits.filter((h) => h.server === "other")).toEqual([]);
    } finally {
      for (const server of [gateway, other]) {
        server.closeAllConnections();
        server.close();
      }
    }
  });

  it("refuses a saved gateway address that is not HTTPS or loopback", async () => {
    const state = loadState(opts());
    state.agents.cursor = { id: "a", server: CLOUD, endpoint: "http://gateway.example/mcp", label: "Cursor", token: "t" };
    saveState(state, opts());
    const { ctx } = context(network());
    await expect(proxy(ctx, "cursor")).rejects.toThrow("saved gateway address is not HTTPS");
  });
});
