import { fileText, withFileLock } from "./file-lock.js";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER, secureScheme } from "./servers.js";
import type { ClientId } from "./types.js";

export { DEFAULT_SERVER };
/** Toolstile's gateway, on its own host since the app moved off the bare domain. */
export const DEFAULT_MCP_URL = "https://mcp.toolstile.com/mcp";
/** Where Toolstile served the app and gateway before; it now only redirects. */
const LEGACY_SERVER = "https://toolstile.com";

/** Toolstile Cloud has workspaces; a self-hosted server has none. */
export type Edition = "cloud" | "self-hosted";

export interface AgentLink {
  /** The agent's authorization ID on its server. */
  id: string;
  /** The Toolstile Cloud workspace it belongs to; absent on a self-hosted server. */
  workspaceId?: string;
  /** The Toolstile origin that issued the token; the proxy sends it nowhere else. */
  server: string;
  /** That server's gateway URL, as it reported it; `${server}/mcp` when absent. */
  endpoint?: string;
  label: string;
  /** The agent's own gateway token; only `toolstile mcp proxy` reads it. */
  token: string;
}

export interface Session {
  token: string;
  email: string;
  expiresAt: string;
}

/** What the CLI keeps for one server origin. */
export interface ServerState {
  edition?: Edition;
  session?: Session;
  /** The Toolstile Cloud workspace setup used last. */
  workspace?: { id: string; slug: string; name: string };
  /** This machine, as that server knows it. */
  device?: { id: string; label: string };
}

/**
 * Everything `auth` and `mcp` keep on this machine, in one owner-only file. `agents` keeps the
 * shape earlier releases wrote, so an agent config pinned to an older CLI still finds its link.
 */
export interface State {
  version: 2;
  /** The server commands use when no flag or variable picks one: the last one signed in to. */
  current: string;
  /** One entry per server origin. */
  servers: Record<string, ServerState>;
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

const revisions = new WeakMap<State, string | null>();

/** The entry for `server`, created when missing. */
export function serverEntry(state: State, server: string): ServerState {
  return (state.servers[server] ??= {});
}

/** Reads the credentials file, upgrading the single sign-in format of earlier releases in memory. */
export function loadState(opts?: StateEnv): State {
  let text: string;
  try {
    text = readFileSync(statePath(opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const empty: State = { version: 2, current: DEFAULT_SERVER, servers: {}, agents: {} };
      revisions.set(empty, null);
      return empty;
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!isObject(data))
    throw new Error(`${statePath(opts)} is not valid JSON. Delete it and run toolstile auth login again.`);
  const state = upgrade(data);
  revisions.set(state, text);
  return state;
}

/** Hold the credential revision stable during a synchronous config mutation. */
export function withCurrentState<T>(state: State, opts: StateEnv | undefined, run: () => T): T {
  return withFileLock(statePath(opts), () => {
    if (!revisions.has(state) || revisions.get(state) !== fileText(statePath(opts)))
      throw new Error("Toolstile credentials changed in another command. Run this command again.");
    return run();
  });
}

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
export function saveState(state: State, opts?: StateEnv, beforeWrite?: () => void): void {
  const dir = stateDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = statePath(opts);
  withFileLock(path, () => {
    const before = fileText(path);
    if (revisions.has(state) && revisions.get(state) !== before)
      throw new Error("Toolstile credentials changed in another command. Run this command again.");
    // Optional synchronous config/state transition shares this credential lock.
    beforeWrite?.();
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const { version, current, servers, agents } = state;
      writeFileSync(temp, `${JSON.stringify({ version, current, servers, agents }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
      revisions.set(state, fileText(path));
    } finally {
      rmSync(temp, { force: true });
    }
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys of `servers` are HTTPS or loopback origins; anything else (such as `__proto__`) is dropped on load. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && secureScheme(url);
  } catch {
    return false;
  }
}

/**
 * Earlier releases kept one sign-in at the top level: `server`, `session` (with its own
 * `server`), `workspace` and `device`. They become that server's entry, and that server the
 * current one. An older release run after this one writes those keys next to the new ones; its
 * sign-in is then the newest, so it is folded in the same way.
 */
function upgrade(data: Record<string, unknown>): State {
  const servers: Record<string, ServerState> = {};
  if (isObject(data.servers))
    for (const [origin, entry] of Object.entries(data.servers))
      if (isOrigin(origin) && isObject(entry)) servers[origin] = entry as ServerState;
  const agents = (isObject(data.agents) ? data.agents : {}) as State["agents"];
  let current = typeof data.current === "string" && isOrigin(data.current) ? data.current : undefined;

  const legacySession = isObject(data.session) ? (data.session as Partial<Session> & { server?: unknown }) : undefined;
  const legacyServer = typeof data.server === "string" ? data.server : undefined;
  if (legacySession || legacyServer !== undefined || isObject(data.workspace) || isObject(data.device)) {
    const named = typeof legacySession?.server === "string" ? legacySession.server : legacyServer;
    const origin = named !== undefined && isOrigin(named) ? named : DEFAULT_SERVER;
    const entry = (servers[origin] ??= {});
    if (legacySession && typeof legacySession.token === "string")
      entry.session = {
        token: legacySession.token,
        email: String(legacySession.email ?? ""),
        expiresAt: String(legacySession.expiresAt ?? ""),
      };
    if (isObject(data.workspace)) entry.workspace = data.workspace as ServerState["workspace"];
    if (isObject(data.device)) entry.device = data.device as ServerState["device"];
    current = origin;
  }

  // Sign-ins and agents saved for the old bare-domain address keep working on the new hosts.
  const legacy = servers[LEGACY_SERVER];
  if (legacy) {
    servers[DEFAULT_SERVER] ??= legacy;
    delete servers[LEGACY_SERVER];
  }
  if (current === LEGACY_SERVER) current = DEFAULT_SERVER;
  for (const link of Object.values(agents))
    if (link?.server === LEGACY_SERVER) {
      link.server = DEFAULT_SERVER;
      link.endpoint ??= DEFAULT_MCP_URL;
    }
  return { version: 2, current: current ?? DEFAULT_SERVER, servers, agents };
}
