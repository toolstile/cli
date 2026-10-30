import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientId } from "./types.js";

export const DEFAULT_SERVER = "https://toolstile.com";

export interface AgentLink {
  /** The agent's authorization ID in Toolstile, valid in one workspace. */
  id: string;
  workspaceId: string;
  /** The Toolstile origin that issued the token; the proxy sends it nowhere else. */
  server: string;
  label: string;
  /** The agent's own gateway token; only `toolstile mcp proxy` reads it. */
  token: string;
}

/** Everything `auth` and `mcp` keep on this machine, in one owner-only file. */
export interface State {
  /** The origin `auth login` last signed in to. */
  server: string;
  session?: { token: string; email: string; expiresAt: string; server: string };
  workspace?: { id: string; slug: string; name: string };
  device?: { id: string; label: string };
  agents: Partial<Record<ClientId, AgentLink>>;
}

export interface StateEnv {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** `TOOLSTILE_CONFIG_DIR`, else the platform's per-user config folder. */
export function stateDir({ home = homedir(), env = process.env, platform = process.platform }: StateEnv = {}): string {
  if (env.TOOLSTILE_CONFIG_DIR) return env.TOOLSTILE_CONFIG_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "toolstile");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "toolstile");
}

export const statePath = (opts?: StateEnv) => join(stateDir(opts), "credentials.json");

/**
 * The saved server always wins over `TOOLSTILE_URL`, which only picks the server for a new
 * `auth login`: an environment variable set by a project must not redirect saved tokens.
 */
export function loadState(opts?: StateEnv): State {
  const fallback: State = { server: DEFAULT_SERVER, agents: {} };
  let text: string;
  try {
    text = readFileSync(statePath(opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  try {
    const data = JSON.parse(text) as Partial<State>;
    return { ...fallback, ...data, agents: data.agents ?? {} };
  } catch {
    throw new Error(`${statePath(opts)} is not valid JSON. Delete it and run toolstile auth login again.`);
  }
}

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export function saveState(state: State, opts?: StateEnv): void {
  const dir = stateDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = statePath(opts);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
