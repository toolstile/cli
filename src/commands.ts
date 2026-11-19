import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { ManualEditError, proxyCommand, readEntry, isProxyEntry, targets, type Target, writeEntry } from "./agents.js";
import { type Account, type Api, ApiError, type Workspace } from "./api.js";
import { checklist } from "./prompt.js";
import { runProxy } from "./proxy.js";
import { type Style, tildify } from "./report.js";
import { CLIENT_NAMES } from "./sources.js";
import { type AgentLink, loadState, saveState, withCurrentState, type State, type StateEnv } from "./state.js";
import type { ClientId } from "./types.js";

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
}

/** A failure explained to the user; exits 1 without a stack trace. */
export class UserError extends Error {}

const stateEnv = (ctx: Context): StateEnv => ({ home: ctx.home, env: ctx.env, platform: ctx.platform });
const print = (ctx: Context, text = "") => ctx.stdout.write(`${text}\n`);
const interactive = (ctx: Context) => ctx.stdin.isTTY === true && ctx.stdout.isTTY === true;

/** A failed local save must not silently abandon a newly issued remote credential. */
async function compensate(error: unknown, cleanup: () => Promise<void>, remedy: string): Promise<never> {
  try { await cleanup(); }
  catch (cleanupError) {
    if (!(cleanupError instanceof ApiError && cleanupError.status === 404))
      throw new UserError(`${error instanceof Error ? error.message : "Could not save credentials."} ${remedy}`);
  }
  throw error;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** HTTPS, or HTTP to a loopback host for local development. */
const secureScheme = (url: URL) => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.test(url.hostname));

/** HTTPS, except a loopback server for local development. */
export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`--server must be a URL, for example https://app.toolstile.com`);
  }
  if (!secureScheme(url)) throw new UserError("--server must use https://");
  return url.origin;
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

/** The server a new sign-in goes to: --server, else TOOLSTILE_URL, else the last one used. */
const signInServer = (ctx: Context, state: State, server?: string) =>
  normalizeServer(server ?? ctx.env.TOOLSTILE_URL ?? state.server);

interface SignInOptions {
  browser: boolean;
  /** Set when `mcp setup` signs in and then carries on by itself. */
  next?: "setup";
  /** Prefilled on the approval page instead of the hostname. */
  deviceName?: string;
}

/**
 * The device-code sign-in shared by `auth login` and `mcp setup`. Saves the new session into
 * `state` and only then signs the previous session out.
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
    if (!page) throw new UserError(`${server} sent a sign-in link for a different address. Check --server and TOOLSTILE_URL.`);
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
  const previous = state.session;
  const previousServer = previous?.server ?? state.server;
  let account: Account;
  try {
    account = await api.account(token);
    if (server !== state.server || (previous && previous.email !== account.email)) {
      // Another account's workspace and device do not apply; agents keep their own access.
      delete state.workspace;
      delete state.device;
    }
    state.server = server;
    state.session = { token, email: account.email, expiresAt: account.expiresAt, server };
    if (account.device) state.device = account.device;
    saveState(state, stateEnv(ctx));
  } catch (error) {
    return compensate(error, async () => {
      // Only discard this sign-in, never the session a concurrent command saved.
      const winner = loadState(stateEnv(ctx)).session;
      if (winner?.token !== token || winner.server !== server) await api.signOut(token);
    }, "Sign-in cleanup failed. Remove this new CLI session in the Toolstile dashboard.");
  }
  // End the previous session only after the replacement was safely saved.
  if (previous && (previous.token !== token || previousServer !== server))
    await ctx.api(previousServer).signOut(previous.token).catch(() => undefined);
  const deviceLabel = account.device?.label;
  print(ctx);
  print(
    ctx,
    `Signed in as ${s.bold(state.session!.email)}${deviceLabel ? ` on ${s.bold(deviceLabel)}` : ""}.${options.next ? "" : ` Next: ${s.bold("toolstile mcp setup")}`}`,
  );
  return account;
}

export async function login(ctx: Context, options: { server?: string; browser: boolean }): Promise<number> {
  const state = loadState(stateEnv(ctx));
  await signIn(ctx, state, signInServer(ctx, state, options.server), { browser: options.browser });
  return 0;
}

export async function logout(ctx: Context): Promise<number> {
  const state = loadState(stateEnv(ctx));
  if (!state.session) {
    print(ctx, "Not signed in.");
    return 0;
  }
  const session = state.session;
  delete state.session;
  saveState(state, stateEnv(ctx));
  let reached = true;
  await ctx
    .api(session.server ?? state.server)
    .signOut(session.token)
    .catch((error: unknown) => {
      // 401 means the session had already ended; anything else is worth saying.
      if (!(error instanceof ApiError && error.status === 401)) reached = false;
    });
  print(ctx, reached ? "Signed out." : "Signed out on this machine. Toolstile could not be reached, so the session ends when it expires.");
  const enabled = Object.keys(state.agents).length;
  if (enabled)
    print(
      ctx,
      ctx.style.dim(
        `${enabled === 1 ? "The agent" : `The ${enabled} agents`} you enabled keep working. To turn ${enabled === 1 ? "it" : "them"} off, run toolstile mcp setup while signed in, or delete this device in the Toolstile dashboard.`,
      ),
    );
  return 0;
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

export interface SetupOptions {
  enable?: string;
  disable?: string;
  workspace?: string;
  deviceName?: string;
  /** Sign in to this server first unless the saved session is already for it. */
  server?: string;
  /** Whether a sign-in started here may open a browser (default true). */
  browser?: boolean;
}

/** "A", "A and B", "A, B and C". */
const listNames = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

async function chooseWorkspace(ctx: Context, state: State, workspaces: Workspace[], wanted?: string) {
  if (wanted) {
    const value = wanted.toLowerCase();
    const match = workspaces.find((w) => w.slug === value || w.id === wanted || w.name.toLowerCase() === value);
    if (!match) throw new UserError(`No workspace "${wanted}". Yours: ${workspaces.map((w) => w.slug).join(", ")}.`);
    return match;
  }
  const current = workspaces.find((w) => w.id === state.workspace?.id) ?? workspaces.find((w) => w.personal) ?? workspaces[0];
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

export async function setup(ctx: Context, options: SetupOptions): Promise<number> {
  const s = ctx.style;
  // Check the flags before any sign-in, so a typo does not cost a trip to the browser.
  const enable = parseClients(options.enable, "--enable");
  const disable = parseClients(options.disable, "--disable");
  const both = enable.find((c) => disable.includes(c));
  if (both) throw new UserError(`${CLIENT_NAMES[both]} is in both --enable and --disable.`);
  const requested = options.server === undefined ? undefined : normalizeServer(options.server);

  const state = loadState(stateEnv(ctx));
  let reused: Api | undefined;
  let account: Account | undefined;
  const saved = state.session;
  const savedServer = saved ? (saved.server ?? state.server) : undefined;
  // Only an explicit --server moves a saved session elsewhere; TOOLSTILE_URL picks the
  // server for a new sign-in, as it does for auth login.
  if (saved && savedServer && (!requested || requested === savedServer)) {
    const candidate = ctx.api(savedServer);
    // 401: the saved session has expired, so sign in again below.
    account = await candidate.account(saved.token).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) return undefined;
      throw error;
    });
    if (account) reused = candidate;
  }
  if (!account) {
    account = await signIn(ctx, state, signInServer(ctx, state, requested), {
      browser: options.browser ?? true,
      next: "setup",
      deviceName: options.deviceName,
    });
  }
  const session = state.session!;
  const api = reused ?? ctx.api(session.server);

  // The gateway can be on another host; only an HTTPS URL from this server is used.
  const endpoint = gatewayUrl(account.mcpUrl) ?? `${state.server}/mcp`;
  const workspace = await chooseWorkspace(ctx, state, account.workspaces, options.workspace);
  state.workspace = { id: workspace.id, slug: workspace.slug, name: workspace.name };
  saveState(state, stateEnv(ctx));
  /** Created (or renamed) only when something needs it, so listing changes nothing. */
  let device: { id: string; label: string } | undefined;
  const ensureDevice = async () => {
    device ??= await api.device(session.token, {
      workspaceId: workspace.id,
      id: state.device?.id,
      label: options.deviceName ?? state.device?.label ?? machineName(ctx),
      rename: options.deviceName !== undefined,
    });
    state.device = device;
    saveState(state, stateEnv(ctx));
    return device;
  };
  if (options.deviceName) await ensureDevice();

  // Agents deleted from the dashboard, or left in another workspace, are no longer enabled.
  const remote = new Set(
    state.device ? (await api.agents(session.token, workspace.id, state.device.id)).agents.map((a) => a.id) : [],
  );
  const live = (client: ClientId) => {
    const link = state.agents[client];
    return !!link && link.server === state.server && link.workspaceId === workspace.id && remote.has(link.id);
  };
  /** Removes an agent where it was created; links from another server are just dropped. */
  const removeRemote = (link: AgentLink) =>
    link.server === state.server
      ? api.removeAgent(session.token, link.workspaceId, link.id).catch((error: unknown) => {
          if (!(error instanceof ApiError && (error.status === 404 || error.status === 403))) throw error;
        })
      : Promise.resolve();
  const deviceLabel = state.device?.label ?? machineName(ctx);
  const all = targets(ctx);
  const shown = all.filter((t) => t.detected || live(t.client) || state.agents[t.client] || enable.includes(t.client));
  if (!shown.length) {
    print(ctx, "No supported agents found on this machine. Supported: " + all.map((t) => t.name).join(", ") + ".");
    return 0;
  }

  let wanted: Set<ClientId>;
  if (enable.length || disable.length) {
    wanted = new Set(all.filter((t) => live(t.client)).map((t) => t.client));
    for (const c of enable) wanted.add(c);
    for (const c of disable) wanted.delete(c);
  } else if (interactive(ctx)) {
    print(ctx, `Signed in as ${account.email} · workspace ${s.bold(workspace.name)} · device ${s.bold(deviceLabel)}`);
    const picked = await checklist(
      "Which agents on this machine should use Toolstile?",
      shown.map((t) => ({
        label: t.name,
        hint: t.detected ? tildify(t.path, ctx.home) : "not found on this machine",
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
    print(ctx, `Workspace ${workspace.name} · device ${deviceLabel}`);
    for (const t of shown) print(ctx, `  ${live(t.client) ? "enabled " : "disabled"}  ${t.client.padEnd(14)} ${t.name}`);
    print(ctx);
    print(ctx, "Choose agents with --enable and --disable, for example: toolstile mcp setup --enable claude-code,codex");
    return 0;
  }

  const manual: { target: Target; error: ManualEditError; enable: boolean }[] = [];
  const changes: string[] = [];
  const turnedOn: string[] = [];
  const replaced: string[] = [];
  for (const target of all) {
    const want = wanted.has(target.client);
    const link = state.agents[target.client];
    if (want) {
      let replacedAuthorization = false;
      if (live(target.client) && link && link.endpoint !== endpoint) {
        link.endpoint = endpoint;
        saveState(state, stateEnv(ctx));
      }
      if (!live(target.client)) {
        const { id: deviceId } = await ensureDevice();
        const created = await api.addAgent(session.token, { workspaceId: workspace.id, deviceId, label: target.name });
        state.agents[target.client] = {
          id: created.id,
          workspaceId: workspace.id,
          server: state.server,
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
              agent?.id === created.id && agent.workspaceId === workspace.id && agent.server === state.server);
            if (!retained) await api.removeAgent(session.token, workspace.id, created.id);
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
        if (replacedAuthorization && link) await removeRemote(link).catch(() => undefined);
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
        await removeRemote(link).catch(() => {
          throw new UserError(`Disabled locally, but remote cleanup failed. Remove ${target.name} authorization (${link.id}) in the Toolstile dashboard.`);
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
    print(ctx, `Choose which MCP servers they can use: ${state.server}/${workspace.slug}/access`);
  }
  return manual.length ? 1 : 0;
}

export async function proxy(ctx: Context, agent: string | undefined): Promise<number> {
  const [client] = parseClients(agent, "--agent");
  if (!client) throw new UserError("--agent is required");
  const state = loadState(stateEnv(ctx));
  const link = state.agents[client];
  if (!link) throw new UserError(`${CLIENT_NAMES[client]} is not enabled on this machine. Run toolstile mcp setup.`);
  await runProxy({
    // The token goes only to the server that issued it, whatever the environment says.
    endpoint: link.endpoint ?? `${link.server}/mcp`,
    token: link.token,
    input: ctx.stdin as Readable,
    output: ctx.stdout as Writable,
    log: (message) => ctx.stderr.write(`toolstile: ${message}\n`),
  });
  return 0;
}
