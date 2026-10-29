import { counts } from "./report.js";
import type { AuditResult } from "./types.js";

const GRADE_COLOR: Record<string, string> = {
  A: "#69D5A0",
  B: "#69D5A0",
  C: "#F0BA7F",
  D: "#FF92A5",
  F: "#FF92A5",
};

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** One line for posting. Contains only counts, never names, paths or values. */
export function shareText(r: AuditResult): string {
  const c = counts(r.findings);
  const parts = [
    c.secrets && `${c.secrets} plaintext secret${c.secrets === 1 ? "" : "s"}`,
    `${r.servers} MCP server${r.servers === 1 ? "" : "s"} across ${r.clients.length} client${r.clients.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `My AI agents' MCP setup scored ${r.grade} (${r.score}/100): ${parts.join(", ")}. Check yours: npx toolstile audit`;
}

export const shareUrl = (r: AuditResult) => `https://x.com/intent/post?text=${encodeURIComponent(shareText(r))}`;

/** A 1200x630 social card. Contains only the grade and counts. */
export function renderCard(r: AuditResult): string {
  const c = counts(r.findings);
  const grade = r.grade ?? "–";
  const color = GRADE_COLOR[grade] ?? "#B2BDD1";
  const stats: [string, string][] = [
    [String(c.secrets), c.secrets === 1 ? "plaintext secret" : "plaintext secrets"],
    [String(c.high), "high-risk issues"],
    [String(r.servers), r.servers === 1 ? "MCP server" : "MCP servers"],
    [String(r.clients.length), r.clients.length === 1 ? "AI client" : "AI clients"],
  ];
  const font = "'IBM Plex Sans', 'Inter', 'Helvetica Neue', Arial, sans-serif";
  const mono = "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace";
  const statSvg = stats
    .map(
      ([value, label], i) => `
  <g transform="translate(${560 + (i % 2) * 300}, ${250 + Math.floor(i / 2) * 150})">
    <text font-family="${font}" font-size="64" font-weight="600" fill="#EEF2FA">${escape(value)}</text>
    <text y="40" font-family="${font}" font-size="24" fill="#B2BDD1">${escape(label)}</text>
  </g>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0E1320"/>
  <rect x="40" y="40" width="1120" height="550" rx="12" fill="#161D2D"/>
  <text x="96" y="130" font-family="${font}" font-size="30" font-weight="600" fill="#EEF2FA">My AI agents' MCP config</text>
  <text x="96" y="168" font-family="${font}" font-size="22" fill="#B2BDD1">Score ${r.score ?? "–"}/100</text>
  <text x="96" y="470" font-family="${font}" font-size="320" font-weight="700" fill="${color}">${escape(grade)}</text>${statSvg}
  <line x1="96" y1="520" x2="1104" y2="520" stroke="#364158"/>
  <text x="96" y="560" font-family="${mono}" font-size="26" fill="#7D97FF">npx toolstile audit</text>
  <text x="1104" y="560" text-anchor="end" font-family="${font}" font-size="22" fill="#B2BDD1">toolstile.com</text>
</svg>
`;
}
