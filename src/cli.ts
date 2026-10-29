#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { renderCard, shareText, shareUrl } from "./card.js";
import { audit } from "./index.js";
import { redact, renderJson, renderReport, style } from "./report.js";
import type { Severity } from "./types.js";

const HELP = `toolstile: audit the MCP server configs your AI agents use

Usage
  npx toolstile audit [options]

Checks Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf,
Gemini CLI and Cline configs for plaintext secrets, credentials copied
between clients, unpinned packages, auto-approved tools, broad
filesystem access and unencrypted remote servers.

It only reads files. It sends nothing over the network and never
prints secret values.

Options
  --json              Print results as JSON
  --card [file]       Write a shareable grade card (default toolstile-audit.png;
                      use a .svg name for SVG). Contains only the grade and counts.
  --redact            Hide your home folder and project paths, for posting the output
  --project <dir>     Also scan project configs in <dir> (default: current directory)
  --no-project        Scan only user-level configs
  --fail-on <level>   Exit with code 1 if any finding is at or above high, medium or low
  -h, --help          Show this help
  -v, --version       Show the version
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

interface Args {
  json: boolean;
  redact: boolean;
  card: string | null;
  project: string | null;
  failOn: Severity | null;
}

function parseArgs(argv: string[]): Args | "help" | "version" {
  const args: Args = { json: false, redact: false, card: null, project: process.cwd(), failOn: null };
  const rest = [...argv];
  if (rest[0] === "audit") rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => {
      const v = inline ?? rest[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
      case "help":
        return "help";
      case "-v":
      case "--version":
        return "version";
      case "--json":
        args.json = true;
        break;
      case "--redact":
        args.redact = true;
        break;
      case "--card": {
        const next = inline ?? rest[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          args.card = next;
          if (inline === undefined) i++;
        } else {
          args.card = "toolstile-audit.png";
        }
        break;
      }
      case "--project":
        args.project = resolve(value());
        break;
      case "--no-project":
        args.project = null;
        break;
      case "--fail-on": {
        const v = value();
        if (v !== "high" && v !== "medium" && v !== "low") throw new Error("--fail-on must be high, medium or low");
        args.failOn = v;
        break;
      }
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  return args;
}

async function writeCard(path: string, svg: string): Promise<string> {
  if (path.toLowerCase().endsWith(".svg")) {
    writeFileSync(path, svg);
    return path;
  }
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const png = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
    writeFileSync(path, png);
    return path;
  } catch {
    // The optional PNG renderer is unavailable on this platform; fall back to SVG.
    const fallback = path.replace(/\.[^./\\]+$/, "") + ".svg";
    writeFileSync(fallback, svg);
    return fallback;
  }
}

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args === "version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const home = homedir();
  const raw = audit({ home, cwd: args.project });
  const result = args.redact ? redact(raw, home, args.project) : raw;
  const color = !args.json && process.stdout.isTTY === true && !process.env.NO_COLOR;
  const s = style(color);

  if (args.json) process.stdout.write(renderJson(result));
  else process.stdout.write(renderReport(result, home, s, args.redact));

  if (args.card) {
    if (result.grade === null) {
      process.stderr.write("No MCP servers found, so there is no grade to put on a card.\n");
    } else {
      const written = await writeCard(resolve(args.card), renderCard(result));
      const out = args.json ? process.stderr : process.stdout;
      out.write(`Card written to ${written}\n\n${shareText(result)}\n\nPost it: ${shareUrl(result)}\n`);
    }
  }

  if (args.failOn) {
    const threshold = RANK[args.failOn];
    if (result.findings.some((f) => RANK[f.severity] >= threshold)) return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`toolstile: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(2);
  },
);
