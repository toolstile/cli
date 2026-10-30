import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFixes, planFixes, runFix } from "../src/fix.js";
import { audit } from "../src/index.js";
import { style } from "../src/report.js";

const GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const BEARER = "trg_" + "q8W7e6R5t4Y3u2I1o0P9a8S7d6F5";

let home: string;

function put(path: string, content: unknown, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  chmodSync(path, mode);
}
const read = (path: string) => readFileSync(path, "utf8");

const versions: Record<string, string> = { "https://registry.npmjs.org/gh-mcp/latest": "1.4.2" };
const fakeFetch = (async (url: string) => {
  const version = versions[url];
  return version ? new Response(JSON.stringify({ version })) : new Response("", { status: 404 });
}) as unknown as typeof fetch;

const opts = (env: Record<string, string> = {}) => ({
  home,
  cwd: null,
  platform: "darwin" as const,
  env: { SHELL: "/bin/zsh", ...env },
  fetch: fakeFetch,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-fix-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("audit --fix", () => {
  it("moves secrets into variables in each client's syntax and keeps everything else", async () => {
    put(join(home, ".claude.json"), {
      numStartups: 3,
      mcpServers: { gh: { type: "stdio", command: "npx", args: ["-y", "gh-mcp@1.0.0"], env: { GITHUB_TOKEN } } },
    });
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp@1.0.0"], env: { GITHUB_TOKEN } } } });
    const vscode = join(home, "Library", "Application Support", "Code", "User", "mcp.json");
    put(vscode, `{\n  // mine\n  "servers": {\n    "t": { "type": "http", "url": "https://t.example.com/mcp", "headers": { "Authorization": "Bearer ${BEARER}" } },\n  },\n}\n`);
    put(
      join(home, ".codex", "config.toml"),
      `model = "gpt-5"  # keep\n\n[mcp_servers.t]\nurl = "https://t.example.com/mcp"\nhttp_headers = { Authorization = "Bearer ${BEARER}" }\n\n[mcp_servers.gh]\ncommand = "npx"\nargs = ["-y", "gh-mcp@1.0.0"]\n\n[mcp_servers.gh.env]\nGITHUB_TOKEN = "${GITHUB_TOKEN}"\n\n[profiles.x]\nmodel = "o3"\n`,
    );
    put(join(home, ".zshrc"), "export FOO=1\n", 0o644);

    const plan = await planFixes(opts());
    expect(plan.fixes.map((f) => f.label)).toEqual([
      "gh (Claude Code): move secret to $GITHUB_TOKEN",
      "gh (Cursor): move secret to $GITHUB_TOKEN",
      "t (Codex): move secret to $T_TOKEN",
      "gh (Codex): move secret to $GITHUB_TOKEN",
      "t (VS Code): move secret to $T_TOKEN",
    ]);
    expect(JSON.stringify(plan.fixes.map((f) => f.changes))).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(plan.fixes.map((f) => f.changes))).not.toContain(BEARER);

    const result = applyFixes(plan, plan.fixes, { home });
    expect(result.failed).toEqual([]);
    expect(JSON.parse(read(join(home, ".claude.json")))).toEqual({
      numStartups: 3,
      mcpServers: { gh: { type: "stdio", command: "npx", args: ["-y", "gh-mcp@1.0.0"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } },
    });
    expect(read(join(home, ".cursor", "mcp.json"))).toContain('"GITHUB_TOKEN": "${env:GITHUB_TOKEN}"');
    // Comments and trailing commas survive; only the value changes.
    expect(read(vscode)).toBe(
      `{\n  // mine\n  "servers": {\n    "t": { "type": "http", "url": "https://t.example.com/mcp", "headers": { "Authorization": "Bearer \${env:T_TOKEN}" } },\n  },\n}\n`,
    );
    expect(read(join(home, ".codex", "config.toml"))).toBe(
      `model = "gpt-5"  # keep\n\n[mcp_servers.t]\nurl = "https://t.example.com/mcp"\nbearer_token_env_var = "T_TOKEN"\n\n[mcp_servers.gh]\ncommand = "npx"\nargs = [ "-y", "gh-mcp@1.0.0" ]\nenv_vars = [ "GITHUB_TOKEN" ]\n\n[profiles.x]\nmodel = "o3"\n`,
    );

    const secretsFile = join(home, ".config", "toolstile", "secrets.env");
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(read(secretsFile)).toContain(`export GITHUB_TOKEN='${GITHUB_TOKEN}'\n`);
    expect(read(secretsFile)).toContain(`export T_TOKEN='${BEARER}'\n`);
    expect(read(join(home, ".zshrc"))).toBe(
      "export FOO=1\n\n[ -f ~/.config/toolstile/secrets.env ] && . ~/.config/toolstile/secrets.env  # MCP server secrets, added by toolstile audit --fix\n",
    );
    expect(statSync(join(home, ".zshrc")).mode & 0o777).toBe(0o644);
    expect(readdirSync(result.backups!).sort()).toEqual([".claude.json", ".codex_config.toml", ".cursor_mcp.json", "Library_Application Support_Code_User_mcp.json"]);

    expect(audit(opts()).findings.filter((f) => f.rule === "plaintext-secret")).toEqual([]);
    // A second run finds nothing left to move and does not add the profile line twice.
    const again = await planFixes(opts());
    expect(again.fixes).toEqual([]);
  });

  it("never reuses a variable name that holds something else", async () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN } } } });
    const plan = await planFixes(opts({ GITHUB_TOKEN: "ghp_someoneelse" }));
    expect(plan.fixes[0]!.label).toBe("gh (Cursor): move secret to $GH_GITHUB_TOKEN");
  });

  it("leaves clients without variable support, and secrets in arguments, to the user", async () => {
    put(join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), {
      mcpServers: { gh: { command: "node", args: ["s.js", `--token=${GITHUB_TOKEN}`], env: { GITHUB_TOKEN } } },
    });
    const plan = await planFixes(opts());
    expect(plan.fixes).toEqual([]);
    expect(plan.manual.map((m) => m.reason)).toEqual([
      "Claude Desktop does not read environment variables in its config",
      "Claude Desktop does not read environment variables in its config",
    ]);
    const windows = await planFixes({ ...opts(), platform: "win32" });
    expect(windows.profile).toBeNull();
    expect(windows.fixes).toEqual([]);
  });

  it("pins unpinned packages to the current version, and lists the rest", async () => {
    put(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        a: { command: "npx", args: ["-y", "gh-mcp"] },
        b: { command: "npx", args: ["-y", "gone-mcp@latest"] },
        c: { command: "docker", args: ["run", "-i", "acme/mcp"] },
      },
    });
    const plan = await planFixes(opts());
    expect(plan.fixes.map((f) => [f.label, f.changes])).toEqual([
      ["a (Cursor): pin gh-mcp to 1.4.2", [{ where: "mcpServers.a.args[1]", from: '"gh-mcp"', to: '"gh-mcp@1.4.2"' }]],
    ]);
    expect(plan.manual.map((m) => m.reason).sort()).toEqual(["could not look up the current version of gone-mcp", "pin an image digest or an exact tag by hand"]);
    applyFixes(plan, plan.fixes, { home });
    expect(JSON.parse(read(join(home, ".cursor", "mcp.json"))).mcpServers.a.args).toEqual(["-y", "gh-mcp@1.4.2"]);
  });

  it("offers to remove whole-server approvals, unselected at first", async () => {
    put(join(home, ".claude", "settings.json"), { permissions: { allow: ["Bash(ls:*)", "mcp__github", "mcp__linear__*"] }, enableAllProjectMcpServers: true });
    const plan = await planFixes(opts());
    expect(plan.fixes.every((f) => !f.checked)).toBe(true);
    applyFixes(plan, plan.fixes, { home });
    expect(JSON.parse(read(join(home, ".claude", "settings.json")))).toEqual({ permissions: { allow: ["Bash(ls:*)"] } });
  });

  it.skipIf(process.platform === "win32")("restricts readable files that hold secrets", async () => {
    // The system temp folder is private on macOS; /tmp lets other accounts through.
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync("/tmp/toolstile-fix-");
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN } } } }, 0o644);
    chmodSync(home, 0o755);
    chmodSync(join(home, ".cursor"), 0o755);
    const plan = await planFixes(opts());
    const chmod = plan.fixes.find((f) => f.rule === "readable-config")!;
    expect(chmod.changes).toEqual([{ where: "(file permissions)", from: "644", to: "600" }]);
    applyFixes(plan, [chmod], { home });
    expect(statSync(join(home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);
  });

  it("leaves a file unchanged when the edit would not come out exactly as planned", async () => {
    // An inline server under [mcp_servers] cannot be rewritten as its own table.
    const text = `[mcp_servers]\nt = { url = "https://t.example.com/mcp", bearer_token = "${BEARER}" }\n`;
    put(join(home, ".codex", "config.toml"), text);
    const plan = await planFixes(opts());
    const result = applyFixes(plan, plan.fixes, { home });
    expect(result.failed.map((f) => f.reason)).toEqual(["the edited file did not match the planned change"]);
    expect(read(join(home, ".codex", "config.toml"))).toBe(text);
    // Nothing was moved, so nothing was saved.
    expect(() => statSync(join(home, ".config", "toolstile", "secrets.env"))).toThrow();
  });

  it("keeps Codex env names as written, and leaves names a shell cannot hold", async () => {
    put(join(home, ".codex", "config.toml"), `[mcp_servers.a]\ncommand = "node"\nenv = { github_token = "${GITHUB_TOKEN}" }\n\n[mcp_servers.b]\ncommand = "node"\nenv = { "api-key" = "${BEARER}" }\n`);
    const plan = await planFixes(opts());
    expect(plan.fixes.map((f) => f.label)).toEqual(["a (Codex): move secret to $github_token"]);
    expect(plan.manual.map((m) => m.reason)).toEqual(["api-key is not a name a shell variable can have"]);
  });

  it("does not save a second copy of a value the shell already exports under that name", async () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN } } } });
    const plan = await planFixes(opts({ GITHUB_TOKEN }));
    expect(plan.fixes[0]!.label).toBe("gh (Cursor): move secret to $GITHUB_TOKEN");
    expect(plan.fixes[0]!.secrets).toEqual([]);
    const result = applyFixes(plan, plan.fixes, { home });
    expect(result.profileAdded).toBe(false);
    expect(() => statSync(join(home, ".config", "toolstile", "secrets.env"))).toThrow();
  });

  it("leaves secrets with a backslash to fish users", async () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "node", args: ["s.js"], env: { API_KEY: "abc\\def123456" } } } });
    const plan = await planFixes(opts({ SHELL: "/usr/local/bin/fish" }));
    expect(plan.fixes).toEqual([]);
    expect(plan.manual[0]!.reason).toBe("it contains a backslash, which fish would read differently");
  });

  it("skips a file that changed after the plan was made", async () => {
    const path = join(home, ".cursor", "mcp.json");
    put(path, { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN } } } });
    const plan = await planFixes(opts());
    put(path, { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN: GITHUB_TOKEN.replace("a1", "z9") } } } });
    const changed = read(path);
    const result = applyFixes(plan, plan.fixes, { home });
    expect(result.failed.map((f) => f.reason)).toEqual(["the file changed after the changes were listed; run --fix again"]);
    expect(read(path)).toBe(changed);
  });

  it("shows changes without values and changes nothing unless asked", async () => {
    put(join(home, ".cursor", "mcp.json"), { mcpServers: { gh: { command: "node", args: ["s.js"], env: { GITHUB_TOKEN } } } });
    const before = read(join(home, ".cursor", "mcp.json"));
    const stdout = new PassThrough();
    let text = "";
    stdout.on("data", (chunk) => (text += chunk));
    const code = await runFix({ ...opts(), stdin: new PassThrough(), stdout, style: style(false), yes: false, dryRun: false });
    expect(code).toBe(0);
    expect(text).toContain('+ "${env:GITHUB_TOKEN}"');
    expect(text).toContain("Nothing changed.");
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(read(join(home, ".cursor", "mcp.json"))).toBe(before);

    text = "";
    expect(await runFix({ ...opts(), stdin: new PassThrough(), stdout, style: style(false), yes: true, dryRun: false })).toBe(0);
    expect(text).toContain("✓ gh (Cursor): move secret to $GITHUB_TOKEN");
    expect(text).toMatch(/Grade B 83 → Grade A 100\/100/);
    expect(text).not.toContain(GITHUB_TOKEN);
  });
});
