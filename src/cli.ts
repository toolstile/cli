#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createApi } from "./api.js";
import { renderCard, shareText, shareUrl } from "./card.js";
import { type Context, login, logout, proxy, setup, UserError } from "./commands.js";
import { runFix } from "./fix.js";
import { audit } from "./index.js";
import { redact, renderJson, renderReport, style } from "./report.js";
import type { Severity } from "./types.js";

const HELP = `toolstile: audit your MCP configs and connect your agents to Toolstile

Usage
  npx toolstile audit [options]     Check local MCP configs (offline, read-only)
  npx toolstile audit --fix         Review suggested fixes and apply the ones you pick
  npx toolstile auth login          Sign in, from any machine, with a code
  npx toolstile auth logout         Sign out on this machine
  npx toolstile mcp setup           Choose which agents here use Toolstile

Run toolstile <command> --help for a command's options.
  -h, --help          Show this help
  -v, --version       Show the version
`;

const AUDIT_HELP = `toolstile audit: check the MCP server configs your AI agents use

Usage
  npx toolstile audit [options]

Checks Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf,
Gemini CLI and Cline configs for plaintext secrets, credentials copied
between clients, unpinned packages, auto-approved tools, broad
filesystem access and unencrypted remote servers.

It only reads files. It sends nothing over the network and never
prints secret values.

With --fix it lists every change it can make, then applies the ones
you select:
  - moves plaintext secrets into environment variables, saved in an
    owner-only file your shell loads, and references them from the config
  - restricts config files that hold secrets to your user (chmod 600)
  - pins unpinned npm and PyPI packages to their current version (the
    only network use: it looks those versions up on npm and PyPI)
  - removes rules that approve whole servers without asking (off at first)
Original files are backed up before they change. Findings it cannot fix
safely are listed with what to do by hand.

Options
  --fix               Suggest fixes and apply the ones you select
  --yes               With --fix: apply the fixes that start selected, without asking
  --dry-run           With --fix: only show the changes
  --json              Print results as JSON
  --card [file]       Write a shareable grade card (default toolstile-audit.png;
                      use a .svg name for SVG). Contains only the grade and counts.
  --redact            Hide your home folder and project paths, for posting the output
  --project <dir>     Also scan project configs in <dir> (default: current directory)
  --no-project        Scan only user-level configs
  --fail-on <level>   Exit with code 1 if any finding is at or above high, medium or low
`;

const AUTH_HELP = `toolstile auth: sign the CLI in to Toolstile

Usage
  npx toolstile auth login [--server <url>] [--no-browser]
  npx toolstile auth logout

login prints a link and a code. Open the link on any device with a browser
(your laptop, your phone), sign in and approve the code. Nothing has to
reach this machine, so it works over SSH and on servers without a browser.

Options
  --server <url>      Toolstile address (default https://toolstile.com, or TOOLSTILE_URL)
  --no-browser        Do not try to open a browser on this machine
`;

const MCP_HELP = `toolstile mcp: connect the agents on this machine to Toolstile

Usage
  npx toolstile mcp setup [options]
  npx toolstile mcp proxy --agent <agent>

setup lists the agents found here and lets you turn each one on or off.
Each enabled agent gets its own access, shown under this device in the
Toolstile dashboard. Its config runs \`toolstile mcp proxy\`, which holds the
agent's token in the CLI's own owner-only credentials file, so no secret
is written into the agent's config.

Options for setup
  --enable <agents>     Turn these on without prompting (comma-separated)
  --disable <agents>    Turn these off without prompting
  --workspace <slug>    Workspace the agents use (default: the last one, or personal)
  --device-name <name>  Name for this machine (default: its hostname)

Agents: claude-code, claude-desktop, cursor, codex, vscode, windsurf, gemini, cline
`;

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

interface Args {
  fix: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  redact: boolean;
  card: string | null;
  project: string | null;
  failOn: Severity | null;
}

function parseArgs(argv: string[]): Args | "help" | "version" {
  const args: Args = { fix: false, yes: false, dryRun: false, json: false, redact: false, card: null, project: process.cwd(), failOn: null };
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
      case "--fix":
        args.fix = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
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
  if ((args.yes || args.dryRun) && !args.fix) throw new Error(`${args.yes ? "--yes" : "--dry-run"} only works with --fix`);
  if (args.fix && (args.json || args.card || args.redact || args.failOn))
    throw new Error("--fix cannot be combined with --json, --card, --redact or --fail-on");
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

/** `--name value`, `--name=value` and boolean `--name` flags for the auth and mcp commands. */
function parseFlags(argv: string[], valued: string[], booleans: string[]) {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") return "help" as const;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? (eq === -1 ? a.slice(2) : a.slice(2, eq)) : "";
    if (valued.includes(name)) {
      const v = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v.startsWith("-")) throw new UserError(`--${name} needs a value`);
      flags[name] = v;
    } else if (booleans.includes(name) && eq === -1) flags[name] = true;
    else throw new UserError(`Unknown option: ${a}`);
  }
  return flags;
}

async function command(argv: string[]): Promise<number> {
  const [group, action, ...rest] = argv;
  const help = group === "auth" ? AUTH_HELP : MCP_HELP;
  const actions = group === "auth" ? ["login", "logout"] : ["setup", "proxy"];
  if (!action || action === "-h" || action === "--help" || action === "help") {
    process.stdout.write(help);
    return action ? 0 : 2;
  }
  if (!actions.includes(action)) {
    process.stderr.write(`Unknown command: toolstile ${group} ${action}\n\n${help}`);
    return 2;
  }
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const ctx: Context = {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    version: version(),
    api: (server) => createApi(server),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    // The proxy's stdout carries MCP messages, so nothing else may be printed there.
    style: style(action !== "proxy" && color),
  };
  try {
    const flags =
      action === "login"
        ? parseFlags(rest, ["server"], ["no-browser"])
        : action === "logout"
          ? parseFlags(rest, [], [])
          : action === "setup"
            ? parseFlags(rest, ["enable", "disable", "workspace", "device-name"], [])
            : parseFlags(rest, ["agent"], []);
    if (flags === "help") {
      process.stdout.write(help);
      return 0;
    }
    const value = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
    if (action === "login") return await login(ctx, { server: value("server"), browser: !flags["no-browser"] });
    if (action === "logout") return await logout(ctx);
    if (action === "setup")
      return await setup(ctx, {
        enable: value("enable"),
        disable: value("disable"),
        workspace: value("workspace"),
        deviceName: value("device-name"),
      });
    return await proxy(ctx, value("agent"));
  } catch (error) {
    if (error instanceof UserError || (error as Error).name === "ApiError") {
      process.stderr.write(`toolstile: ${(error as Error).message}\n`);
      return 1;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "auth" || argv[0] === "mcp") return command(argv);
  const help = argv[0] === "audit" ? AUDIT_HELP : HELP;
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${help}`);
    return 2;
  }
  if (args === "help") {
    process.stdout.write(help);
    return 0;
  }
  if (args === "version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const home = homedir();
  if (args.fix) {
    return runFix({
      home,
      cwd: args.project,
      platform: process.platform,
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      style: style(process.stdout.isTTY === true && !process.env.NO_COLOR),
      yes: args.yes,
      dryRun: args.dryRun,
    });
  }
  const raw = audit({ home, cwd: args.project });
  const result = args.redact ? redact(raw, home, args.project) : raw;
  const color = !args.json && process.stdout.isTTY === true && !process.env.NO_COLOR;
  const s = style(color);

  if (args.json) process.stdout.write(renderJson(result));
  else process.stdout.write(renderReport(result, home, s, args.redact, process.stdout.columns || 80));

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
