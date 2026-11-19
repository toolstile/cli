import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ConfigParseError, parseConfig } from "./parse.js";
import type { ApprovalSetting, ClientId, ConfigFile, ServerEntry } from "./types.js";

export interface ScanOptions {
  home: string;
  /** Project directory whose checked-in configs are also scanned; `null` skips it. */
  cwd: string | null;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

type Kind = "mcp" | "claude-json" | "claude-settings" | "toml" | "opencode" | "vscode-settings" | "vscode-mcp";

interface Candidate {
  client: ClientId;
  path: string;
  kind: Kind;
}

export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  codex: "Codex",
  vscode: "VS Code",
  windsurf: "Windsurf",
  devin: "Devin Desktop",
  gemini: "Gemini CLI",
  cline: "Cline",
  grok: "Grok Build",
  opencode: "OpenCode",
  kiro: "Kiro",
  antigravity: "Antigravity",
};

/** Devin Desktop's user config folder: `%APPDATA%\\devin` on Windows, `~/.config/devin` elsewhere. */
export function devinDir({ home, platform, env }: Omit<ScanOptions, "cwd">): string {
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "devin");
  return join(home, ".config", "devin");
}

/** OpenCode's global config folder, `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` on every platform. */
export function opencodeDir({ home, env }: Omit<ScanOptions, "cwd">): string {
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
}

export function appData({ home, platform, env }: Omit<ScanOptions, "cwd">): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}

function candidates(opts: ScanOptions): Candidate[] {
  const { home, cwd, env } = opts;
  const data = appData(opts);
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const clineSettings = ["globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"];
  const opencode = opencodeDir(opts);

  const list: Candidate[] = [
    { client: "claude-code", path: join(home, ".claude.json"), kind: "claude-json" },
    { client: "claude-code", path: join(home, ".claude", "settings.json"), kind: "claude-settings" },
    { client: "claude-desktop", path: join(data, "Claude", "claude_desktop_config.json"), kind: "mcp" },
    { client: "cursor", path: join(home, ".cursor", "mcp.json"), kind: "mcp" },
    { client: "codex", path: join(codexHome, "config.toml"), kind: "toml" },
    { client: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), kind: "mcp" },
    { client: "devin", path: join(devinDir(opts), "mcp_config.json"), kind: "mcp" },
    { client: "gemini", path: join(home, ".gemini", "settings.json"), kind: "mcp" },
    { client: "grok", path: join(home, ".grok", "config.toml"), kind: "toml" },
    { client: "opencode", path: join(opencode, "opencode.json"), kind: "opencode" },
    { client: "opencode", path: join(opencode, "opencode.jsonc"), kind: "opencode" },
    { client: "kiro", path: join(home, ".kiro", "settings", "mcp.json"), kind: "mcp" },
    { client: "antigravity", path: join(home, ".gemini", "config", "mcp_config.json"), kind: "mcp" },
    // Antigravity releases before 2.0 kept the file here.
    { client: "antigravity", path: join(home, ".gemini", "antigravity", "mcp_config.json"), kind: "mcp" },
  ];
  for (const edition of ["Code", "Code - Insiders"]) {
    list.push(
      { client: "vscode", path: join(data, edition, "User", "settings.json"), kind: "vscode-settings" },
      { client: "vscode", path: join(data, edition, "User", "mcp.json"), kind: "vscode-mcp" },
      { client: "cline", path: join(data, edition, "User", ...clineSettings), kind: "mcp" },
    );
  }
  list.push({ client: "cline", path: join(data, "Cursor", "User", ...clineSettings), kind: "mcp" });

  if (cwd) {
    const dir = resolve(cwd);
    list.push(
      { client: "claude-code", path: join(dir, ".mcp.json"), kind: "mcp" },
      { client: "claude-code", path: join(dir, ".claude", "settings.json"), kind: "claude-settings" },
      { client: "claude-code", path: join(dir, ".claude", "settings.local.json"), kind: "claude-settings" },
      { client: "cursor", path: join(dir, ".cursor", "mcp.json"), kind: "mcp" },
      { client: "vscode", path: join(dir, ".vscode", "mcp.json"), kind: "vscode-mcp" },
      { client: "gemini", path: join(dir, ".gemini", "settings.json"), kind: "mcp" },
      { client: "codex", path: join(dir, ".codex", "config.toml"), kind: "toml" },
      { client: "devin", path: join(dir, ".devin", "mcp_config.json"), kind: "mcp" },
      { client: "devin", path: join(dir, ".devin", "mcp_config.local.json"), kind: "mcp" },
      { client: "grok", path: join(dir, ".grok", "config.toml"), kind: "toml" },
      { client: "opencode", path: join(dir, "opencode.json"), kind: "opencode" },
      { client: "opencode", path: join(dir, "opencode.jsonc"), kind: "opencode" },
      { client: "opencode", path: join(dir, ".opencode", "opencode.json"), kind: "opencode" },
      { client: "opencode", path: join(dir, ".opencode", "opencode.jsonc"), kind: "opencode" },
      { client: "kiro", path: join(dir, ".kiro", "settings", "mcp.json"), kind: "mcp" },
      { client: "antigravity", path: join(dir, ".agents", "mcp_config.json"), kind: "mcp" },
    );
  }

  const seen = new Set<string>();
  return list.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

/** Appends a key to a pointer, quoting keys that are not plain identifiers. */
export function pointerJoin(base: string, key: string): string {
  const part = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : /^\d+$/.test(key) ? `[${key}]` : `[${JSON.stringify(key)}]`;
  if (!base) return part;
  return part.startsWith("[") ? `${base}${part}` : `${base}.${part}`;
}

/** Keys of `args[index]` below the server object. */
export const argKeys = (s: ServerEntry, index: number): string[] =>
  s.argsKey === "command" ? ["command", String(index + 1)] : ["args", String(index)];

function toServer(client: ClientId, file: string, path: string[], name: string, v: unknown): ServerEntry | null {
  if (!isObject(v)) return null;
  // OpenCode keeps the executable and its arguments in one `command` array, and env in `environment`.
  const list = Array.isArray(v.command) ? strings(v.command) : null;
  const envKey = client === "opencode" ? "environment" : "env";
  const extraSecrets: Record<string, string> = {};
  const bearer = str(v.bearer_token);
  if (bearer) extraSecrets.bearer_token = bearer;
  const headerKeys: Record<string, string> = {};
  for (const key of ["headers", "http_headers"]) for (const name of Object.keys(stringRecord(v[key]))) headerKeys[name] = key;
  return {
    client,
    file,
    pointer: path.reduce(pointerJoin, ""),
    path,
    name,
    command: list ? list[0] : str(v.command),
    args: list ? list.slice(1) : strings(v.args),
    env: stringRecord(v[envKey]),
    envKey,
    argsKey: list ? "command" : "args",
    url: str(v.url) ?? str(v.serverUrl) ?? str(v.httpUrl),
    headers: { ...stringRecord(v.headers), ...stringRecord(v.http_headers) },
    headerKeys,
    extraSecrets,
    autoApproved: [...strings(v.alwaysAllow), ...strings(v.autoApprove)],
  };
}

function serversAt(client: ClientId, file: string, base: string[], v: unknown): ServerEntry[] {
  if (!isObject(v)) return [];
  const out: ServerEntry[] = [];
  for (const [name, def] of Object.entries(v)) {
    const server = toServer(client, file, [...base, name], name, def);
    if (server) out.push(server);
  }
  return out;
}

/**
 * OpenCode V1 names servers directly under `mcp`; V2 groups them under `mcp.servers`. V2 reads
 * both, so a file may mix them. Every server has a `type`, which tells a V1 server from settings.
 */
function opencodeServers(client: ClientId, file: string, mcp: unknown): ServerEntry[] {
  if (!isObject(mcp)) return [];
  const grouped = isObject(mcp.servers) && typeof mcp.servers.type !== "string";
  const direct = Object.fromEntries(
    Object.entries(mcp).filter(([name, def]) => !(grouped && name === "servers") && isObject(def) && typeof def.type === "string"),
  );
  return [
    ...serversAt(client, file, ["mcp"], direct),
    ...(grouped ? serversAt(client, file, ["mcp", "servers"], mcp.servers) : []),
  ];
}

function claudeApprovals(file: ConfigFile): ApprovalSetting[] {
  const data = file.data;
  if (!isObject(data)) return [];
  const out: ApprovalSetting[] = [];
  if (data.enableAllProjectMcpServers === true) {
    out.push({
      client: file.client,
      location: { file: file.path, pointer: "enableAllProjectMcpServers" },
      subject: "every MCP server in project .mcp.json files",
    });
  }
  const allow = isObject(data.permissions) ? strings(data.permissions.allow) : [];
  allow.forEach((rule, i) => {
    // `mcp__server` and `mcp__server__*` approve every tool of a server; named tools are deliberate.
    if (!rule.startsWith("mcp__")) return;
    const rest = rule.slice("mcp__".length);
    if (rest === "*" || !rest.includes("__") || rest.endsWith("__*")) {
      out.push({
        client: file.client,
        location: { file: file.path, pointer: `permissions.allow[${i}]` },
        subject: rule,
      });
    }
  });
  return out;
}

/**
 * Who besides the owner can read a file, given its mode and the modes of every folder above it.
 * A group or other user needs read on the file and execute (traverse) on each folder.
 */
export function exposureOf(fileMode: number, ancestorModes: number[]): "group" | "others" | null {
  if (fileMode & 0o004 && ancestorModes.every((m) => m & 0o001)) return "others";
  if (fileMode & 0o040 && ancestorModes.every((m) => m & 0o010)) return "group";
  return null;
}

function ancestorModes(path: string): number[] {
  const modes: number[] = [];
  let dir = dirname(path);
  for (;;) {
    try {
      modes.push(statSync(dir).mode & 0o777);
    } catch {
      // An unreadable folder is not traversable by us either; treat it as closed.
      modes.push(0);
    }
    const parent = dirname(dir);
    if (parent === dir) return modes;
    dir = parent;
  }
}

export interface Discovery {
  files: ConfigFile[];
  unreadable: { client: ClientId; path: string; error: string }[];
  servers: ServerEntry[];
  approvals: ApprovalSetting[];
}

/** A fixed description of a read failure; system messages are not passed through. */
function readError(code: string | undefined): string {
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EISDIR") return "is a directory";
  return code && /^E[A-Z]+$/.test(code) ? `could not read it (${code})` : "could not read it";
}

export function discover(opts: ScanOptions): Discovery {
  const result: Discovery = { files: [], unreadable: [], servers: [], approvals: [] };
  for (const c of candidates(opts)) {
    let text: string;
    let mode: number | undefined;
    try {
      const stat = statSync(c.path);
      if (!stat.isFile()) continue;
      mode = opts.platform === "win32" ? undefined : stat.mode & 0o777;
      text = readFileSync(c.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Absent files are normal; anything else means a config exists that we could not check.
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        result.unreadable.push({ client: c.client, path: c.path, error: readError(code) });
      }
      continue;
    }
    let data: unknown;
    try {
      data = parseConfig(c.path, text);
    } catch (error) {
      // parseConfig's messages are fixed text plus a position, never file contents.
      const message = error instanceof ConfigParseError ? error.message : "could not parse it";
      result.unreadable.push({ client: c.client, path: c.path, error: message });
      continue;
    }
    const exposure = mode === undefined ? undefined : exposureOf(mode, ancestorModes(c.path));
    const file: ConfigFile = { client: c.client, path: c.path, data, mode, exposure };
    result.files.push(file);
    if (!isObject(data)) continue;

    switch (c.kind) {
      case "mcp":
        result.servers.push(...serversAt(c.client, c.path, ["mcpServers"], data.mcpServers));
        break;
      case "claude-json":
        result.servers.push(...serversAt(c.client, c.path, ["mcpServers"], data.mcpServers));
        if (isObject(data.projects)) {
          for (const [project, conf] of Object.entries(data.projects)) {
            if (!isObject(conf)) continue;
            result.servers.push(...serversAt(c.client, c.path, ["projects", project, "mcpServers"], conf.mcpServers));
          }
        }
        break;
      case "claude-settings":
        result.approvals.push(...claudeApprovals(file));
        break;
      case "toml":
        result.servers.push(...serversAt(c.client, c.path, ["mcp_servers"], data.mcp_servers));
        break;
      case "opencode":
        result.servers.push(...opencodeServers(c.client, c.path, data.mcp));
        break;
      case "vscode-settings":
        if (isObject(data.mcp)) result.servers.push(...serversAt(c.client, c.path, ["mcp", "servers"], data.mcp.servers));
        break;
      case "vscode-mcp":
        result.servers.push(...serversAt(c.client, c.path, ["servers"], data.servers));
        break;
    }
  }
  return result;
}
