import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { ManualEditError, proxyCommand, readEntry, isProxyEntry, targets, type Target, writeEntry } from "./agents.js";
import { type Account, type Api, ApiError, type Workspace } from "./api.js";
import { UserError } from "./errors.js";
import { checklist } from "./prompt.js";
import { runProxy } from "./proxy.js";
import { type Style, tildify } from "./report.js";
import { chooseServer, DEFAULT_SERVER, normalizeServer, secureScheme, type ServerChoice, serverFromEnv } from "./servers.js";
import { CLIENT_NAMES } from "./sources.js";
import {
  type AgentLink,
  type Edition,
  loadState,
  saveState,
  serverEntry,
  type ServerState,
  withCurrentState,
  type State,
  type StateEnv,
} from "./state.js";
import type { ClientId } from "./types.js";

export { normalizeServer, UserError };
export type { ServerChoice };

export interface Context {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  version: string;
  api: (server: string) => Api;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
  style: Style;
  sleep?: (ms: number) => Promise<void>;
  hostname?: () => string;
  openBrowser?: (url: string) => void;
  /** The proxy's HTTP client; tests replace it. */
  fetch?: typeof fetch;
  now?: () => number;
}

const stateEnv = (ctx: Context): StateEnv => ({ home: ctx.home, env: ctx.env, platform: ctx.platform });
const print = (ctx: Context, text = "") => ctx.stdout.write(`${text}\n`);
const interactive = (ctx: Context) => ctx.stdin.isTTY === true && ctx.stdout.isTTY === true;

/** The server a command uses: `--server` or `--local`, then `TOOLSTILE_SERVER`, then the current one. */
const serverFor = (ctx: Context, state: State, choice: ServerChoice = {}) =>
  chooseServer({ home: ctx.home, env: ctx.env, current: state.current }, choice);

/** Servers from before `edition` existed are Toolstile Cloud. */
const editionOf = (account: Account): Edition => (account.edition === "self-hosted" ? "self-hosted" : "cloud");

/**
 * Quotes an origin for the user's shell, or returns undefined when it cannot be quoted safely.
 * Windows shells only get double-quoted origins whose extra characters are IPv6 brackets.
 */
const quoteOrigin = (server: string, platform: NodeJS.Platform) => {
  if (/^[\w:/.-]+$/.test(server)) return server;
  if (platform !== "win32") return `'${server.replaceAll("'", "'\\''")}'`;
  return /^[\w:/.[\]-]+$/.test(server) ? `"${server}"` : undefined;
};

/** The `auth login` command that signs in to `server`; plain `auth login` uses `bare`, the server it would pick. */
const loginCommand = (ctx: Context, server: string, bare?: string) => {
  if (server === bare) return "toolstile auth login";
  const quoted = quoteOrigin(server, ctx.platform);
  return quoted
    ? `toolstile auth login --server ${quoted}`
    : `toolstile auth login --server <address>, with ${server} as the address`;
};

/** A failed local save must not silently abandon a newly issued remote credential. */
async function compensate(error: unknown, cleanup: () => Promise<void>, remedy: string): Promise<never> {
  try { await cleanup(); }
  catch (cleanupError) {
    if (!(cleanupError instanceof ApiError && cleanupError.status === 404))
      throw new UserError(`${error instanceof Error ? error.message : "Could not save credentials."} ${remedy}`);
  }
  throw error;
}

/** A gateway URL the server reported: HTTPS (or loopback HTTP) with no credentials, else undefined. */
export function gatewayUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (!secureScheme(url)) return undefined;
  return url.href;
}

/**
 * A sign-in page link the server sent, if it is safe to show and open: a URL on the server's
 * own origin (so HTTPS, or HTTP for a loopback server) with no credentials, else undefined.
 * Toolstile Cloud and self-hosted servers use different paths, so only the origin is checked.
 */
export function signInUrl(value: unknown, server: string): URL | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!secureScheme(url) || url.username || url.password || url.origin !== server) return undefined;
  return url;
}

/**
 * The program and arguments that open `url` in the default browser. Never a shell string:
 * Windows uses rundll32 rather than `cmd /c start`, where `&` in a URL would end the command.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

function defaultOpenBrowser(ctx: Context) {
  return (url: string) => {
    // Over SSH or without a display the URL and code are enough; nothing to open.
    if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) return;
    if (ctx.platform === "linux" && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) return;
    const [command, args] = browserCommand(ctx.platform, url);
    try {
      spawn(command, args, { stdio: "ignore", detached: true, shell: false }).on("error", () => {}).unref();
    } catch {}
  };
}

/** The name this machine suggests for itself: its hostname, without macOS's `.local`. */
const machineName = (ctx: Context) => (ctx.hostname ?? hostname)().replace(/\.local$/i, "");

const formatCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);


interface SignInOptions {
  browser: boolean;
  /** Set when `mcp setup` signs in and then carries on by itself. */
  next?: "setup";
  /** Prefilled on the approval page instead of the hostname. */
  deviceName?: string;
}

/**
 * The device-code sign-in shared by `auth login` and `mcp setup`. Saves the new session as
 * `server`'s sign-in, makes `server` the current one, and only then signs out the session it
 * replaced on that server. Sign-ins to other servers are kept.
 */
async function signIn(ctx: Context, state: State, server: string, options: SignInOptions): Promise<Account> {
  const s = ctx.style;
  const api = ctx.api(server);
  const code = await api.deviceCode();
  // The page fills in the code and this machine's name; the name can be edited there and
  // becomes the device this machine's agents are listed under.
  const link = signInUrl(code.verification_uri_complete, server);
  if (link) {
    link.searchParams.set("device_name", options.deviceName ?? machineName(ctx));
    // Tells the page the terminal goes on with setup by itself once this is approved.
    if (options.next) link.searchParams.set("next", options.next);
    print(ctx, `Open this link on any device with a browser and approve the sign-in:`);
    print(ctx);
    print(ctx, `  ${s.bold(link.href)}`);
    print(ctx);
    print(ctx, `Check that the page shows this code: ${s.bold(formatCode(code.user_code))}`);
  } else {
    // Never show or open a link that points anywhere but the server being signed in to.
    const page = signInUrl(code.verification_uri, server);
    if (!page) throw new UserError(`${server} sent a sign-in link for a different address. Check --server and TOOLSTILE_SERVER.`);
    ctx.stderr.write(`The sign-in link from ${server} was not valid, so no browser was opened.\n`);
    print(ctx, `Open this page on any device with a browser, enter the code and approve the sign-in:`);
    print(ctx);
    print(ctx, `  ${s.bold(page.href)}`);
    print(ctx);
    print(ctx, `Code: ${s.bold(formatCode(code.user_code))}`);
  }
  print(ctx, s.dim(`Waiting for approval. The code expires in ${Math.round(code.expires_in / 60)} minutes.`));
  if (link && options.browser) (ctx.openBrowser ?? defaultOpenBrowser(ctx))(link.href);

  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let interval = Math.max(code.interval, 1) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  let token: string | undefined;
  while (!token) {
    if (Date.now() > deadline) throw new UserError("The code expired. Run toolstile auth login again.");
    await sleep(interval);
    try {
      token = (await api.deviceToken(code.device_code)).access_token;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error.code === "access_denied") throw new UserError("Sign-in was denied in the browser.");
      if (error.code === "expired_token") throw new UserError("The code expired. Run toolstile auth login again.");
      throw error;
    }
  }
  const entry = serverEntry(state, server);
  const previous = entry.session;
  let account: Account;
  try {
    account = await api.account(token);
    if (previous && previous.email !== account.email) {
      // Another account's workspace and device do not apply; agents keep their own access.
      delete entry.workspace;
      delete entry.device;
    }
    entry.edition = editionOf(account);
    if (entry.edition === "self-hosted") delete entry.workspace;
    entry.session = { token, email: account.email, expiresAt: account.expiresAt };
    if (account.device) entry.device = account.device;
    state.current = server;
    saveState(state, stateEnv(ctx));
  } catch (error) {
    return compensate(error, async () => {
      // Only discard this sign-in, never the session a concurrent command saved.
      const winner = loadState(stateEnv(ctx)).servers[server]?.session;
      if (winner?.token !== token) await api.signOut(token);
    }, "Sign-in cleanup failed. Remove this new CLI session in the Toolstile dashboard.");
  }
  // End the session this one replaced only after the replacement was safely saved.
  if (previous && previous.token !== token) await api.signOut(previous.token).catch(() => undefined);
  const deviceLabel = account.device?.label;
  print(ctx);
  print(
    ctx,
    `Signed in as ${s.bold(account.email)}${deviceLabel ? ` on ${s.bold(deviceLabel)}` : ""}.${options.next ? "" : ` Next: ${s.bold("toolstile mcp setup")}`}`,
  );
  return account;
}

export async function login(ctx: Context, options: ServerChoice & { browser: boolean }): Promise<number> {
  const state = loadState(stateEnv(ctx));
  await signIn(ctx, state, serverFor(ctx, state, options), { browser: options.browser });
  return 0;
}

export interface LogoutOptions extends ServerChoice {
  /** Sign out of every saved server. */
  all?: boolean;
}

/** Signs out of one server (the current one by default), or of all of them with `all`. */
export async function logout(ctx: Context, options: LogoutOptions = {}): Promise<number> {
  if (options.all && (options.server !== undefined || options.local))
    throw new UserError("--all signs out of every server; leave out --server and --local.");
  const state = loadState(stateEnv(ctx));
  const chosen = options.all ? Object.keys(state.servers) : [serverFor(ctx, state, options)];
  const ended = chosen.flatMap((server) => {
    const session = state.servers[server]?.session;
    return session ? [{ server, session }] : [];
  });
  if (!ended.length) {
    print(ctx, options.all ? "Not signed in." : `Not signed in to ${chosen[0]}.`);
    return 0;
  }
  for (const { server } of ended) delete state.servers[server]!.session;
  saveState(state, stateEnv(ctx));
  for (const { server, session } of ended) {
    let reached = true;
    await ctx
      .api(server)
      .signOut(session.token)
      .catch((error: unknown) => {
        // 401 means the session had already ended; anything else is worth saying.
        if (!(error instanceof ApiError && error.status === 401)) reached = false;
      });
    print(
      ctx,
      reached
        ? `Signed out of ${server}.`
        : `Signed out of ${server} on this machine. The server could not be reached, so the session ends when it expires.`,
    );
  }
  const servers = new Set(ended.map((e) => e.server));
  const enabled = Object.values(state.agents).filter((link) => link && servers.has(link.server)).length;
  if (enabled)
    print(
      ctx,
      ctx.style.dim(
        `${enabled === 1 ? "The agent" : `The ${enabled} agents`} you enabled keep working. To turn ${enabled === 1 ? "it" : "them"} off, run toolstile mcp setup while signed in, or delete this device in the Toolstile dashboard.`,
      ),
    );
  return 0;
}

export interface SignInSummary {
  server: string;
  edition: Edition;
  email: string;
  expiresAt: string;
  expired: boolean;
  current: boolean;
}

function summary(ctx: Context, state: State, server: string, current: string): SignInSummary | undefined {
  const entry = state.servers[server];
  const session = entry?.session;
  if (!session) return undefined;
  const expires = Date.parse(session.expiresAt);
  return {
    server,
    edition: entry.edition ?? "cloud",
    email: session.email,
    expiresAt: session.expiresAt,
    expired: Number.isFinite(expires) && expires <= (ctx.now ?? Date.now)(),
    current: server === current,
  };
}

const signInLine = (signIn: SignInSummary) =>
  `${signIn.email} on ${signIn.server} (${signIn.edition}), ${signIn.expired ? "expired" : "expires"} ${signIn.expiresAt}`;

/** Lists the saved sign-ins from the credentials file; contacts no server. */
export function status(ctx: Context, options: { json?: boolean } = {}): number {
  const state = loadState(stateEnv(ctx));
  const current = serverFor(ctx, state);
  const signIns = Object.keys(state.servers).flatMap((server) => summary(ctx, state, server, current) ?? []);
  if (options.json) {
    print(ctx, JSON.stringify({ current, signIns }, null, 2));
    return 0;
  }
  const fromEnv = serverFromEnv(ctx.env);
  const source = fromEnv ? ` (from ${fromEnv.name})` : "";
  if (!signIns.length) {
    print(ctx, `Not signed in. Current server: ${current}${source}`);
    print(ctx, `Sign in with ${loginCommand(ctx, current, current)}`);
    return 0;
  }
  for (const signIn of signIns) print(ctx, `${signIn.current ? "*" : " "} ${signInLine(signIn)}`);
  print(ctx);
  print(
    ctx,
    signIns.some((signIn) => signIn.current)
      ? ctx.style.dim(`* current server${source}`)
      : `Current server: ${current}${source}, not signed in. Sign in with ${loginCommand(ctx, current, current)}`,
  );
  return 0;
}

/** Prints the sign-in for the chosen server; exits 1 when there is none or it has expired. */
export function whoami(ctx: Context, options: ServerChoice & { json?: boolean } = {}): number {
  const state = loadState(stateEnv(ctx));
  const server = serverFor(ctx, state, options);
  const signIn = summary(ctx, state, server, server);
  /** The server plain `auth login` would pick; undefined when TOOLSTILE_SERVER is invalid. */
  const bare = () => {
    try { return serverFor(ctx, state); }
    catch { return undefined; }
  };
  if (options.json) {
    const body = signIn
      ? { signedIn: !signIn.expired, server, edition: signIn.edition, email: signIn.email, expiresAt: signIn.expiresAt, expired: signIn.expired }
      : { signedIn: false, server };
    print(ctx, JSON.stringify(body, null, 2));
  } else if (!signIn) print(ctx, `Not signed in to ${server}. Sign in with ${loginCommand(ctx, server, bare())}`);
  else {
    print(ctx, signInLine(signIn));
    if (signIn.expired) print(ctx, `Sign in again with ${loginCommand(ctx, server, bare())}`);
  }
  return signIn && !signIn.expired ? 0 : 1;
}

function parseClients(list: string | undefined, flag: string): ClientId[] {
  if (!list) return [];
  const ids = Object.keys(CLIENT_NAMES) as ClientId[];
  return list.split(",").map((raw) => {
    const value = raw.trim().toLowerCase();
    const match = ids.find((id) => id === value || CLIENT_NAMES[id].toLowerCase().replace(/\s+/g, "-") === value);
    if (!match) throw new UserError(`${flag}: unknown agent "${raw.trim()}". Use ${ids.join(", ")}.`);
    return match;
  });
}

export interface SetupOptions extends ServerChoice {
  enable?: string;
  disable?: string;
  workspace?: string;
  deviceName?: string;
  /** Whether a sign-in started here may open a browser (default true). */
  browser?: boolean;
  /** Move agents linked to another server to this one without asking. */
  switch?: boolean;
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

const workspaceOnSelfHosted = (server: string) =>
  `--workspace only applies to Toolstile Cloud; ${server} is a self-hosted server and has no workspaces.`;

async function chooseWorkspace(ctx: Context, saved: ServerState, workspaces: Workspace[], wanted?: string) {
  if (wanted) {
    const value = wanted.toLowerCase();
    const match = workspaces.find((w) => w.slug === value || w.id === wanted || w.name.toLowerCase() === value);
    if (!match) throw new UserError(`No workspace "${wanted}". Yours: ${workspaces.map((w) => w.slug).join(", ")}.`);
    return match;
  }
  const current = workspaces.find((w) => w.id === saved.workspace?.id) ?? workspaces.find((w) => w.personal) ?? workspaces[0];
  if (!current) throw new UserError("Your account has no workspace yet. Open Toolstile in a browser once, then try again.");
  if (workspaces.length === 1 || !interactive(ctx)) return current;
  const picked = await checklist(
    "Which workspace should this machine's agents use?",
    workspaces.map((w) => ({ label: w.name, hint: w.personal ? "personal" : w.slug, checked: w.id === current.id })),
    ctx.stdin as unknown as ReadStream,
    ctx.stdout as unknown as WriteStream,
    { single: true },
  );
  if (!picked) throw new UserError("Cancelled; nothing changed.");
  return workspaces[picked.indexOf(true)]!;
}

/** Asks before an agent linked to another server moves to this one. */
async function confirmSwitch(ctx: Context, name: string, from: string, to: string): Promise<boolean> {
  const picked = await checklist(
    `${name} uses ${from}. Switch it to ${to}?`,
    [
      { label: `Keep it on ${from}`, checked: true },
      { label: `Switch it to ${to}`, checked: false },
    ],
    ctx.stdin as unknown as ReadStream,
    ctx.stdout as unknown as WriteStream,
    { single: true },
  );
  return picked?.[1] === true;
}

export async function setup(ctx: Context, options: SetupOptions): Promise<number> {
  const s = ctx.style;
  // Check the flags before any sign-in, so a typo does not cost a trip to the browser.
  const enable = parseClients(options.enable, "--enable");
  const disable = parseClients(options.disable, "--disable");
  const both = enable.find((c) => disable.includes(c));
  if (both) throw new UserError(`${CLIENT_NAMES[both]} is in both --enable and --disable.`);

  const state = loadState(stateEnv(ctx));
  const server = serverFor(ctx, state, options);
  const entry = serverEntry(state, server);
  if (options.workspace !== undefined && entry.edition === "self-hosted") throw new UserError(workspaceOnSelfHosted(server));
  /** The link of an agent that uses another server, if it does. */
  const elsewhere = (client: ClientId) => {
    const link = state.agents[client];
    return link && link.server !== server ? link : undefined;
  };
  if (!options.switch && !interactive(ctx)) {
    const moving = enable.filter((c) => elsewhere(c));
    if (moving.length)
      throw new UserError(
        `${moving.map((c) => `${CLIENT_NAMES[c]} uses ${elsewhere(c)!.server}`).join("; ")}. Add --switch to move ${moving.length === 1 ? "it" : "them"} to ${server}.`,
      );
  }

  let account: Account | undefined;
  const saved = entry.session;
  if (saved) {
    // 401: the saved session has expired, so sign in again below.
    account = await ctx.api(server).account(saved.token).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) return undefined;
      throw error;
    });
  }
  account ??= await signIn(ctx, state, server, {
    browser: options.browser ?? true,
    next: "setup",
    deviceName: options.deviceName,
  });
  const session = entry.session!;
  const api = ctx.api(server);
  const edition = editionOf(account);
  if (edition === "self-hosted" && options.workspace !== undefined) throw new UserError(workspaceOnSelfHosted(server));

  // Toolstile Cloud's gateway is on its own host; a self-hosted gateway must share the server's origin.
  const reported = gatewayUrl(account.mcpUrl);
  const endpoint =
    reported && (edition === "cloud" || new URL(reported).origin === server) ? reported : `${server}/mcp`;
  // Toolstile Cloud keeps agents in a workspace; a self-hosted server has none.
  const workspace = edition === "cloud" ? await chooseWorkspace(ctx, entry, account.workspaces, options.workspace) : undefined;
  const workspaceId = workspace?.id;
  entry.edition = edition;
  if (workspace) entry.workspace = { id: workspace.id, slug: workspace.slug, name: workspace.name };
  else delete entry.workspace;
  saveState(state, stateEnv(ctx));
  /** Created (or renamed) only when something needs it, so listing changes nothing. */
  let device: { id: string; label: string } | undefined;
  const ensureDevice = async () => {
    device ??= await api.device(session.token, {
      workspaceId,
      id: entry.device?.id,
      label: options.deviceName ?? entry.device?.label ?? machineName(ctx),
      rename: options.deviceName !== undefined,
    });
    entry.device = device;
    saveState(state, stateEnv(ctx));
    return device;
  };
  if (options.deviceName) await ensureDevice();

  // Agents deleted from the dashboard, or left in another workspace, are no longer enabled.
  const remote = new Set(
    entry.device ? (await api.agents(session.token, workspaceId, entry.device.id)).agents.map((a) => a.id) : [],
  );
  const live = (client: ClientId) => {
    const link = state.agents[client];
    return !!link && link.server === server && link.workspaceId === workspaceId && remote.has(link.id);
  };
  /** Servers where an old authorization could not be removed, because this machine is not signed in there. */
  const leftBehind: { name: string; server: string }[] = [];
  /**
   * Removes an agent's authorization on the server that issued it, using that server's sign-in.
   * A 403 means this account lost access to its workspace, which revokes it. The sign-in on another
   * server, or during a switch, may be a different account, so there a 403 is unconfirmed (`strict`).
   */
  const removeRemote = async (link: AgentLink, name: string, strict = link.server !== server) => {
    const token = link.server === server ? session.token : state.servers[link.server]?.session?.token;
    if (!token) {
      leftBehind.push({ name, server: link.server });
      return;
    }
    await (link.server === server ? api : ctx.api(link.server))
      .removeAgent(token, link.workspaceId, link.id)
      .catch((error: unknown) => {
        if (!(error instanceof ApiError && (error.status === 404 || (error.status === 403 && !strict)))) throw error;
      });
  };
  const deviceLabel = entry.device?.label ?? machineName(ctx);
  const all = targets(ctx);
  const shown = all.filter((t) => t.detected || live(t.client) || state.agents[t.client] || enable.includes(t.client));
  if (!shown.length) {
    print(ctx, "No supported agents found on this machine. Supported: " + all.map((t) => t.name).join(", ") + ".");
    return 0;
  }
  const where = `${workspace ? ` · workspace ${s.bold(workspace.name)}` : ""} · device ${s.bold(deviceLabel)}`;

  let wanted: Set<ClientId>;
  if (enable.length || disable.length) {
    wanted = new Set(all.filter((t) => live(t.client)).map((t) => t.client));
    for (const c of enable) wanted.add(c);
    for (const c of disable) wanted.delete(c);
  } else if (interactive(ctx)) {
    print(ctx, `Signed in to ${server} as ${account.email}${where}`);
    const picked = await checklist(
      "Which agents on this machine should use Toolstile?",
      shown.map((t) => ({
        label: t.name,
        hint: elsewhere(t.client)
          ? `uses ${elsewhere(t.client)!.server}`
          : t.detected ? tildify(t.path, ctx.home) : "not found on this machine",
        checked: live(t.client),
      })),
      ctx.stdin as unknown as ReadStream,
      ctx.stdout as unknown as WriteStream,
    );
    if (!picked) {
      print(ctx, "Cancelled; nothing changed.");
      return 0;
    }
    wanted = new Set(shown.filter((_, i) => picked[i]).map((t) => t.client));
  } else {
    print(ctx, `${server}${where}`);
    for (const t of shown) {
      const other = elsewhere(t.client);
      print(ctx, `  ${live(t.client) ? "enabled " : "disabled"}  ${t.client.padEnd(14)} ${t.name}${other ? `  (uses ${other.server})` : ""}`);
    }
    print(ctx);
    print(ctx, "Choose agents with --enable and --disable, for example: toolstile mcp setup --enable claude-code,codex");
    return 0;
  }
  // An agent can use one server at a time; moving it here needs a yes (or --switch).
  if (!options.switch)
    for (const client of [...wanted]) {
      const other = elsewhere(client);
      if (other && !(await confirmSwitch(ctx, CLIENT_NAMES[client], other.server, server))) wanted.delete(client);
    }

  const manual: { target: Target; error: ManualEditError; enable: boolean }[] = [];
  const changes: string[] = [];
  const turnedOn: string[] = [];
  const replaced: string[] = [];
  for (const target of all) {
    const want = wanted.has(target.client);
    const link = state.agents[target.client];
    // Agents that use another server are left alone unless named in --disable.
    if (!want && link && link.server !== server && !disable.includes(target.client)) continue;
    if (want) {
      let replacedAuthorization = false;
      if (live(target.client) && link && link.endpoint !== endpoint) {
        link.endpoint = endpoint;
        saveState(state, stateEnv(ctx));
      }
      if (!live(target.client)) {
        const { id: deviceId } = await ensureDevice();
        const created = await api.addAgent(session.token, { workspaceId, deviceId, label: target.name });
        state.agents[target.client] = {
          id: created.id,
          workspaceId,
          server,
          endpoint,
          label: created.label,
          token: created.token,
        };
        // Commit before editing config or revoking any previous authorization.
        try { saveState(state, stateEnv(ctx)); }
        catch (error) {
          await compensate(error, async () => {
            const winner = loadState(stateEnv(ctx));
            const retained = Object.values(winner.agents).some((agent) =>
              agent?.id === created.id && agent.workspaceId === workspaceId && agent.server === server);
            if (!retained) await api.removeAgent(session.token, workspaceId, created.id);
          }, `Agent cleanup failed. Remove the new ${target.name} authorization (${created.id}) in the Toolstile dashboard.`);
        }
        replacedAuthorization = !!link;
      }
      try {
        const result = withCurrentState(state, stateEnv(ctx), () => writeEntry(target, proxyCommand(target.client, ctx.version, ctx.platform)));
        if (!live(target.client) || result !== "unchanged") {
          changes.push(`${s.bold("+")} ${target.name}  ${s.dim(tildify(target.path, ctx.home))}`);
          turnedOn.push(target.name);
        }
        if (result === "replaced")
          replaced.push(target.name);
      } catch (error) {
        if (!(error instanceof ManualEditError)) throw error;
        manual.push({ target, error, enable: true });
      } finally {
        // Finish both local writes before yielding to remote cleanup. A later
        // disable must not be followed by this operation recreating its config.
        if (replacedAuthorization && link)
          await removeRemote(link, target.name, true).catch(() => {
            ctx.stderr.write(`Could not confirm removal of the old ${target.name} authorization (${link.id}) at ${link.server}. Check for it in that server's dashboard.\n`);
          });
      }
    } else if (link || isProxyEntry(readEntry(target))) {
      const removeLocal = () => {
        try {
          writeEntry(target, null);
        } catch (error) {
          if (!(error instanceof ManualEditError)) throw error;
          manual.push({ target, error, enable: false });
        }
        if (link) delete state.agents[target.client];
      };
      // Both local writes form one transition, even across separate processes.
      if (link) saveState(state, stateEnv(ctx), removeLocal);
      else withCurrentState(state, stateEnv(ctx), removeLocal);
      if (link) {
        await removeRemote(link, target.name).catch(() => {
          throw new UserError(`Disabled locally, but remote cleanup failed. Remove ${target.name} authorization (${link.id}) in the Toolstile dashboard at ${link.server}.`);
        });
      }
      changes.push(`${s.bold("-")} ${target.name}`);
    }
  }

  print(ctx);
  if (changes.length) {
    for (const line of changes) print(ctx, line);
    print(ctx);
    print(
      ctx,
      turnedOn.length
        ? `Restart ${listNames(turnedOn)} to pick up the change.`
        : "Restart agents that are running to pick up the change.",
    );
  } else print(ctx, "Nothing to change.");
  if (replaced.length) {
    print(ctx);
    print(
      ctx,
      `Replaced an existing "toolstile" server in ${replaced.join(", ")}. If it signed in directly, remove that older agent under Devices & agents in the dashboard.`,
    );
  }
  for (const { name, server: other } of leftBehind) {
    print(ctx);
    print(ctx, `${name}'s access on ${other} was not removed because this machine is not signed in there. Remove it under Devices & agents at ${other}.`);
  }
  for (const { target, error, enable } of manual) {
    print(ctx);
    print(ctx, `${target.name}: ${tildify(target.path, ctx.home)} was not changed because ${error.message}.`);
    if (enable) {
      print(ctx, "Add this entry yourself:");
      print(ctx, error.snippet.replace(/^/gm, "  "));
    } else print(ctx, `Remove its "toolstile" server entry yourself.`);
  }
  if ([...wanted].length) {
    print(ctx);
    print(
      ctx,
      workspace
        ? `Choose which MCP servers they can use: ${server}/${workspace.slug}/access`
        : `Choose which MCP servers they can use in the dashboard at ${server}`,
    );
  }
  return manual.length ? 1 : 0;
}

/**
 * Relays one agent's MCP traffic to the gateway of the server that issued its token. `--server`,
 * `--local` and `TOOLSTILE_SERVER` do not apply: the token is never sent anywhere else.
 */
export async function proxy(ctx: Context, agent: string | undefined): Promise<number> {
  const [client] = parseClients(agent, "--agent");
  if (!client) throw new UserError("--agent is required");
  const state = loadState(stateEnv(ctx));
  const link = state.agents[client];
  if (!link) throw new UserError(`${CLIENT_NAMES[client]} is not enabled on this machine. Run toolstile mcp setup.`);
  const endpoint = gatewayUrl(link.endpoint ?? `${link.server}/mcp`);
  if (!endpoint)
    throw new UserError(`${CLIENT_NAMES[client]}'s saved gateway address is not HTTPS. Run toolstile mcp setup to enable it again.`);
  await runProxy({
    endpoint,
    token: link.token,
    input: ctx.stdin as Readable,
    output: ctx.stdout as Writable,
    log: (message) => ctx.stderr.write(`toolstile: ${message}\n`),
    fetch: ctx.fetch,
  });
  return 0;
}
