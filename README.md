# toolstile

Check the MCP server configs your AI agents use, in one command:

```sh
npx toolstile audit
```

It reads the configs of Claude Code, Claude Desktop, Cursor, Codex, VS Code,
Windsurf, Gemini CLI and Cline and grades them for:

| Check | Severity |
| --- | --- |
| API keys, tokens and passwords written into config files, URLs or arguments | high |
| Remote servers reached over plain `http://` | high |
| Containers run with `--privileged` or the Docker socket | high |
| The same credential pasted into several clients' configs | medium |
| Config files holding secrets that other accounts can reach (file and folder permissions) | medium |
| `npx`, `uvx` and `docker` servers that run whatever version is newest | medium |
| Filesystem servers that can read your whole home folder or disk | medium |
| Permission rules that approve every tool of a server without asking | medium |
| Tools on a client's auto-approve list | low |

It also lists servers set up separately in several clients. That is context, not
scored: remote servers need an entry per client.

```text
toolstile audit · local MCP config check · nothing leaves this machine

Scanned 4 files from Claude Code, Cursor, Codex: 10 MCP servers.

  Grade B  77/100   1 high · 1 medium · 1 low

HIGH   Plaintext secret in github (Cursor)
       A GitHub token is written directly into the config file. Anything that can
       read the file, including backups, dotfile syncs and other tools, can use it.
       ~/.cursor/mcp.json  mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN
       Fix: Reference an environment variable instead (for example ${API_TOKEN}) …
```

## The audit only reads

- Reads config files on your machine. Writes nothing unless you ask for a card.
- Makes no network requests and collects no telemetry. (Only the separate
  `auth` and `mcp` commands below talk to Toolstile, and only when you run them.)
- Never prints, stores or sends secret values. Findings name the file and key,
  for example `mcpServers.github.env.GITHUB_TOKEN`, and the kind of secret.
- Never quotes a config file: one that cannot be read or parsed is listed with a
  reason and position only, for example `invalid TOML at line 3, column 12`.
- About 2,500 lines of TypeScript with one runtime dependency
  ([smol-toml](https://github.com/squirrelchat/smol-toml), for Codex's TOML
  config) and an optional one ([resvg-js](https://github.com/thx/resvg-js), only
  to render `--card` as PNG). Read it before you run it.

## Options

```text
--json              Print results as JSON
--card [file]       Write a shareable grade card (default toolstile-audit.png;
                    use a .svg name for SVG). Contains only the grade and counts.
--redact            Hide your home folder and project paths, for posting the output
--project <dir>     Also scan project configs in <dir> (default: current directory)
--no-project        Scan only user-level configs
--fail-on <level>   Exit with code 1 if any finding is at or above high, medium or low
```

`--fail-on high` makes it usable in CI or a pre-commit hook for repositories that
check in `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | The audit ran, and no finding reached the `--fail-on` level (or `--fail-on` was not set) |
| 1 | A finding is at or above the `--fail-on` level |
| 2 | Invalid options, or the audit itself failed |

## Scoring

Each distinct problem has a weight: 10 for a leaked secret, plain-http remote or
privileged container; 4 for readable secret files, unpinned packages, broad
filesystem access and whole-server auto-approval; 2 for each copied secret; 1 for
auto-approved tools. A secret pasted into several files counts as one leak. The
score is `100 / (1 + weight / 50)`: one leaked secret scores 83 (B), four score
about 56 (D). Grades: A 90+, B 75+, C 60+, D 40+, F below 40.

## Share your grade

```sh
npx toolstile audit --card
```

writes a 1200×630 image with your grade and counts (no server names, paths or
values) and prints a ready-to-post link. To post the text report instead, add
`--redact` so it shows `~` and `<project>` in place of your folders.

## Files it reads

| Client | User config | Project config |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, `~/.claude/settings.json` | `.mcp.json`, `.claude/settings*.json` |
| Claude Desktop | `claude_desktop_config.json` in the app's config folder | |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Codex | `$CODEX_HOME/config.toml` (default `~/.codex`) | `.codex/config.toml` |
| VS Code | user `settings.json` and `mcp.json` | `.vscode/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Cline | `cline_mcp_settings.json` in VS Code or Cursor storage | |

## Connect your agents to Toolstile

If you use [Toolstile](https://toolstile.com), the CLI can also sign in and set
up the agents on a machine for you:

```sh
npx toolstile auth login
npx toolstile mcp setup
```

`auth login` prints a link and a code. Open the link on any device with a
browser (your laptop or phone) and sign in. The page fills in the code and this
machine's name; edit the name if you like, check the code matches and approve.
The machine appears under that name in the Toolstile dashboard. Nothing has to
reach the machine you are signing in, so it works over SSH, in containers and on
servers without a browser.

`mcp setup` lists the agents it finds (Claude Code, Claude Desktop, Cursor,
Codex, VS Code, Windsurf, Gemini CLI, Cline) and lets you turn each one on or
off. Run it again any time to change the selection. Each enabled agent appears
under this machine in the Toolstile dashboard with its own access, so you can
grant, limit or revoke it there; then choose which MCP servers it can use.

```text
Which agents on this machine should use Toolstile?
› ◉ Claude Code  ~/.claude.json
  ○ Cursor  ~/.cursor/mcp.json
  ◉ Codex  ~/.codex/config.toml
↑/↓ move · space toggle · a all · enter save · esc cancel
```

Without a terminal, pass the choice as flags:
`npx toolstile mcp setup --enable claude-code,codex --disable cursor`.

How it stays out of your configs: an enabled agent's config gets a `toolstile`
server that runs `npx -y toolstile@<version> mcp proxy --agent <agent>`. The proxy
relays the agent's MCP messages to Toolstile using that agent's own token, which
lives only in the CLI's credentials file (`~/.config/toolstile/credentials.json`,
readable by you alone; `%APPDATA%\toolstile` on Windows). No token is written
into the agent's config, so `toolstile audit` has nothing to flag. JSON configs
with comments are not rewritten; setup prints the entry to add yourself.

`npx toolstile auth logout` ends the CLI's sign-in. Agents you enabled keep
working until you turn them off with `mcp setup` or delete the device in the
dashboard.

| Option | Command | Meaning |
| --- | --- | --- |
| `--server <url>` | `auth login` | Toolstile address (default `https://toolstile.com`, or `TOOLSTILE_URL`) |
| `--no-browser` | `auth login` | Do not try to open a browser on this machine |
| `--enable <agents>` | `mcp setup` | Turn these on without prompting (comma-separated) |
| `--disable <agents>` | `mcp setup` | Turn these off without prompting |
| `--workspace <slug>` | `mcp setup` | Workspace the agents use (default: the last one, or personal) |
| `--device-name <name>` | `mcp setup` | Name for this machine in the dashboard (default: its hostname) |

## Use it from code

```ts
import { audit } from "toolstile";

const { grade, findings } = audit();
```

## About

Built by [Akshit Kr Nagpal](https://akshit.io) as part of
[Toolstile](https://toolstile.com), an MCP gateway that keeps upstream
credentials off your machines and lets you choose which tools each agent can use.
The audit works on its own and does not require a Toolstile account.

Questions and reports: support@toolstile.com.

## Releases

The npm package is published by [GitHub Actions](.github/workflows/publish.yml)
with npm trusted publishing and provenance, so each release links back to the
commit and workflow that built it. No npm token is stored anywhere.

## License

[MIT](LICENSE)
