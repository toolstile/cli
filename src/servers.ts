import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.js";

/** Toolstile Cloud, the managed service. */
export const DEFAULT_SERVER = "https://app.toolstile.com";
/** Where a self-hosted server on this machine listens unless its instance says otherwise. */
export const DEFAULT_LOCAL_SERVER = "http://127.0.0.1:4310";

/** `localhost`, `127.0.0.0/8` and `[::1]`, as `URL` spells them after parsing. */
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

export const isLoopback = (hostname: string) => LOOPBACK.test(hostname);

/** HTTPS, or HTTP to a loopback host, where nothing leaves the machine. */
export const secureScheme = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));

/**
 * A server origin from the command line or the environment: HTTPS, or HTTP on a loopback host.
 * `source` names where the value came from, for the error message.
 */
export function normalizeServer(value: string, source = "--server"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`${source} must be a URL, for example ${DEFAULT_SERVER}`);
  }
  if (url.username || url.password) throw new UserError(`${source} must not contain a user name or password`);
  if (!secureScheme(url))
    throw new UserError(`${source} must use https:// (http:// only works for localhost, 127.0.0.0/8 and [::1])`);
  return url.origin;
}

export interface LocalEnv {
  home?: string;
  env?: Record<string, string | undefined>;
}

/** The self-hosted server's data folder: `TOOLSTILE_DATA_DIR`, else `~/.local/share/toolstile`. */
export function localDataDir({ home = homedir(), env = process.env }: LocalEnv = {}): string {
  return env.TOOLSTILE_DATA_DIR || join(home, ".local", "share", "toolstile");
}

/**
 * The origin of the self-hosted server on this machine. `instance.json` also holds the instance's
 * secret keys, so only its `origin` field is used, and no error quotes the file.
 */
export function localServer(opts: LocalEnv = {}): string {
  const path = join(localDataDir(opts), "instance.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_LOCAL_SERVER;
    throw new UserError(`Could not read ${path}. Use --server <url> instead of --local.`);
  }
  let origin: unknown;
  try {
    origin = (JSON.parse(text) as { origin?: unknown } | null)?.origin;
  } catch {
    throw new UserError(`${path} is not valid JSON. Use --server <url> instead of --local.`);
  }
  if (origin === undefined) return DEFAULT_LOCAL_SERVER;
  if (typeof origin !== "string") throw new UserError(`${path} has no valid origin. Use --server <url> instead of --local.`);
  try {
    return normalizeServer(origin);
  } catch {
    throw new UserError(`${path} has no valid origin. Use --server <url> instead of --local.`);
  }
}

/** How a command picks its server: `--server <url>` or `--local`. */
export interface ServerChoice {
  server?: string;
  local?: boolean;
}

/** The variable that sets the default server, and the older name it replaces. */
export function serverFromEnv(env: Record<string, string | undefined>): { name: string; value: string } | undefined {
  if (env.TOOLSTILE_SERVER) return { name: "TOOLSTILE_SERVER", value: env.TOOLSTILE_SERVER };
  if (env.TOOLSTILE_URL) return { name: "TOOLSTILE_URL", value: env.TOOLSTILE_URL };
  return undefined;
}

/** The server a command talks to: `--server` or `--local`, then `TOOLSTILE_SERVER`, then the current server. */
export function chooseServer(opts: LocalEnv & { current: string }, choice: ServerChoice = {}): string {
  if (choice.server !== undefined && choice.local) throw new UserError("Use either --server or --local, not both.");
  if (choice.server !== undefined) return normalizeServer(choice.server);
  if (choice.local) return localServer(opts);
  const fromEnv = serverFromEnv(opts.env ?? process.env);
  if (fromEnv) return normalizeServer(fromEnv.value, fromEnv.name);
  return opts.current;
}
