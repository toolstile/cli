export type Severity = "high" | "medium" | "low";

export type ClientId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "codex"
  | "vscode"
  | "windsurf"
  | "gemini"
  | "cline";

export interface Location {
  /** Absolute path of the config file. */
  file: string;
  /** Dotted path to the value inside the file, for example `mcpServers.github.env.TOKEN`. */
  pointer: string;
}

export interface ConfigFile {
  client: ClientId;
  path: string;
  /** Parsed file contents. */
  data: unknown;
  /** Unix permission bits, when available. */
  mode?: number;
}

export interface ServerEntry {
  client: ClientId;
  file: string;
  /** Pointer to the server object, for example `mcpServers.github`. */
  pointer: string;
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  /** Other string fields that may carry credentials, such as Codex `bearer_token`. */
  extraSecrets: Record<string, string>;
  /** Tools listed under client auto-approval keys (`alwaysAllow`, `autoApprove`). */
  autoApproved: string[];
}

/** Client settings that approve MCP tools without asking. */
export interface ApprovalSetting {
  client: ClientId;
  location: Location;
  /** What is approved, for example `mcp__github` or `all project servers`. */
  subject: string;
}

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
  locations: Location[];
}

export interface AuditResult {
  files: { client: ClientId; path: string }[];
  /** Files that exist but could not be parsed. */
  unreadable: { client: ClientId; path: string; error: string }[];
  servers: number;
  clients: ClientId[];
  findings: Finding[];
  score: number | null;
  grade: string | null;
}
