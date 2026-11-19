#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createApi } from "./api.js";
import { renderCard, shareText, shareUrl } from "./card.js";
import { type Context, login, logout, proxy, setup, status, UserError, whoami } from "./commands.js";
import { runFix } from "./fix.js";
import { install, passthrough, ServerError, split, start, uninstall, upgrade, type ServerContext } from "./server.js";
import { audit } from "./index.js";
import { redact, renderJson, renderReport, style } from "./report.js";
import type { Severity } from "./types.js";

const HELP = `toolstile: audit your MCP configs and connect your agents to Toolstile

Usage
  npx toolstile audit [options]     Check local MCP configs (offline, read-only)
  npx toolstile audit --fix         Review suggested fixes and apply the ones you pick
  npx toolstile auth login          Sign in, from any machine, with a code
  npx toolstile auth logout         Sign out on this machine
  npx toolstile auth status         List the servers this machine is signed in to
  npx toolstile whoami              Show the account on the current server
  npx toolstile mcp setup           Choose which agents here use Toolstile
  npx toolstile server start        Run your own Toolstile on this machine

The auth, whoami and mcp commands work with Toolstile Cloud (the default), a
self-hosted server (--server <url>) or the server on this machine (--local).

Run toolstile <command> --help for a command's options.
  -h, --help          Show this help
  -v, --version       Show the version
`;

const AUDIT_HELP = `toolstile audit: check the MCP server configs your AI agents use

Usage
  npx toolstile audit [options]

Checks Claude Code, Claude Desktop, Cursor, Codex, VS Code, Windsurf,
Devin Desktop, Gemini CLI, Cline, Grok Build, OpenCode, Kiro and Antigravity
configs for plaintext secrets, credentials copied between clients, unpinned packages, auto-approved tools, broad
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
  -y, --yes           With --fix: apply the fixes that start selected, without asking
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
  npx toolstile auth login [--server <url> | --local] [--no-browser]
  npx toolstile auth logout [--server <url> | --local | --all]
  npx toolstile auth status [--json]
  npx toolstile whoami [--server <url> | --local] [--json]

login prints a link and a code. Open the link on any device with a browser
(your laptop, your phone), sign in and approve the code. Nothing has to
reach this machine, so it works over SSH and on servers without a browser.

The CLI keeps one sign-in per server. The last server you signed in to is the
current one; commands use it unless --server, --local or TOOLSTILE_SERVER
picks another. logout signs out of the current server, status lists every
saved sign-in and whoami shows the account on the current server.

Servers
  Toolstile Cloud     https://app.toolstile.com (the default)
  Self-hosted         --server https://toolstile.example.com
  On this machine     --local: the origin in instance.json in
                      TOOLSTILE_DATA_DIR (default ~/.local/share/toolstile),
                      else http://127.0.0.1:4310
  Plain http:// works only for localhost, 127.0.0.0/8 and [::1].

Options
  --server <url>      Use this Toolstile server
  --local             Use the self-hosted server on this machine
  --no-browser        login: do not try to open a browser on this machine
  --all               logout: sign out of every server
  --json              status, whoami: print JSON

Environment
  TOOLSTILE_SERVER    Server to use when no flag picks one (TOOLSTILE_URL also works)
`;

const MCP_HELP = `toolstile mcp: connect the agents on this machine to Toolstile

Usage
  npx toolstile mcp setup [options]
  npx toolstile mcp proxy --agent <agent>

setup lists the agents found here and lets you turn each one on or off.
It signs in first, the same way as auth login, when this machine is not
signed in to the server yet. Each agent uses one server; agents on this
machine can use different servers. Each enabled agent gets its own access, shown
under this device in the Toolstile dashboard. Its config runs
\`toolstile mcp proxy\`, which holds the agent's token in the CLI's own
owner-only credentials file, so no secret is written into the agent's config.

Options for setup
  --enable <agents>     Turn these on without prompting (comma-separated)
  --disable <agents>    Turn these off without prompting
  --workspace <slug>    Toolstile Cloud workspace the agents use (default: the
                        last one, or personal); self-hosted servers have none
  --device-name <name>  Name for this machine (default: its hostname)
  --server <url>        Use this server (default: the current one, or
                        TOOLSTILE_SERVER); signs in if needed
  --local               Use the self-hosted server on this machine
  --switch              Move agents that use another server to this one
                        without asking (needed without a terminal)
  --no-browser          Do not try to open a browser when signing in

proxy always talks to the server that issued the agent's token; --server,
--local and TOOLSTILE_SERVER do not change it.

Agents: claude-code, claude-desktop, cursor, codex, vscode, windsurf, devin, gemini, cline,
grok, opencode, kiro, antigravity
`;

const SERVER_HELP = `toolstile server: run your own Toolstile on this machine

Usage
  npx toolstile server start [--email <you@example.com>] [options]
  npx toolstile server install [--release <tag>] [--from <file>]
  npx toolstile server upgrade [--release <tag>] [--from <file>]
  npx toolstile server uninstall
  npx toolstile server <bootstrap|operator|backup|restore|init|version> ...

start downloads toolstile-server, a single executable with its own database,
on first use. On a new instance it asks for your email and prints an
invitation link, then runs the server until you press Ctrl-C. Open the link,
create your account and follow the guided setup.

upgrade refuses while the server is running, backs up the instance first and
keeps the executable it replaces. uninstall keeps your data. Other commands
run toolstile-server directly; see its local operation guide:
https://github.com/toolstile/toolstile/blob/main/docs/local-operation.md

Options for start
  --email <address>    Invite this account without asking
  --data-dir <path>    Instance folder (default ~/.local/share/toolstile, or TOOLSTILE_DATA_DIR)
  --origin <url>       New instance only: its address (default http://127.0.0.1:4310)
  --listen <address>   New instance only: interface to listen on (default 127.0.0.1)
  --port <port>        New instance only: port (default 4310)

Options for install and upgrade
  --release <tag>      A specific release (default: the latest)
  --from <file>        Install a toolstile-server you built or downloaded yourself
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
  const actions = group === "auth" ? ["login", "logout", "status", "whoami"] : ["setup", "proxy"];
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
        ? parseFlags(rest, ["server"], ["local", "no-browser"])
        : action === "logout"
          ? parseFlags(rest, ["server"], ["local", "all"])
          : action === "status"
            ? parseFlags(rest, [], ["json"])
            : action === "whoami"
              ? parseFlags(rest, ["server"], ["local", "json"])
              : action === "setup"
                ? parseFlags(rest, ["enable", "disable", "workspace", "device-name", "server"], ["no-browser", "local", "switch"])
                : parseFlags(rest, ["agent"], []);
    if (flags === "help") {
      process.stdout.write(help);
      return 0;
    }
    const value = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
    const target = { server: value("server"), local: flags.local === true };
    if (action === "login") return await login(ctx, { ...target, browser: !flags["no-browser"] });
    if (action === "logout") return await logout(ctx, { ...target, all: flags.all === true });
    if (action === "status") return status(ctx, { json: flags.json === true });
    if (action === "whoami") return whoami(ctx, { ...target, json: flags.json === true });
    if (action === "setup")
      return await setup(ctx, {
        enable: value("enable"),
        disable: value("disable"),
        workspace: value("workspace"),
        deviceName: value("device-name"),
        ...target,
        browser: !flags["no-browser"],
        switch: flags.switch === true,
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

async function server(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "-h" || action === "--help" || action === "help") {
    process.stdout.write(SERVER_HELP);
    return action ? 0 : 2;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    if (["start", "install", "upgrade", "uninstall"].includes(action)) {
      process.stdout.write(SERVER_HELP);
      return 0;
    }
  }
  const ctx: ServerContext = {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    fetch: (...args) => fetch(...args),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    style: style(process.stderr.isTTY === true && !process.env.NO_COLOR),
  };
  try {
    if (action === "start") return await start(ctx, rest);
    if (action === "install") {
      const { own, rest: unknown } = split(rest, ["--release", "--from"]);
      if (unknown.length) throw new ServerError(`Unknown option: ${unknown[0]}`);
      await install(ctx, { release: own["--release"], from: own["--from"] });
      return 0;
    }
    if (action === "upgrade") return await upgrade(ctx, rest);
    if (action === "uninstall") return uninstall(ctx);
    return await passthrough(ctx, argv);
  } catch (error) {
    if (error instanceof ServerError) {
      process.stderr.write(`toolstile: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "whoami") return command(["auth", ...argv]);
  if (argv[0] === "auth" || argv[0] === "mcp") return command(argv);
  if (argv[0] === "server") return server(argv.slice(1));
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
