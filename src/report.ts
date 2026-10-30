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
  const dim = wrap(2, 22);
  return {
    bold: wrap(1, 22),
    dim,
    sev: (sev, s) => (sev === "high" ? red(s) : sev === "medium" ? yellow(s) : sev === "low" ? blue(s) : dim(s)),
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
    info: findings.filter((f) => f.severity === "info").length,
    secrets: findings.filter((f) => f.rule === "plaintext-secret").reduce((n, f) => n + f.locations.length, 0),
  };
}

/**
 * Returns a copy safe to post publicly: the home folder becomes `~`, the scanned project folder
 * becomes `<project>`, and project paths inside pointers (Claude Code's `projects["/path"]`) are hidden.
 */
export function redact(r: AuditResult, home: string, project: string | null): AuditResult {
  const scrub = (text: string) => {
    let out = text.replace(/projects\["(?:[^"\\]|\\.)*"\]/g, 'projects["…"]');
    if (project) out = out.split(project).join("<project>");
    if (home) out = out.split(home).join("~");
    return out;
  };
  return {
    ...r,
    files: r.files.map((f) => ({ ...f, path: scrub(f.path) })),
    unreadable: r.unreadable.map((u) => ({ ...u, path: scrub(u.path), error: scrub(u.error) })),
    findings: r.findings.map((f) => ({
      ...f,
      title: scrub(f.title),
      subject: scrub(f.subject),
      note: scrub(f.note),
      detail: scrub(f.detail),
      fix: scrub(f.fix),
      locations: f.locations.map((l) => ({ file: scrub(l.file), pointer: scrub(l.pointer) })),
    })),
  };
}

/** How each kind of finding is explained once, above the places it was found. */
const GROUPS: Record<string, { heading: string; why: string; fix: string }> = {
  "plaintext-secret": {
    heading: "Plaintext secrets",
    why: "Anything that can read these files can use the credentials, including backups, dotfile syncs and other tools.",
    fix: "Move them into environment variables, or use the server's OAuth sign-in. Rotate any secret in a file that was shared or synced.",
  },
  "insecure-transport": {
    heading: "Unencrypted remote servers",
    why: "Requests, tool results and any credentials travel over plain http://.",
    fix: "Use the server's https:// endpoint.",
  },
  "privileged-container": {
    heading: "Containers with host-level access",
    why: "--privileged, the Docker socket and host networking give the server effective control of this machine.",
    fix: "Remove them unless the server truly needs them.",
  },
  "copied-secret": {
    heading: "Credentials copied into several files",
    why: "Rotating or revoking one of these means finding every copy.",
    fix: "Keep one copy in your environment or keychain and reference it from each client, or route the clients through one gateway.",
  },
  "readable-config": {
    heading: "Files with secrets that other accounts can read",
    why: "The file and every folder above it are open, so other accounts on this machine can read the secrets.",
    fix: "Restrict each file to your user with chmod 600.",
  },
  "unpinned-package": {
    heading: "Unpinned packages",
    why: "Each start runs whatever version is newest, so a compromised or broken release runs with the server's access.",
    fix: "Pin an exact version (an image digest or exact tag for Docker).",
  },
  "broad-filesystem": {
    heading: "Filesystem servers with broad access",
    why: "The allowed root includes SSH keys, cloud credentials and every other config file.",
    fix: "Allow only the project folders the agent needs.",
  },
  "auto-approved-tools": {
    heading: "Tools that run without asking",
    why: "A prompt injection in a web page, issue or email the agent reads can call these, including write and delete tools.",
    fix: "Approve specific read-only tools (mcp__server__tool) instead of whole servers.",
  },
};

/** Greedy word wrap; every line after the first starts with `indent`. Long words are kept whole. */
export function wrap(text: string, width: number, indent = ""): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const room = width - (lines.length ? indent.length : 0);
    if (line && line.length + 1 + word.length > room) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

const SEVERITIES: Severity[] = ["high", "medium", "low"];

export function renderReport(r: AuditResult, home: string, s: Style, redacted = false, columns = 80): string {
  // Wide terminals still get short lines: they are easier to read.
  const width = Math.max(40, Math.min(columns, 100) - 1);
  const para = (text: string, indent = "  ") => indent + wrap(text, width - indent.length, indent);
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

  if (r.grade !== null) {
    const c = counts(r.findings);
    const parts = [
      c.high && s.sev("high", `${c.high} high`),
      c.medium && s.sev("medium", `${c.medium} medium`),
      c.low && s.sev("low", `${c.low} low`),
    ].filter(Boolean);
    const summary = parts.length ? parts.join(s.dim(" · ")) : "no issues found";
    lines.push(`  ${s.bold(s.grade(r.grade, `Grade ${r.grade}`))}  ${s.dim(`${r.score}/100`)}   ${summary}`);
  }
  const clientList = r.clients.map((c) => CLIENT_NAMES[c]).join(", ");
  lines.push(s.dim(para(`${plural(r.servers, "MCP server")} in ${plural(r.files.length, "file")} from ${clientList}`)));
  for (const u of r.unreadable) {
    lines.push(s.dim(para(`Skipped ${tildify(u.path, home)} (${CLIENT_NAMES[u.client]}): ${u.error}.`)));
  }
  lines.push("");

  // One block per kind of problem: what it is and how to fix it once, then each place it was found.
  for (const severity of SEVERITIES) {
    const byRule = new Map<string, Finding[]>();
    for (const f of r.findings) if (f.severity === severity) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
    for (const [rule, list] of byRule) {
      const group = GROUPS[rule];
      const tag = s.sev(severity, severity.toUpperCase());
      lines.push(`${tag}  ${s.bold(group?.heading ?? list[0]!.title)} ${s.dim(`(${list.length})`)}`);
      lines.push(para(group?.why ?? list[0]!.detail), "");
      for (const f of list) {
        const note = f.note ? `  ${s.dim(f.note)}` : "";
        lines.push(`  ${s.sev(severity, "•")} ${tildify(f.subject, home)}${note}`);
        const shown = f.locations.filter((l) => l.file !== f.subject).slice(0, 4);
        for (const l of shown) {
          const where = `${tildify(l.file, home)}  ${l.pointer}`;
          lines.push(s.dim(where.length <= width - 4 ? `    ${where}` : para(where, "    ")));
        }
        const hidden = f.locations.filter((l) => l.file !== f.subject).length - shown.length;
        if (hidden > 0) lines.push(s.dim(`    … and ${hidden} more`));
      }
      lines.push("", `  ${s.bold("Fix")} ${wrap(group?.fix ?? list[0]!.fix, width - 6, "      ")}`, "");
    }
  }

  const info = r.findings.filter((f) => f.severity === "info");
  if (info.length) {
    lines.push(s.dim("Also set up in more than one client (not scored):"));
    for (const f of info) lines.push(s.dim(para(`${f.subject}: ${f.note}`)));
    lines.push("");
  }

  if (r.findings.some((f) => f.severity !== "info"))
    lines.push(`${s.bold("Fix them:")} npx toolstile audit --fix ${s.dim("(shows every change; you pick which to apply)")}`, "");
  lines.push(s.dim("Secret values are never printed."));
  if (!redacted) lines.push(s.dim(wrap("Posting this? Run with --redact to hide your paths, or --card for an image with only the grade.", width)));
  else lines.push(s.dim("Share an image with only the grade: npx toolstile audit --card"));
  lines.push(s.dim(wrap("Keep credentials off your machines and control each agent's tools: https://toolstile.com/?ref=cli", width)), "");
  return lines.join("\n");
}

/** JSON output for scripts. Paths are included unless redacted; secret values never are. */
export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2) + "\n";
}
