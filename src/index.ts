import { homedir } from "node:os";
import { runChecks, score } from "./checks.js";
import { discover, type ScanOptions } from "./sources.js";
import type { AuditResult, ClientId } from "./types.js";

export type { AuditResult, ClientId, Finding, Location, Severity } from "./types.js";
export type { ScanOptions } from "./sources.js";

/** Scans local MCP client configs and returns findings. Reads files only; never writes or sends anything. */
export function audit(options: Partial<ScanOptions> = {}): AuditResult {
  const opts: ScanOptions = {
    home: options.home ?? homedir(),
    cwd: options.cwd === undefined ? process.cwd() : options.cwd,
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
  };
  const d = discover(opts);
  const findings = runChecks(d, opts.home);
  const clients = [...new Set(d.files.map((f) => f.client))] as ClientId[];
  const graded = d.servers.length > 0 || findings.length > 0 ? score(findings) : null;
  return {
    files: d.files.map((f) => ({ client: f.client, path: f.path })),
    unreadable: d.unreadable,
    servers: d.servers.length,
    clients,
    findings,
    score: graded?.score ?? null,
    grade: graded?.grade ?? null,
  };
}
