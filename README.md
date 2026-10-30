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

  Grade C  71/100   2 high · 1 medium
  10 MCP servers in 4 files from Claude Code, Cursor, Codex

HIGH  Plaintext secrets (2)
  Anything that can read these files can use the credentials, including
  backups, dotfile syncs and other tools.

  • github (Cursor)  GitHub token
    ~/.cursor/mcp.json  mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN
  • linear (Claude Code)  authorization header
    ~/.claude.json  mcpServers.linear.headers.Authorization

  Fix Move them into environment variables, or use the server's OAuth sign-in.
      Rotate any secret in a file that was shared or synced.
…
Fix them: npx toolstile audit --fix (shows every change; you pick which to apply)
```

## Fix what it finds

```sh
npx toolstile audit --fix
```

lists every change it can make, as a diff with secret values hidden, then lets
you pick which to apply (space toggles, enter applies):

```text
  1.  HIGH   github (Cursor): move secret to $GITHUB_PERSONAL_ACCESS_TOKEN
             ~/.cursor/mcp.json  mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN
             - "••••"
             + "${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
  2.  MEDIUM linear (Claude Code): pin linear-mcp to 1.4.2
             ~/.claude.json  mcpServers.linear.args[1]
             - "linear-mcp"
             + "linear-mcp@1.4.2"
```

| Finding | What `--fix` does |
| --- | --- |
| Plaintext secret in `env` or a header | Replaces the value with a variable reference in the client's own syntax (`${NAME}` for Claude Code and Gemini CLI, `${env:NAME}` for Cursor, VS Code and Windsurf, `env_vars` / `bearer_token_env_var` / `env_http_headers` for Codex). The value goes into `~/.config/toolstile/secrets.env` (mode 600), and one line in your shell profile (`~/.zshrc`, `~/.bash_profile` or `~/.bashrc`, `~/.profile`, or fish's `conf.d`) loads it. A secret shared by several clients becomes one variable. |
| Config file with secrets readable by other accounts | `chmod 600` |
| Unpinned npm or PyPI package | Pins the version that is current now, looked up on npm or PyPI |
| Rule that approves a whole server, or `enableAllProjectMcpServers` | Removes it. These start unselected, since the agent then asks before each tool. |

Everything else (secrets in arguments or URLs, Claude Desktop and Cline, which
cannot read variables, Windows, `http://` servers, Docker images, broad
filesystem roots and auto-approve lists) is listed with what to change by hand.

Each edited file is checked before it is written: it must parse to exactly the
planned result, or it is left alone. JSON files keep their comments and layout;
a Codex server's table is rewritten in place. The original files are copied to
`~/.config/toolstile/backups/` first. They still hold the old secrets, so delete
them once your agents work. After moving secrets, open a new terminal and restart
your agents so they start with the variables, and rotate any secret that sat in a
shared or synced file.

`--dry-run` only shows the changes; `--yes` applies the ones that start selected
without asking.

## The audit only reads

- Reads config files on your machine. Writes nothing unless you ask for a card,
  or run `--fix` and confirm the changes.
- Makes no network requests and collects no telemetry. (`--fix` looks up the
  current version of the unpinned packages it offers to pin on npm or PyPI. Only
  the separate `auth` and `mcp` commands below talk to Toolstile, and only when
  you run them.)
- Never prints, stores or sends secret values. Findings name the file and key,
  for example `mcpServers.github.env.GITHUB_TOKEN`, and the kind of secret.
- Never quotes a config file: one that cannot be read or parsed is listed with a
  reason and position only, for example `invalid TOML at line 3, column 12`.
- About 3,500 lines of TypeScript with two runtime dependencies
  ([smol-toml](https://github.com/squirrelchat/smol-toml), for Codex's TOML
  config, and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser), so
  `--fix` keeps comments and layout in JSON files) and an optional one ([resvg-js](https://github.com/thx/resvg-js), only
  to render `--card` as PNG). Read it before you run it.

## Options

```text
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
