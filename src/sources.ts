import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseConfig } from "./parse.js";
import type { ApprovalSetting, ClientId, ConfigFile, ServerEntry } from "./types.js";

export interface ScanOptions {
  home: string;
  /** Project directory whose checked-in configs are also scanned; `null` skips it. */
  cwd: string | null;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

type Kind = "mcp" | "claude-json" | "claude-settings" | "codex" | "vscode-settings" | "vscode-mcp";

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
  gemini: "Gemini CLI",
  cline: "Cline",
};

function appData({ home, platform, env }: ScanOptions): string {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME ?? join(home, ".config");
}

function candidates(opts: ScanOptions): Candidate[] {
  const { home, cwd, env } = opts;
  const data = appData(opts);
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const clineSettings = ["globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"];

  const list: Candidate[] = [
    { client: "claude-code", path: join(home, ".claude.json"), kind: "claude-json" },
    { client: "claude-code", path: join(home, ".claude", "settings.json"), kind: "claude-settings" },
    { client: "claude-desktop", path: join(data, "Claude", "claude_desktop_config.json"), kind: "mcp" },
    { client: "cursor", path: join(home, ".cursor", "mcp.json"), kind: "mcp" },
    { client: "codex", path: join(codexHome, "config.toml"), kind: "codex" },
    { client: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), kind: "mcp" },
    { client: "gemini", path: join(home, ".gemini", "settings.json"), kind: "mcp" },
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
      { client: "codex", path: join(dir, ".codex", "config.toml"), kind: "codex" },
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

function toServer(client: ClientId, file: string, pointer: string, name: string, v: unknown): ServerEntry | null {
  if (!isObject(v)) return null;
  const extraSecrets: Record<string, string> = {};
  const bearer = str(v.bearer_token);
  if (bearer) extraSecrets.bearer_token = bearer;
  return {
    client,
    file,
    pointer,
    name,
    command: str(v.command),
    args: strings(v.args),
    env: stringRecord(v.env),
    url: str(v.url) ?? str(v.serverUrl) ?? str(v.httpUrl),
    headers: { ...stringRecord(v.headers), ...stringRecord(v.http_headers) },
    extraSecrets,
    autoApproved: [...strings(v.alwaysAllow), ...strings(v.autoApprove)],
  };
}

function serversAt(client: ClientId, file: string, base: string, v: unknown): ServerEntry[] {
  if (!isObject(v)) return [];
  const out: ServerEntry[] = [];
  for (const [name, def] of Object.entries(v)) {
    const server = toServer(client, file, pointerJoin(base, name), name, def);
    if (server) out.push(server);
  }
  return out;
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
    } catch {
      continue;
    }
    let data: unknown;
    try {
      data = parseConfig(c.path, text);
    } catch (error) {
      result.unreadable.push({ client: c.client, path: c.path, error: (error as Error).message });
      continue;
    }
    const exposure = mode === undefined ? undefined : exposureOf(mode, ancestorModes(c.path));
    const file: ConfigFile = { client: c.client, path: c.path, data, mode, exposure };
    result.files.push(file);
    if (!isObject(data)) continue;

    switch (c.kind) {
      case "mcp":
        result.servers.push(...serversAt(c.client, c.path, "mcpServers", data.mcpServers));
        break;
      case "claude-json":
        result.servers.push(...serversAt(c.client, c.path, "mcpServers", data.mcpServers));
        if (isObject(data.projects)) {
          for (const [project, conf] of Object.entries(data.projects)) {
            if (!isObject(conf)) continue;
            const base = pointerJoin(pointerJoin("projects", project), "mcpServers");
            result.servers.push(...serversAt(c.client, c.path, base, conf.mcpServers));
          }
        }
        break;
      case "claude-settings":
        result.approvals.push(...claudeApprovals(file));
        break;
      case "codex":
        result.servers.push(...serversAt(c.client, c.path, "mcp_servers", data.mcp_servers));
        break;
      case "vscode-settings":
        if (isObject(data.mcp)) result.servers.push(...serversAt(c.client, c.path, "mcp.servers", data.mcp.servers));
        break;
      case "vscode-mcp":
        result.servers.push(...serversAt(c.client, c.path, "servers", data.servers));
        break;
    }
  }
  return result;
}
