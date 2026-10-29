import { CLIENT_NAMES } from "./sources.js";
import type { AuditResult, Finding, Severity } from "./types.js";

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  sev(sev: Severity, s: string): string;
  grade(grade: string, s: string): string;
}

export function style(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const red = wrap(31, 39);
  const yellow = wrap(33, 39);
  const blue = wrap(34, 39);
  const green = wrap(32, 39);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    sev: (sev, s) => (sev === "high" ? red(s) : sev === "medium" ? yellow(s) : blue(s)),
    grade: (g, s) => (g === "A" || g === "B" ? green(s) : g === "C" ? yellow(s) : red(s)),
  };
}

export const tildify = (path: string, home: string) =>
  home && (path === home || path.startsWith(home + "/") || path.startsWith(home + "\\")) ? "~" + path.slice(home.length) : path;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function counts(findings: Finding[]) {
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    secrets: findings.filter((f) => f.rule === "plaintext-secret").reduce((n, f) => n + f.locations.length, 0),
  };
}

export function renderReport(r: AuditResult, home: string, s: Style): string {
  const lines: string[] = [];
  lines.push("", `${s.bold("toolstile audit")} ${s.dim("· local MCP config check · nothing leaves this machine")}`, "");

  if (r.files.length === 0 && r.unreadable.length === 0) {
    lines.push(
      "No MCP client configs found.",
      s.dim("Looked for Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf, Gemini CLI and Cline."),
      "",
    );
    return lines.join("\n");
  }

  const clientList = r.clients.map((c) => CLIENT_NAMES[c]).join(", ");
  lines.push(`Scanned ${plural(r.files.length, "file")} from ${clientList}: ${plural(r.servers, "MCP server")}.`);
  for (const u of r.unreadable) {
    lines.push(s.dim(`Skipped ${tildify(u.path, home)} (${CLIENT_NAMES[u.client]}): could not parse it.`));
  }
  lines.push("");

  if (r.grade !== null) {
    const c = counts(r.findings);
    const summary = r.findings.length
      ? [c.high && s.sev("high", `${c.high} high`), c.medium && s.sev("medium", `${c.medium} medium`), c.low && s.sev("low", `${c.low} low`)]
          .filter(Boolean)
          .join(s.dim(" · "))
      : "no issues found";
    lines.push(`  ${s.bold(s.grade(r.grade, `Grade ${r.grade}`))}  ${s.dim(`${r.score}/100`)}   ${summary}`, "");
  }

  for (const f of r.findings) {
    const tag = s.sev(f.severity, f.severity.toUpperCase().padEnd(6));
    lines.push(`${tag} ${s.bold(f.title)}`);
    lines.push(`       ${f.detail}`);
    const shown = f.locations.slice(0, 5);
    for (const l of shown) lines.push(s.dim(`       ${tildify(l.file, home)}  ${l.pointer}`));
    if (f.locations.length > shown.length) lines.push(s.dim(`       … and ${f.locations.length - shown.length} more`));
    lines.push(`       ${s.dim("Fix:")} ${f.fix}`, "");
  }

  lines.push(
    s.dim("Secret values are never printed. Share your grade (no secrets, no paths): npx toolstile audit --card"),
    s.dim("Keep credentials off your machines and control each agent's tools: https://toolstile.com/?ref=cli"),
    "",
  );
  return lines.join("\n");
}

/** JSON output for scripts. Paths are included; secret values never are. */
export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2) + "\n";
}
