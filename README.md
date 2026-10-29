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
| Config files holding secrets that other users can read | medium |
| `npx`, `uvx` and `docker` servers that run whatever version is newest | medium |
| Filesystem servers that can read your whole home folder or disk | medium |
| Permission rules that approve every tool of a server without asking | medium |
| Tools on a client's auto-approve list | low |
| The same server set up separately in several clients | low |

```text
toolstile audit · local MCP config check · nothing leaves this machine

Scanned 4 files from Claude Code, Cursor, Codex: 10 MCP servers.

  Grade C  67/100   1 high · 2 medium · 3 low

HIGH   Plaintext secret in github (Cursor)
       A GitHub token is written directly into the config file. Anything that can
       read the file, including backups, dotfile syncs and other tools, can use it.
       ~/.cursor/mcp.json  mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN
       Fix: Reference an environment variable instead (for example ${API_TOKEN}) …
```

## It only reads

- Reads config files on your machine. Writes nothing unless you ask for a card.
- Makes no network requests and collects no telemetry.
- Never prints, stores or sends secret values. Findings name the file and key,
  for example `mcpServers.github.env.GITHUB_TOKEN`, and the kind of secret.
- About 1,100 lines of TypeScript with one runtime dependency
  ([smol-toml](https://github.com/squirrelchat/smol-toml), for Codex's TOML
  config) and an optional one ([resvg-js](https://github.com/thx/resvg-js), only
  to render `--card` as PNG). Read it before you run it.

## Options

```text
--json              Print results as JSON
--card [file]       Write a shareable grade card (default toolstile-audit.png;
                    use a .svg name for SVG). Contains only the grade and counts.
--project <dir>     Also scan project configs in <dir> (default: current directory)
--no-project        Scan only user-level configs
--fail-on <level>   Exit with code 1 if any finding is at or above high, medium or low
```

`--fail-on high` makes it usable in CI or a pre-commit hook for repositories that
check in `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json`.

## Share your grade

```sh
npx toolstile audit --card
```

writes a 1200×630 image with your grade and counts (no server names, paths or
values) and prints a ready-to-post link.

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

## License

[MIT](LICENSE)
