/** `info` findings are context only and do not affect the score. */
export type Severity = "high" | "medium" | "low" | "info";

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
  /** Who besides the owner can read the file, counting the folders above it. */
  exposure?: "group" | "others" | null;
}

export interface ServerEntry {
  client: ClientId;
  file: string;
  /** Pointer to the server object, for example `mcpServers.github`. */
  pointer: string;
  /** The same location as keys, for editing the file. */
  path: string[];
  name: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  /** The config key each header came from: `headers`, or Codex's `http_headers`. */
  headerKeys: Record<string, string>;
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
  /** What the finding is about, for example `github (Cursor)` or a file path. */
  subject: string;
  /** A short specific, for example the kind of secret or the package; may be empty. */
  note: string;
  detail: string;
  fix: string;
  locations: Location[];
  /** Points this finding takes off the score; repeats of one root cause count once. */
  weight: number;
}

export interface AuditResult {
  files: { client: ClientId; path: string }[];
  /**
   * Files that exist but could not be read or parsed. `error` is a fixed description with at most
   * a line and column, for example `invalid TOML at line 3, column 12`; it never quotes the file.
   */
  unreadable: { client: ClientId; path: string; error: string }[];
  servers: number;
  clients: ClientId[];
  findings: Finding[];
  score: number | null;
  grade: string | null;
}
