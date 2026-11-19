import { spawnSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ManualEditError, proxyCommand, readEntry, targets, withoutTomlTable, writeEntry } from "../src/agents.js";
import { type Api, ApiError } from "../src/api.js";
import {
  browserCommand,
  type Context,
  gatewayUrl,
  login,
  logout,
  normalizeServer,
  setup,
  signInUrl,
} from "../src/commands.js";
import { audit } from "../src/index.js";
import { runProxy } from "../src/proxy.js";
import { style } from "../src/report.js";
import { loadState, saveState, statePath } from "../src/state.js";

let home: string;
const CLOUD = "https://app.toolstile.com";
const env = () => ({ TOOLSTILE_CONFIG_DIR: join(home, "cfg") });
const target = (client: string) => targets({ home, platform: "linux", env: {} }).find((t) => t.client === client)!;
const command = (client: Parameters<typeof proxyCommand>[0]) => proxyCommand(client, "0.2.0", "linux");
/** The saved entry for one server. */
const saved = (server = CLOUD) => loadState({ home, env: env() }).servers[server];

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-connect-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("agent config entries", () => {
  it("writes Devin Desktop's own user config, separate from legacy Windsurf", () => {
    const devin = target("devin");
    expect(devin.path).toBe(join(home, ".config", "devin", "mcp_config.json"));
    expect(devin.name).toBe("Devin Desktop");
    expect(devin.detected).toBe(false);
    mkdirSync(join(home, ".config", "devin"), { recursive: true });
    expect(target("devin").detected).toBe(true);
    expect(target("windsurf").detected).toBe(false);
    expect(writeEntry(target("devin"), command("devin"))).toBe("added");
    expect(JSON.parse(readFileSync(devin.path, "utf8")).mcpServers.toolstile).toEqual(command("devin"));
  });

  it("uses APPDATA for Devin Desktop on Windows", () => {
    const appdata = join(home, "Roaming");
    const devin = targets({ home, platform: "win32", env: { APPDATA: appdata } }).find((t) => t.client === "devin")!;
    expect(devin.path).toBe(join(appdata, "devin", "mcp_config.json"));
    expect(devin.detected).toBe(false);
    mkdirSync(join(appdata, "devin"), { recursive: true });
    expect(targets({ home, platform: "win32", env: { APPDATA: appdata } }).find((t) => t.client === "devin")!.detected).toBe(true);
  });

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
    put(cursor.path, JSON.stringify({ mcpServers: { toolstile: { url: "https://mcp.toolstile.com/mcp" } } }));
    expect(writeEntry(cursor, null)).toBe("unchanged");
    expect(readEntry(cursor)).toEqual({ url: "https://mcp.toolstile.com/mcp" });
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
    put(t.path, "[mcp_servers]\ntoolstile = { url = \"https://mcp.toolstile.com/mcp\" }\n");
    expect(() => writeEntry(t, command("codex"))).toThrow(ManualEditError);
  });

  it("starts npx through cmd on Windows", () => {
    expect(proxyCommand("cursor", "0.2.0", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "npx", "-y", "toolstile@0.2.0", "mcp", "proxy", "--agent", "cursor"],
    });
  });

  it("writes Grok Build's TOML like Codex's, keeping other tables", () => {
    const t = target("grok");
    expect(t.path).toBe(join(home, ".grok", "config.toml"));
    expect(t.name).toBe("Grok Build");
    expect(t.detected).toBe(false);
    const original = '[ui]\nvim_mode = true\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';
    put(t.path, original);
    expect(target("grok").detected).toBe(true);
    expect(writeEntry(t, command("grok"))).toBe("added");
    const text = readFileSync(t.path, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain('[mcp_servers.toolstile]\ncommand = "npx"\nargs = ["-y", "toolstile@0.2.0", "mcp", "proxy", "--agent", "grok"]');
    expect(writeEntry(t, command("grok"))).toBe("unchanged");
    expect(writeEntry(t, null)).toBe("removed");
    expect(readFileSync(t.path, "utf8")).toBe(original);
  });

  it("writes OpenCode's local server shape next to V1 and V2 servers", () => {
    const t = target("opencode");
    expect(t.path).toBe(join(home, ".config", "opencode", "opencode.json"));
    put(t.path, JSON.stringify({ theme: "x", mcp: { servers: { docs: { type: "remote", url: "https://d.example.com/mcp" } } } }));
    expect(writeEntry(t, command("opencode"))).toBe("added");
    const data = JSON.parse(readFileSync(t.path, "utf8"));
    expect(data.theme).toBe("x");
    expect(data.mcp.servers.docs).toEqual({ type: "remote", url: "https://d.example.com/mcp" });
    expect(data.mcp.toolstile).toEqual({
      type: "local",
      command: ["npx", "-y", "toolstile@0.2.0", "mcp", "proxy", "--agent", "opencode"],
    });
    expect(writeEntry(t, command("opencode"))).toBe("unchanged");
    expect(writeEntry(t, null)).toBe("removed");
    expect(JSON.parse(readFileSync(t.path, "utf8")).mcp).toEqual({ servers: { docs: { type: "remote", url: "https://d.example.com/mcp" } } });
  });

  it("uses an existing opencode.jsonc and XDG_CONFIG_HOME for OpenCode", () => {
    const config = join(home, "xdg");
    const find = () => targets({ home, platform: "linux", env: { XDG_CONFIG_HOME: config } }).find((t) => t.client === "opencode")!;
    expect(find().path).toBe(join(config, "opencode", "opencode.json"));
    expect(find().detected).toBe(false);
    put(join(config, "opencode", "opencode.jsonc"), '{\n  // mine\n  "theme": "x"\n}\n');
    expect(find().path).toBe(join(config, "opencode", "opencode.jsonc"));
    expect(find().detected).toBe(true);
    // A file with comments is left to the user, with the snippet to paste.
    expect(() => writeEntry(find(), command("opencode"))).toThrow(ManualEditError);
  });

  it("writes Kiro's and Antigravity's user configs", () => {
    const kiro = target("kiro");
    expect(kiro.path).toBe(join(home, ".kiro", "settings", "mcp.json"));
    mkdirSync(join(home, ".kiro"), { recursive: true });
    expect(target("kiro").detected).toBe(true);
    expect(writeEntry(kiro, command("kiro"))).toBe("added");
    expect(JSON.parse(readFileSync(kiro.path, "utf8")).mcpServers.toolstile).toEqual(command("kiro"));

    const antigravity = target("antigravity");
    expect(antigravity.path).toBe(join(home, ".gemini", "config", "mcp_config.json"));
    // Gemini CLI shares ~/.gemini, so that folder alone does not mean Antigravity is installed.
    mkdirSync(join(home, ".gemini"), { recursive: true });
    expect(target("antigravity").detected).toBe(false);
    mkdirSync(join(home, ".gemini", "antigravity-cli"));
    expect(target("antigravity").detected).toBe(true);
    expect(writeEntry(antigravity, command("antigravity"))).toBe("added");
    expect(JSON.parse(readFileSync(antigravity.path, "utf8")).mcpServers.toolstile).toEqual(command("antigravity"));
  });

  it("does not report proxy entries as a server duplicated across clients", () => {
    for (const client of ["claude-code", "cursor", "codex", "grok", "opencode"] as const) writeEntry(target(client), command(client));
    const result = audit({ home, cwd: null, platform: "linux", env: {} });
    expect(result.findings).toEqual([]);
  });
});

describe("credentials file", () => {
  it("is owner-only and survives a round trip", () => {
    const state = loadState({ home, env: env() });
    expect(state.current).toBe("https://app.toolstile.com");
    state.agents.cursor = { id: "a", workspaceId: "w", server: "https://app.toolstile.com", label: "Cursor", token: "ts_x" };
    saveState(state, { home, env: env() });
    expect(statSync(statePath({ home, env: env() })).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "cfg")).mode & 0o777).toBe(0o700);
    expect(loadState({ home, env: env() }).agents.cursor?.token).toBe("ts_x");
    // The environment picks a server for a command; it never rewrites saved links.
    const elsewhere = loadState({ home, env: { ...env(), TOOLSTILE_SERVER: "https://evil.example" } });
    expect(elsewhere.current).toBe("https://app.toolstile.com");
    expect(elsewhere.agents.cursor?.server).toBe("https://app.toolstile.com");
  });

  it("moves a sign-in saved for the old bare-domain address to the app and gateway hosts", () => {
    mkdirSync(join(home, "cfg"), { recursive: true });
    writeFileSync(
      statePath({ home, env: env() }),
      JSON.stringify({
        server: "https://toolstile.com",
        session: { token: "s", email: "me@test.invalid", expiresAt: "2030-01-01T00:00:00.000Z", server: "https://toolstile.com" },
        agents: {
          cursor: { id: "a", workspaceId: "w", server: "https://toolstile.com", label: "Cursor", token: "ts_x" },
          codex: { id: "b", workspaceId: "w", server: "https://other.example", label: "Codex", token: "ts_y" },
        },
      }),
    );
    const state = loadState({ home, env: env() });
    expect(state.current).toBe("https://app.toolstile.com");
    expect(state.servers).toEqual({
      "https://app.toolstile.com": { session: { token: "s", email: "me@test.invalid", expiresAt: "2030-01-01T00:00:00.000Z" } },
    });
    expect(state.agents.cursor).toMatchObject({
      server: "https://app.toolstile.com",
      endpoint: "https://mcp.toolstile.com/mcp",
    });
    expect(state.agents.codex).toEqual({ id: "b", workspaceId: "w", server: "https://other.example", label: "Codex", token: "ts_y" });
  });

  it("accepts only https servers, or http on loopback", () => {
    expect(normalizeServer("https://app.toolstile.com/personal")).toBe("https://app.toolstile.com");
    expect(normalizeServer("http://localhost:4311")).toBe("http://localhost:4311");
    expect(() => normalizeServer("http://toolstile.com")).toThrow(/https/);
  });
});

describe("server-supplied URLs", () => {
  const server = "https://app.toolstile.com";

  it("accepts a sign-in link only on the server's own origin", () => {
    expect(signInUrl("https://app.toolstile.com/device?user_code=AB", server)?.href).toBe(
      "https://app.toolstile.com/device?user_code=AB",
    );
    expect(signInUrl("http://localhost:4311/device", "http://localhost:4311")?.href).toBe("http://localhost:4311/device");
    for (const hostile of [
      "file:///etc/passwd",
      "file://app.toolstile.com/device",
      "javascript:alert(1)",
      "ms-settings:privacy",
      "toolstile://device",
      "http://app.toolstile.com/device",
      "https://evil.test/device",
      "https://app.toolstile.com.evil.test/device",
      "https://app.toolstile.com:8443/device",
      "https://user:pass@app.toolstile.com/device",
      "https://app.toolstile.com.:443/device",
      "https://xn--pp-8ka.toolstile.com/device",
      "http://127.0.0.1.evil.test/device",
      "http://localhost./device",
      "http://[::ffff:127.0.0.1]/device",
      "https://app.toolstile.com\u0000.evil.test/device",
      "not a url",
      "",
    ])
      expect(signInUrl(hostile, server), hostile).toBeUndefined();
    expect(signInUrl("https://app.toolstile.com:443/device", server)?.href).toBe("https://app.toolstile.com/device");
    // A backslash parses as a path separator, so the serialized link stays on the server's origin.
    expect(signInUrl("https://app.toolstile.com\\@evil.test/device", server)?.href).toBe(
      "https://app.toolstile.com/@evil.test/device",
    );
    expect(signInUrl(undefined, server)).toBeUndefined();
    expect(signInUrl(42, server)).toBeUndefined();
  });

  it("keeps shell metacharacters inside one browser argument on every platform", () => {
    const url = signInUrl("https://app.toolstile.com/device?a=1&calc.exe|whoami;$(id)`id`", server)!.href;
    expect(url.startsWith("https://app.toolstile.com/device?")).toBe(true);
    expect(browserCommand("win32", url)).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
    expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
    expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const [command, args] = browserCommand(platform, url);
      expect(command).not.toMatch(/^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/i);
      expect(args.at(-1)).toBe(url);
    }
  });

  it("does not show or open a link for another origin", async () => {
    const { api } = fakeApi({
      deviceCode: async () => ({
        device_code: "dc",
        user_code: "ABCDEFGH",
        verification_uri: "https://evil.test/device",
        verification_uri_complete: "https://evil.test/device?x=1&calc",
        expires_in: 600,
        interval: 5,
      }),
    });
    const { ctx, output } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    await expect(login(ctx, { browser: true })).rejects.toThrow(/different address/);
    await expect(login(ctx, { browser: true })).rejects.not.toThrow(/evil/);
    expect(output()).not.toContain("evil");
    expect(opened).toEqual([]);
  });

  it("falls back to the code page when only the prefilled link is unsafe", async () => {
    const { api } = fakeApi({
      deviceCode: async () => ({
        device_code: "dc",
        user_code: "ABCDEFGH",
        verification_uri: "https://app.toolstile.com/device",
        verification_uri_complete: "file:///C:/Windows/System32/calc.exe",
        expires_in: 600,
        interval: 5,
      }),
    });
    const { ctx, output } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    expect(await login(ctx, { browser: true })).toBe(0);
    expect(opened).toEqual([]);
    expect(output()).not.toContain("file:");
    expect(output()).toContain("https://app.toolstile.com/device");
    expect(output()).toContain("ABCD-EFGH");
  });

  it("opens a valid link with the machine name", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    await login(ctx, { browser: true });
    expect(opened).toEqual(["https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac"]);
  });

  it("accepts a gateway URL only over HTTPS or loopback HTTP, without credentials", () => {
    expect(gatewayUrl("https://mcp.toolstile.com/mcp")).toBe("https://mcp.toolstile.com/mcp");
    expect(gatewayUrl("http://127.0.0.1:4311/mcp")).toBe("http://127.0.0.1:4311/mcp");
    expect(gatewayUrl("http://[::1]:4311/mcp")).toBe("http://[::1]:4311/mcp");
    for (const bad of [
      "http://mcp.toolstile.com/mcp",
      "https://user:pass@mcp.toolstile.com/mcp",
      "https://mcp.toolstile.com/mcp?token=x",
      "https://mcp.toolstile.com/mcp#x",
      "file:///mcp",
      "ws://localhost/mcp",
      "not a url",
    ])
      expect(gatewayUrl(bad), bad).toBeUndefined();
    expect(gatewayUrl(undefined)).toBeUndefined();
    expect(gatewayUrl({ href: "https://mcp.toolstile.com/mcp" })).toBeUndefined();
  });
});

describe("withoutTomlTable", () => {
  const config = [
    "# my settings",
    'model = "o3"',
    "",
    "[mcp_servers.github]",
    'command = "gh"',
    "",
    "[mcp_servers.toolstile]",
    'command = "npx"',
    "",
    "[mcp_servers.toolstile.env]",
    'A = "1"',
    "",
    '[ "mcp_servers" . "toolstile" . tools ] # quoted header',
    "x = 1",
    "",
    "[mcp_servers.toolstile-other]",
    'command = "keep"',
    "",
  ].join("\n");

  it("drops the table and its sub-tables, keeping everything else", () => {
    const out = withoutTomlTable(config);
    expect(out).toContain("# my settings");
    expect(out).toContain("[mcp_servers.github]");
    expect(out).toContain("[mcp_servers.toolstile-other]");
    expect(out).not.toMatch(/^\[mcp_servers\.toolstile\]/m);
    expect(out).not.toContain("toolstile.env");
    expect(out).not.toContain("quoted header");
    expect(out).not.toContain('command = "npx"');
  });

  it("puts a replacement where the table was, or at the end", () => {
    const replacement = '[mcp_servers.toolstile]\ncommand = "new"\n';
    const out = withoutTomlTable(config, "toolstile", replacement);
    expect(out.indexOf('command = "new"')).toBeLessThan(out.indexOf("[mcp_servers.toolstile-other]"));
    expect(out.match(/command = "new"/g)).toHaveLength(1);
    expect(withoutTomlTable('model = "o3"\n', "toolstile", replacement)).toBe('model = "o3"\n\n[mcp_servers.toolstile]\ncommand = "new"\n');
    expect(withoutTomlTable("", "toolstile", replacement)).toBe('[mcp_servers.toolstile]\ncommand = "new"\n');
  });

  it("removes another named server", () => {
    expect(withoutTomlTable(config, "github")).not.toContain('command = "gh"');
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
      verification_uri: "https://app.toolstile.com/device",
      verification_uri_complete: "https://app.toolstile.com/device?user_code=ABCDEFGH",
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
    hostname: () => "build-mac.local",
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
    // The link fills in the code and this machine's name on the approval page.
    expect(output()).toContain("https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac");
    expect(output()).toContain("ABCD-EFGH");
    expect(output()).toContain("ABCD-EFGH");
    expect(saved()?.session).toMatchObject({ token: "session", email: "me@test.invalid" });
  });

  it("adopts the device named on the approval page", async () => {
    mkdirSync(join(home, ".cursor"));
    const { api, calls } = fakeApi({
      account: async () => ({
        email: "me@test.invalid",
        name: "Me",
        expiresAt: "2030-01-01T00:00:00.000Z",
        workspaces: [{ id: "w1", slug: "personal", name: "Personal", personal: true }],
        device: { id: "d9", label: "Studio Mac" },
      }),
    });
    const { ctx, output } = context(api);
    await login(ctx, { browser: false });
    expect(output()).toContain("on Studio Mac");
    await setup(ctx, { enable: "cursor" });
    expect(calls).toContain("device:Studio Mac");
    expect(saved()?.device).toEqual({ id: "d9", label: "Studio Mac" });
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
    expect(state.servers[CLOUD]?.device).toEqual({ id: "d1", label: "box" });
    expect(Object.keys(state.agents).sort()).toEqual(["codex", "cursor"]);
    expect(readEntry(target("cursor"))).toMatchObject({ args: expect.arrayContaining(["cursor"]) });
    expect(calls).toEqual(["device:box", "add:Cursor", "add:Codex"]);

    expect(await setup(ctx, { disable: "cursor" })).toBe(0);
    state = loadState({ home, env: env() });
    expect(Object.keys(state.agents)).toEqual(["codex"]);
    expect(readEntry(target("cursor"))).toBeUndefined();
    expect(calls.at(-1)).toBe("remove:a1");

    expect(await logout(ctx)).toBe(0);
    expect(saved()?.session).toBeUndefined();
    // Setup signs in again by itself instead of failing.
    expect(await setup(ctx, {})).toBe(0);
    expect(saved()?.session?.token).toBe("session");
  });

  it("keeps tokens on the server that issued them", async () => {
    mkdirSync(join(home, ".cursor"));
    const servers: string[] = [];
    const { api } = fakeApi();
    const { ctx } = context(api);
    ctx.api = (server) => {
      servers.push(server);
      // Each server links to its own approval page.
      const deviceCode = async () => ({
        ...(await api.deviceCode()),
        verification_uri: `${server}/device`,
        verification_uri_complete: `${server}/device?user_code=ABCDEFGH`,
      });
      return { ...api, deviceCode };
    };
    const revoked: string[] = [];
    api.signOut = async (token) => { revoked.push(token); };
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    ctx.env = { ...ctx.env, TOOLSTILE_URL: "https://other.example" };
    api.deviceToken = async () => ({ access_token: "other-session", expires_in: 1 });
    await login(ctx, { browser: false });
    // Signing in to a second server keeps the first sign-in; each session stays with its server.
    expect(new Set(servers)).toEqual(new Set(["https://app.toolstile.com", "https://other.example"]));
    expect(revoked).toEqual([]);
    const state = loadState({ home, env: ctx.env });
    expect(state.current).toBe("https://other.example");
    expect(state.servers[CLOUD]?.session?.token).toBe("session");
    expect(state.servers["https://other.example"]?.session?.token).toBe("other-session");
    expect(state.agents.cursor?.server).toBe("https://app.toolstile.com");
  });

  it("sends each agent to the gateway URL its server reports, or the server's own /mcp", async () => {
    mkdirSync(join(home, ".cursor"));
    const workspaces = [{ id: "w1", slug: "personal", name: "Personal", personal: true }];
    const account = { email: "me@test.invalid", name: "Me", expiresAt: "2030-01-01T00:00:00.000Z", workspaces };
    const reported = fakeApi({ account: async () => ({ ...account, mcpUrl: "https://mcp.toolstile.com/mcp" }) });
    const { ctx } = context(reported.api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    expect(loadState({ home, env: env() }).agents.cursor?.endpoint).toBe("https://mcp.toolstile.com/mcp");
    for (const [mcpUrl, expected] of [
      [undefined, "https://app.toolstile.com/mcp"],
      ["http://mcp.toolstile.com/mcp", "https://app.toolstile.com/mcp"],
      ["https://user:pass@mcp.toolstile.com/mcp", "https://app.toolstile.com/mcp"],
      ["not a url", "https://app.toolstile.com/mcp"],
      ["https://gateway.example/mcp", "https://gateway.example/mcp"],
    ] as const) {
      ctx.api = () => fakeApi({ account: async () => ({ ...account, mcpUrl }) }).api;
      await setup(ctx, { enable: "cursor" });
      expect(loadState({ home, env: env() }).agents.cursor?.endpoint, String(mcpUrl)).toBe(expected);
    }
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

describe("setup signs in when needed", () => {
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");

  /** An API per server that links to its own approval page and records device-code requests. */
  function servers(api: Api) {
    const used: string[] = [];
    const codes: string[] = [];
    const forServer = (server: string): Api => {
      used.push(server);
      return {
        ...api,
        deviceCode: async () => {
          codes.push(server);
          return {
            ...(await api.deviceCode()),
            verification_uri: `${server}/device`,
            verification_uri_complete: `${server}/device?user_code=ABCDEFGH`,
          };
        },
      };
    };
    return { forServer, used, codes };
  }

  it("signs in, then enables the agent and writes its config in the same run", async () => {
    mkdirSync(join(home, ".claude"));
    const { api, calls } = fakeApi();
    const { ctx, output } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    expect(await setup(ctx, { enable: "claude-code" })).toBe(0);
    expect(opened).toEqual(["https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac&next=setup"]);
    expect(output()).toContain("https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac&next=setup");
    expect(output()).toContain("Signed in as me@test.invalid.\n");
    expect(output()).not.toContain("Next:");
    expect(output()).toContain("+ Claude Code");
    expect(output()).toContain("Restart Claude Code to pick up the change.");
    const state = loadState({ home, env: env() });
    expect(state.current).toBe(CLOUD);
    expect(state.servers[CLOUD]).toMatchObject({ edition: "cloud", session: { token: "session" } });
    expect(state.agents["claude-code"]).toMatchObject({ id: "a1", server: "https://app.toolstile.com" });
    expect(readEntry(target("claude-code"))).toMatchObject(command("claude-code"));
    expect(calls).toEqual(["device:build-mac", "add:Claude Code"]);
  });

  it("honors --no-browser and prefills --device-name", async () => {
    const { api } = fakeApi();
    const { ctx, output } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    expect(await setup(ctx, { enable: "cursor", browser: false, deviceName: "box" })).toBe(0);
    expect(opened).toEqual([]);
    expect(output()).toContain("https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=box&next=setup");
  });

  it("signs in again when the saved session has expired", async () => {
    const { api, calls } = fakeApi();
    const { ctx, output } = context(api);
    await login(ctx, { browser: false });
    const account = api.account;
    api.account = async (token) => {
      if (token === "session") throw new ApiError(401, "Unauthorized");
      return account(token);
    };
    api.deviceToken = async () => ({ access_token: "fresh", expires_in: 1 });
    const revoked: string[] = [];
    api.signOut = async (token) => { revoked.push(token); };
    expect(await setup(ctx, { enable: "cursor" })).toBe(0);
    expect(output()).toContain("&next=setup");
    expect(saved()?.session?.token).toBe("fresh");
    expect(loadState({ home, env: env() }).agents.cursor?.id).toBe("a1");
    expect(revoked).toEqual(["session"]);
    expect(calls).toContain("add:Cursor");
  });

  it("signs in to a different --server and sets up the agent there", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    const { forServer, used, codes } = servers(api);
    ctx.api = forServer;
    await login(ctx, { browser: false });
    const revoked: string[] = [];
    api.signOut = async (token) => { revoked.push(token); };
    api.deviceToken = async () => ({ access_token: "other-session", expires_in: 1 });
    expect(await setup(ctx, { enable: "cursor", server: "https://other.example/" })).toBe(0);
    expect(codes).toEqual(["https://app.toolstile.com", "https://other.example"]);
    expect(used).toContain("https://other.example");
    // The sign-in to the first server is kept, not signed out.
    expect(revoked).toEqual([]);
    const state = loadState({ home, env: env() });
    expect(state.current).toBe("https://other.example");
    expect(state.servers["https://other.example"]?.session?.token).toBe("other-session");
    expect(state.servers[CLOUD]?.session?.token).toBe("session");
    expect(state.agents.cursor?.server).toBe("https://other.example");
  });

  it("does not sign in when already signed in to the requested server", async () => {
    mkdirSync(join(home, ".cursor"));
    const { api } = fakeApi();
    const { ctx, output } = context(api);
    const { forServer, codes } = servers(api);
    ctx.api = forServer;
    await login(ctx, { browser: false });
    // --server wins over TOOLSTILE_URL, and the saved sign-in for that server is reused.
    ctx.env = { ...ctx.env, TOOLSTILE_URL: "https://other.example" };
    expect(await setup(ctx, { enable: "cursor", server: "https://app.toolstile.com/" })).toBe(0);
    expect(await setup(ctx, { disable: "cursor", server: "https://app.toolstile.com" })).toBe(0);
    expect(codes).toEqual(["https://app.toolstile.com"]);
    expect(output().match(/Signed in as/g)).toHaveLength(1);
    expect(output()).toContain("Restart Cursor to pick up the change.");
    // Only removals keep the generic line.
    expect(output()).toContain("- Cursor\n\nRestart agents that are running to pick up the change.");
  });

  it("uses TOOLSTILE_URL for a sign-in, like auth login", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    const { forServer, codes } = servers(api);
    ctx.api = forServer;
    ctx.env = { ...ctx.env, TOOLSTILE_URL: "https://other.example" };
    expect(await setup(ctx, { enable: "cursor" })).toBe(0);
    expect(codes).toEqual(["https://other.example"]);
    expect(loadState({ home, env: env() }).agents.cursor?.server).toBe("https://other.example");
  });

  it("stops on a denied sign-in and changes nothing", async () => {
    mkdirSync(join(home, ".cursor"));
    const { api, calls } = fakeApi({
      deviceToken: async () => {
        throw new ApiError(400, "denied", "access_denied");
      },
    });
    const { ctx } = context(api);
    await expect(setup(ctx, { enable: "cursor" })).rejects.toThrow("Sign-in was denied in the browser.");
    expect(calls).toEqual([]);
    expect(readEntry(target("cursor"))).toBeUndefined();
    expect(() => statSync(statePath({ home, env: env() }))).toThrow();
  });

  it("checks the agent flags before signing in", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    let asked = false;
    api.deviceCode = async () => {
      asked = true;
      throw new Error("unexpected");
    };
    await expect(setup(ctx, { enable: "nope" })).rejects.toThrow(/unknown agent/);
    expect(asked).toBe(false);
  });

  it("names every agent it turned on in the restart line", async () => {
    const { api } = fakeApi();
    const { ctx, output } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "claude-code,codex" });
    expect(output()).toContain("Restart Claude Code and Codex to pick up the change.");
    await setup(ctx, { enable: "cursor,windsurf,gemini" });
    expect(output()).toContain("Restart Cursor, Windsurf and Gemini CLI to pick up the change.");
  });

  it("keeps auth login's link and closing line as before", async () => {
    const { api } = fakeApi();
    const { ctx, output } = context(api);
    const opened: string[] = [];
    ctx.openBrowser = (url) => opened.push(url);
    await login(ctx, { browser: true });
    expect(opened).toEqual(["https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac"]);
    expect(output()).not.toContain("next=");
    expect(output()).toBe(
      [
        "Open this link on any device with a browser and approve the sign-in:",
        "",
        "  https://app.toolstile.com/device?user_code=ABCDEFGH&device_name=build-mac",
        "",
        "Check that the page shows this code: ABCD-EFGH",
        "Waiting for approval. The code expires in 10 minutes.",
        "",
        "Signed in as me@test.invalid. Next: toolstile mcp setup",
        "",
      ].join("\n"),
    );
  });

  it("accepts --server and --no-browser on the command line", () => {
    const { TOOLSTILE_URL: _, TOOLSTILE_SERVER: __, ...inherited } = process.env;
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "mcp", "setup", ...args], {
        env: { ...inherited, TOOLSTILE_CONFIG_DIR: join(home, "cfg"), HOME: home },
        encoding: "utf8",
      });
    // Nothing listens on port 9, so the sign-in it starts fails to connect, after parsing.
    const result = run("--enable", "cursor", "--server", "http://127.0.0.1:9", "--no-browser");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not reach http://127.0.0.1:9");
    expect(run("--server=http://127.0.0.1:9", "--no-browser", "--enable=cursor").stderr).toContain("Could not reach");
    expect(run("--server").stderr).toContain("--server needs a value");
    expect(run("--no-browser=1").stderr).toContain("Unknown option");
    expect(run("--server", "http://example.com").stderr).toContain("--server must use https://");
    expect(run("--help").stdout).toContain("--no-browser");
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

describe("checklist", () => {
  it("keeps every line within the terminal width so redraws do not repeat the title", async () => {
    const { checklist } = await import("../src/prompt.js");
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode() {} });
    const output = Object.assign(new PassThrough(), { columns: 40 });
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const done = checklist(
      "Which agents on this machine should use Toolstile?",
      [{ label: "Claude Desktop", hint: "~/Library/Application Support/Claude/claude_desktop_config.json", checked: false }],
      input as never,
      output as never,
    );
    input.write(" ");
    input.write("\r");
    expect(await done).toEqual([true]);
    const visible = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n");
    expect(Math.max(...visible.map((line) => line.length))).toBeLessThan(40);
    expect(visible.some((line) => line.endsWith("config.json") && line.includes("…"))).toBe(true);
  });
});

describe("credential operation conflicts", () => {
  it("publishes disable before cleanup so concurrent enable issues fresh access", async () => {
    const { api, agents } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    const opts = { home, env: env() };
    const oldCursor = loadState(opts).agents.cursor!.id;
    let release!: () => void;
    let started!: () => void;
    const reachedCleanup = new Promise<void>((resolve) => { started = resolve; });
    const remove = api.removeAgent;
    api.removeAgent = async (...args) => {
      if (args[2] === oldCursor) { started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return remove(...args);
    };
    const disabling = setup(ctx, { disable: "cursor" });
    const rejected = expect(disabling).rejects.toThrow("changed in another command");
    await reachedCleanup;
    expect(loadState(opts).agents.cursor).toBeUndefined();
    expect(await setup(ctx, { enable: "cursor,codex" })).toBe(0);
    release(); await rejected;
    const winner = loadState(opts);
    expect(winner.agents.cursor!.id).not.toBe(oldCursor);
    expect(agents.has(winner.agents.cursor!.id)).toBe(true);
    expect(agents.has(winner.agents.codex!.id)).toBe(true);
    expect(agents.has(oldCursor)).toBe(false);
    expect(readEntry(target("cursor"))).toBeTruthy();
    expect(readEntry(target("codex"))).toBeTruthy();
  });

  it("keeps failed remote disable locally removed and explains cleanup", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    api.removeAgent = async () => { throw new ApiError(503, "unavailable"); };
    await expect(setup(ctx, { disable: "cursor" })).rejects.toThrow("Disabled locally, but remote cleanup failed");
    expect(loadState({ home, env: env() }).agents.cursor).toBeUndefined();
    expect(readEntry(target("cursor"))).toBeUndefined();
  });

  it("rejects stale later-agent config writes after concurrent disable", async () => {
    const { api, agents } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor,codex" });
    const opts = { home, env: env() };
    const state = loadState(opts);
    const oldCursor = state.agents.cursor!.id;
    const codex = state.agents.codex!.id;
    state.agents.cursor!.workspaceId = "old-workspace";
    saveState(state, opts);
    let release!: () => void;
    let started!: () => void;
    const reachedCleanup = new Promise<void>((resolve) => { started = resolve; });
    const remove = api.removeAgent;
    api.removeAgent = async (...args) => {
      if (args[2] === oldCursor) { started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return remove(...args);
    };
    const replacing = setup(ctx, { enable: "cursor" });
    const rejected = expect(replacing).rejects.toThrow("changed in another command");
    await reachedCleanup;
    expect(await setup(ctx, { disable: "codex" })).toBe(0);
    release(); await rejected;
    expect(loadState(opts).agents.codex).toBeUndefined();
    expect(readEntry(target("codex"))).toBeUndefined();
    expect(agents.has(codex)).toBe(false);
  });

  it("does not recreate config after disable races with delayed replacement cleanup", async () => {
    const { api, agents } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    const opts = { home, env: env() };
    const state = loadState(opts);
    state.agents.cursor!.workspaceId = "old-workspace";
    saveState(state, opts);
    let release!: () => void;
    let started!: () => void;
    const reachedCleanup = new Promise<void>((resolve) => { started = resolve; });
    const remove = api.removeAgent;
    api.removeAgent = async (...args) => {
      if (args[2] === "a1") { started(); await new Promise<void>((resolve) => { release = resolve; }); }
      return remove(...args);
    };
    const replacing = setup(ctx, { enable: "cursor" });
    await reachedCleanup;
    expect(loadState(opts).agents.cursor?.id).toBe("a2");
    expect(await setup(ctx, { disable: "cursor" })).toBe(0);
    release();
    expect(await replacing).toBe(0);
    expect(loadState(opts).agents.cursor).toBeUndefined();
    expect(readEntry(target("cursor"))).toBeUndefined();
    expect([...agents.keys()]).toEqual([]);
  });

  it("cleans up the losing setup's new authorization and preserves the concurrent winner and config", async () => {
    const { api, calls, agents } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const add = api.addAgent;
    let count = 0;
    api.addAgent = async (...args) => {
      const created = await add(...args);
      if (++count === 1) {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return created;
    };
    const losing = setup(ctx, { enable: "cursor" });
    const rejected = expect(losing).rejects.toThrow("changed in another command");
    await firstStarted;
    expect(await setup(ctx, { enable: "cursor" })).toBe(0);
    const before = readFileSync(target("cursor").path, "utf8");
    release(); await rejected;
    expect(loadState({ home, env: env() }).agents.cursor?.id).toBe("a2");
    expect([...agents.keys()]).toEqual(["a2"]);
    expect(calls.filter((c) => c.startsWith("remove:"))).toEqual(["remove:a1"]);
    expect(readFileSync(target("cursor").path, "utf8")).toBe(before);
  });

  it("preserves an older authorization until its replacement has been saved", async () => {
    const { api, agents, calls } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    await setup(ctx, { enable: "cursor" });
    const opts = { home, env: env() };
    const stale = loadState(opts);
    stale.agents.cursor!.workspaceId = "old-workspace";
    saveState(stale, opts);
    const add = api.addAgent;
    api.addAgent = async (...args) => {
      expect(agents.has("a1")).toBe(true);
      const created = await add(...args);
      const winner = loadState(opts);
      winner.servers[CLOUD]!.device!.label = "concurrent winner";
      saveState(winner, opts);
      return created;
    };
    await expect(setup(ctx, { enable: "cursor" })).rejects.toThrow("changed in another command");
    expect([...agents.keys()]).toEqual(["a1"]);
    expect(calls).not.toContain("remove:a1");
    expect(loadState(opts).agents.cursor?.id).toBe("a1");
    expect(loadState(opts).servers[CLOUD]?.device?.label).toBe("concurrent winner");
  });

  it("does not revoke a newly issued authorization that the winning state already retains", async () => {
    const { api, agents } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    const add = api.addAgent;
    api.addAgent = async (...args) => {
      const created = await add(...args);
      const winner = loadState({ home, env: env() });
      winner.agents.cursor = {
        ...created, workspaceId: "w1", server: winner.current, endpoint: "https://gateway.invalid/mcp",
      };
      saveState(winner, { home, env: env() });
      return created;
    };
    await expect(setup(ctx, { enable: "cursor" })).rejects.toThrow("changed in another command");
    expect(agents.has("a1")).toBe(true);
    expect(loadState({ home, env: env() }).agents.cursor?.id).toBe("a1");
    expect(readEntry(target("cursor"))).toBeUndefined();
  });

  it.each([404, 503])("reports cleanup failures but accepts an already removed authorization (%s)", async (status) => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    const add = api.addAgent;
    api.addAgent = async (...args) => {
      const created = await add(...args);
      const winner = loadState({ home, env: env() });
      winner.servers[CLOUD]!.device!.label = "winner";
      saveState(winner, { home, env: env() });
      return created;
    };
    api.removeAgent = async () => { throw new ApiError(status, "fixture failure"); };
    await expect(setup(ctx, { enable: "cursor" })).rejects.toThrow(status === 404 ? "changed in another command" : "Agent cleanup failed");
    expect(saved()?.device?.label).toBe("winner");
    expect(readEntry(target("cursor"))).toBeUndefined();
  });

  it("revokes only the losing login's new session and leaves the existing session usable", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    api.deviceToken = async () => ({ access_token: "losing-session", expires_in: 1 });
    const revoked: string[] = [];
    api.signOut = async (token) => { revoked.push(token); };
    const account = api.account;
    api.account = async (token) => {
      const winner = loadState({ home, env: env() });
      winner.servers[CLOUD]!.device = { id: "winner", label: "winner" };
      saveState(winner, { home, env: env() });
      return account(token);
    };
    await expect(login(ctx, { browser: false })).rejects.toThrow("changed in another command");
    expect(revoked).toEqual(["losing-session"]);
    expect(saved()?.session?.token).toBe("session");
    expect(saved()?.device?.id).toBe("winner");
  });

  it("cleans up an approved login if account lookup fails", async () => {
    const revoked: string[] = [];
    const { api } = fakeApi({
      account: async () => { throw new Error("account fixture failed"); },
      signOut: async (token) => { revoked.push(token); },
    });
    await expect(login(context(api).ctx, { browser: false })).rejects.toThrow("account fixture failed");
    expect(revoked).toEqual(["session"]);
    expect(saved()?.session).toBeUndefined();
  });
});

describe("credential revocation order", () => {
  it("saves a replacement login before signing out its previous session", async () => {
    const { api } = fakeApi();
    const { ctx } = context(api);
    await login(ctx, { browser: false });
    api.deviceToken = async () => ({ access_token: "replacement", expires_in: 1 });
    const revoked: string[] = [];
    api.signOut = async (token) => {
      expect(saved()?.session?.token).toBe("replacement");
      revoked.push(token);
    };
    await login(ctx, { browser: false });
    expect(revoked).toEqual(["session"]);
  });

  it("saves logout before remote revocation, including when the server is unavailable", async () => {
    const { api } = fakeApi();
    const { ctx, output } = context(api);
    await login(ctx, { browser: false });
    const revoked: string[] = [];
    api.signOut = async (token) => {
      expect(saved()?.session).toBeUndefined();
      revoked.push(token);
      throw new ApiError(503, "offline fixture");
    };
    expect(await logout(ctx)).toBe(0);
    expect(revoked).toEqual(["session"]);
    expect(output()).toContain("Signed out of https://app.toolstile.com on this machine. The server could not be reached");
  });
});
