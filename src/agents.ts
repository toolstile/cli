import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseJsonc } from "./parse.js";
import { appData, CLIENT_NAMES } from "./sources.js";
import type { ClientId } from "./types.js";

/** The server name `toolstile mcp setup` adds to each agent's config. */
export const ENTRY = "toolstile";

type Format = "mcpServers" | "vscode" | "codex";

export interface Target {
  client: ClientId;
  name: string;
  /** User-level config file that gets the entry. */
  path: string;
  format: Format;
  /** Whether the app looks installed: its config file or folder exists. */
  detected: boolean;
}

export interface TargetEnv {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

export function targets(opts: TargetEnv): Target[] {
  const { home, env } = opts;
  const data = appData(opts);
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const code = ["Code", "Code - Insiders"].map((edition) => join(data, edition, "User")).find((dir) => existsSync(dir)) ??
    join(data, "Code", "User");
  const cline = join(code, "globalStorage", "saoudrizwan.claude-dev");
  const list: [ClientId, string, Format, string][] = [
    ["claude-code", join(home, ".claude.json"), "mcpServers", join(home, ".claude")],
    ["claude-desktop", join(data, "Claude", "claude_desktop_config.json"), "mcpServers", join(data, "Claude")],
    ["cursor", join(home, ".cursor", "mcp.json"), "mcpServers", join(home, ".cursor")],
    ["codex", join(codexHome, "config.toml"), "codex", codexHome],
    ["vscode", join(code, "mcp.json"), "vscode", code],
    ["windsurf", join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", join(home, ".codeium", "windsurf")],
    ["gemini", join(home, ".gemini", "settings.json"), "mcpServers", join(home, ".gemini")],
    ["cline", join(cline, "settings", "cline_mcp_settings.json"), "mcpServers", cline],
  ];
  return list.map(([client, path, format, folder]) => ({
    client,
    name: CLIENT_NAMES[client],
    path,
    format,
    detected: existsSync(path) || existsSync(folder),
  }));
}

/** How the agent starts the proxy. Pinned, so the config runs the version that wrote it. */
export function proxyCommand(client: ClientId, version: string, platform: NodeJS.Platform) {
  const args = ["-y", `toolstile@${version}`, "mcp", "proxy", "--agent", client];
  // Windows apps start commands without a shell, and npx is a .cmd script there.
  return platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

/** A config entry for a different, hand-written `toolstile` server is left alone. */
export function isProxyEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const args = (value as { args?: unknown }).args;
  return Array.isArray(args) && args.some((a) => typeof a === "string" && /^toolstile(@|$)/.test(a)) &&
    args.includes("proxy");
}

export class ManualEditError extends Error {
  constructor(
    readonly target: Target,
    reason: string,
    readonly snippet: string,
  ) {
    super(reason);
    this.name = "ManualEditError";
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Replaces the file in one step and keeps its permission bits; a symlink keeps pointing at it. */
function writeText(link: string, text: string) {
  let path = link;
  let mode = 0o600;
  try {
    path = realpathSync(link);
    mode = statSync(path).mode & 0o777;
  } catch {
    mkdirSync(dirname(path), { recursive: true });
  }
  const temp = `${path}.toolstile-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

const serversKey = (format: Format) => (format === "vscode" ? "servers" : "mcpServers");

function jsonEntry(target: Target, command: { command: string; args: string[] }) {
  return target.format === "vscode" || target.client === "claude-code" ? { type: "stdio", ...command } : command;
}

function tomlEntry(command: { command: string; args: string[] }) {
  return `[mcp_servers.${ENTRY}]\ncommand = ${JSON.stringify(command.command)}\nargs = [${command.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
}

/** Drops `[mcp_servers.toolstile]` and its sub-tables, keeping every other line and comment. */
function withoutTomlEntry(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/)?.[1];
    if (header !== undefined) {
      const name = header.replace(/\s+/g, "").replace(/"/g, "");
      skipping = name === `mcp_servers.${ENTRY}` || name.startsWith(`mcp_servers.${ENTRY}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}$/, "\n\n");
}

/** The current entry, if the agent's config has one. */
export function readEntry(target: Target): unknown {
  const text = readText(target.path);
  if (!text?.trim()) return undefined;
  try {
    if (target.format === "codex") {
      const servers = (parseToml(text) as { mcp_servers?: Record<string, unknown> }).mcp_servers;
      return servers?.[ENTRY];
    }
    const data = parseJsonc(text) as Record<string, Record<string, unknown> | undefined>;
    return data?.[serversKey(target.format)]?.[ENTRY];
  } catch {
    return undefined;
  }
}

/**
 * Adds (or, with `command` null, removes) the `toolstile` entry. JSON files with comments are
 * not rewritten, since that would drop the comments; the caller shows the snippet instead.
 */
export type WriteResult = "added" | "updated" | "replaced" | "removed" | "unchanged";

/** `replaced` means a hand-written `toolstile` server (not the proxy) was swapped out. */
const outcome = (command: unknown, existing: unknown): WriteResult =>
  !command ? "removed" : existing === undefined ? "added" : isProxyEntry(existing) ? "updated" : "replaced";

export function writeEntry(target: Target, command: { command: string; args: string[] } | null): WriteResult {
  const text = readText(target.path) ?? "";
  if (target.format === "codex") {
    let current: Record<string, unknown> | undefined;
    try {
      current = (parseToml(text) as { mcp_servers?: Record<string, unknown> }).mcp_servers;
    } catch {
      throw new ManualEditError(target, "its TOML could not be parsed", command ? tomlEntry(command) : "");
    }
    const existing = current?.[ENTRY];
    if (!command && (existing === undefined || !isProxyEntry(existing))) return "unchanged";
    let next = withoutTomlEntry(text);
    if (command) next = `${next.replace(/\s*$/, "")}${next.trim() ? "\n\n" : ""}${tomlEntry(command)}`;
    let parsed: unknown;
    try {
      parsed = (parseToml(next) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.[ENTRY];
    } catch {
      parsed = null;
    }
    if (command ? !isProxyEntry(parsed) : parsed !== undefined)
      throw new ManualEditError(target, "its toolstile server is written in a form setup cannot edit", command ? tomlEntry(command) : "");
    if (next === text) return "unchanged";
    writeText(target.path, next);
    return outcome(command, existing);
  }

  const key = serversKey(target.format);
  const entry = command ? jsonEntry(target, command) : undefined;
  const snippet = entry ? JSON.stringify({ [key]: { [ENTRY]: entry } }, null, 2) : "";
  let data: unknown;
  try {
    data = text.trim() ? parseJsonc(text) : {};
  } catch {
    throw new ManualEditError(target, "its JSON could not be parsed", snippet);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new ManualEditError(target, "it is not a JSON object", snippet);
  const object = data as Record<string, unknown>;
  const servers = (typeof object[key] === "object" && object[key] !== null ? object[key] : {}) as Record<string, unknown>;
  const existing = servers[ENTRY];
  if (entry ? JSON.stringify(existing) === JSON.stringify(entry) : existing === undefined || !isProxyEntry(existing))
    return "unchanged";
  // Rewriting would drop comments and trailing commas, so such files are left to the user.
  try {
    JSON.parse(text || "{}");
  } catch {
    throw new ManualEditError(target, "it contains comments", snippet);
  }
  if (entry) servers[ENTRY] = entry;
  else delete servers[ENTRY];
  object[key] = servers;
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  writeText(target.path, `${JSON.stringify(object, null, indent)}\n`);
  return outcome(entry, existing);
}
