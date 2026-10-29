import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderCard, shareText } from "../src/card.js";
import { audit } from "../src/index.js";
import { renderJson, renderReport, style } from "../src/report.js";

const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const API_KEY = "Bearer " + "q8W7e6R5t4Y3u2I1o0P9a8S7d6F5";

let home: string;
let project: string;

function put(path: string, content: unknown, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  chmodSync(path, mode);
}

const run = () => audit({ home, cwd: project, platform: "darwin", env: {} });
const rules = (r: ReturnType<typeof run>) => r.findings.map((f) => f.rule);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-home-"));
  project = join(home, "project");
  mkdirSync(project);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("audit", () => {
  it("returns no grade when nothing is configured", () => {
    const r = run();
    expect(r.files).toEqual([]);
    expect(r.grade).toBeNull();
  });

  it("flags plaintext secrets but not environment references", () => {
    put(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN } },
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } },
        notes: { command: "node", args: ["server.js"], env: { NOTES_DIR: "/Users/me/notes", LOG_LEVEL: "debug", API_KEY: "${NOTES_KEY}" } },
      },
    });
    const r = run();
    const secrets = r.findings.filter((f) => f.rule === "plaintext-secret");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.title).toContain("github (Cursor)");
    expect(secrets[0]!.detail).toContain("GitHub token");
    expect(secrets[0]!.locations[0]!.pointer).toBe("mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN");
  });

  it("never prints secret values in the report, JSON or card", () => {
    put(join(home, ".cursor", "mcp.json"), {
      mcpServers: { github: { command: "npx", args: ["-y", "pkg@1.0.0", "--token", GITHUB_TOKEN], env: { TOKEN: GITHUB_TOKEN } } },
    });
    const r = run();
    const outputs = [renderReport(r, home, style(false)), renderJson(r), renderCard(r), shareText(r)];
    for (const out of outputs) {
      expect(out).not.toContain(GITHUB_TOKEN);
      expect(out).not.toContain(GITHUB_TOKEN.slice(4, 16));
    }
    expect(renderCard(r)).not.toContain("github");
    expect(shareText(r)).not.toContain("github");
  });

  it("finds the same secret copied between Claude Code and Codex", () => {
    put(join(home, ".claude.json"), {
      mcpServers: { search: { type: "http", url: "https://search.example.com/mcp", headers: { Authorization: API_KEY } } },
    });
    put(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.search]\nurl = "https://search.example.com/mcp"\n\n[mcp_servers.search.http_headers]\nAuthorization = "${API_KEY}"\n`,
    );
    const r = run();
    expect(rules(r).filter((x) => x === "plaintext-secret")).toHaveLength(2);
    const copied = r.findings.find((f) => f.rule === "copied-secret");
    expect(copied?.title).toBe("Same authorization header copied into 2 files");
    expect(r.findings.find((f) => f.rule === "duplicated-server")?.title).toBe("search is set up separately in 2 clients");
  });

  it("reads Claude Code project servers and project .mcp.json", () => {
    put(join(home, ".claude.json"), {
      projects: { "/Users/me/app": { mcpServers: { db: { command: "uvx", args: ["mcp-server-postgres"] } } } },
    });
    put(join(project, ".mcp.json"), { mcpServers: { sentry: { command: "npx", args: ["-y", "@sentry/mcp-server@0.9.0"] } } });
    const r = run();
    expect(r.servers).toBe(2);
    const unpinned = r.findings.filter((f) => f.rule === "unpinned-package");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.locations[0]!.pointer).toBe('projects["/Users/me/app"].mcpServers.db.args[0]');
  });

  it("flags unpinned launcher packages and images", () => {
    put(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        a: { command: "npx", args: ["-y", "@scope/server"] },
        b: { command: "npx", args: ["-y", "server@latest"] },
        c: { command: "npx", args: ["-y", "server@^1.2.0"] },
        d: { command: "npx", args: ["-y", "@scope/pinned@1.2.3"] },
        e: { command: "uvx", args: ["mcp-server-fetch==2025.1.17"] },
        f: { command: "docker", args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/org/server"] },
        g: { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/org/server:1.4.0"] },
        h: { command: "pnpm", args: ["dlx", "other-server"] },
        i: { command: "node", args: ["./local.js"] },
      },
    });
    const flagged = run()
      .findings.filter((f) => f.rule === "unpinned-package")
      .map((f) => f.title.split(": ")[1]);
    expect(flagged).toEqual(["a (Cursor)", "b (Cursor)", "c (Cursor)", "f (Cursor)", "h (Cursor)"]);
  });

  it("flags plain-http remote servers but not localhost", () => {
    put(join(home, ".codeium", "windsurf", "mcp_config.json"), {
      mcpServers: { remote: { serverUrl: "http://mcp.example.com/sse" }, local: { serverUrl: "http://localhost:3000/mcp" } },
    });
    const r = run();
    expect(r.findings.filter((f) => f.rule === "insecure-transport").map((f) => f.title)).toEqual([
      "Unencrypted remote server: remote (Windsurf)",
    ]);
  });

  it("flags filesystem servers rooted at the home folder or disk", () => {
    put(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), {
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.7.1", home] },
        root: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.7.1", "/"] },
        scoped: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.7.1", join(home, "code")] },
      },
    });
    const broad = run().findings.filter((f) => f.rule === "broad-filesystem");
    expect(broad.map((f) => f.title)).toEqual([
      "Filesystem server can read your whole home folder: fs (Claude Desktop)",
      "Filesystem server can read the whole disk: root (Claude Desktop)",
    ]);
  });

  it("flags Claude Code rules that approve whole servers", () => {
    put(join(home, ".claude", "settings.json"), {
      permissions: { allow: ["mcp__github", "mcp__linear__get_issue", "Bash(git status)", "mcp__sentry__*"] },
      enableAllProjectMcpServers: true,
    });
    const titles = run()
      .findings.filter((f) => f.rule === "auto-approved-tools")
      .map((f) => f.title);
    expect(titles).toEqual([
      "Claude Code approves every MCP server in project .mcp.json files without asking",
      "Claude Code runs every tool of github without asking",
      "Claude Code runs every tool of sentry without asking",
    ]);
  });

  it("parses VS Code settings with comments and trailing commas", () => {
    put(
      join(home, "Library", "Application Support", "Code", "User", "settings.json"),
      `{
        // editor settings
        "editor.fontSize": 13,
        "mcp": {
          "servers": {
            /* remote */
            "docs": { "type": "http", "url": "https://docs.example.com/mcp?api_key=abcd1234efgh5678", },
          },
        },
      }`,
    );
    const r = run();
    expect(r.servers).toBe(1);
    expect(r.findings[0]!.rule).toBe("plaintext-secret");
    expect(r.findings[0]!.detail).toContain("credential in URL query");
  });

  it("flags readable config files that hold secrets", () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { url: "https://api.example.com/mcp", headers: { Authorization: API_KEY } } } }, 0o644);
    expect(rules(run())).toContain("readable-config");
  });

  it("reports unparseable files without failing", () => {
    put(join(home, ".cursor", "mcp.json"), "{ not json");
    const r = run();
    expect(r.unreadable).toHaveLength(1);
    expect(r.grade).toBeNull();
  });

  it("grades a clean setup A", () => {
    put(join(home, ".cursor", "mcp.json"), {
      mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } },
    });
    const r = run();
    expect(r.findings).toEqual([]);
    expect(r.grade).toBe("A");
    expect(r.score).toBe(100);
  });
});

describe("cli", () => {
  const cli = join(import.meta.dirname, "..", "dist", "cli.js");
  const hasBuild = existsSync(cli);

  it.skipIf(!hasBuild)("prints JSON and honours --fail-on", () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: GITHUB_TOKEN } } } });
    const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
    const ok = execFileSync("node", [cli, "audit", "--json", "--no-project"], { env, encoding: "utf8" });
    const parsed = JSON.parse(ok) as { grade: string; findings: unknown[] };
    expect(parsed.findings.length).toBe(2);
    expect(ok).not.toContain(GITHUB_TOKEN);

    const failed = spawnSync("node", [cli, "--no-project", "--fail-on", "high"], { env, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("Plaintext secret in gh (Cursor)");

    const card = join(home, "card.svg");
    const withCard = spawnSync("node", [cli, "--no-project", "--card", card], { env, encoding: "utf8" });
    expect(withCard.status).toBe(0);
    expect(readFileSync(card, "utf8")).toContain("npx toolstile audit");
  });

  it.skipIf(!hasBuild)("rejects unknown options", () => {
    const r = spawnSync("node", [cli, "--nope"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown option: --nope");
  });
});
