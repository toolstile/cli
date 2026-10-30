import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { ManualEditError, proxyCommand, readEntry, isProxyEntry, targets, type Target, writeEntry } from "./agents.js";
import { type Api, ApiError, type Workspace } from "./api.js";
import { checklist } from "./prompt.js";
import { runProxy } from "./proxy.js";
import { type Style, tildify } from "./report.js";
import { CLIENT_NAMES } from "./sources.js";
import { type AgentLink, loadState, saveState, type State, type StateEnv } from "./state.js";
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
  openBrowser?: (url: string) => void;
}

/** A failure explained to the user; exits 1 without a stack trace. */
export class UserError extends Error {}

const stateEnv = (ctx: Context): StateEnv => ({ home: ctx.home, env: ctx.env, platform: ctx.platform });
const print = (ctx: Context, text = "") => ctx.stdout.write(`${text}\n`);
const interactive = (ctx: Context) => ctx.stdin.isTTY === true && ctx.stdout.isTTY === true;

/** HTTPS, except a loopback server for local development. */
export function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`--server must be a URL, for example https://toolstile.com`);
  }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    throw new UserError("--server must use https://");
  return url.origin;
}

function defaultOpenBrowser(ctx: Context) {
  return (url: string) => {
    // Over SSH or without a display the URL and code are enough; nothing to open.
    if (ctx.env.SSH_CONNECTION || ctx.env.SSH_TTY) return;
    if (ctx.platform === "linux" && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY) return;
    const [command, args] =
      ctx.platform === "darwin" ? ["open", [url]] : ctx.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    try {
      spawn(command as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch {}
  };
}

const formatCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export async function login(ctx: Context, options: { server?: string; browser: boolean }): Promise<number> {
  const s = ctx.style;
  const state = loadState(stateEnv(ctx));
  const server = normalizeServer(options.server ?? ctx.env.TOOLSTILE_URL ?? state.server);
  const api = ctx.api(server);
  const code = await api.deviceCode();
  print(ctx, `Open this page on any device with a browser, sign in to Toolstile and enter the code:`);
  print(ctx);
  print(ctx, `  ${s.bold(code.verification_uri)}`);
  print(ctx, `  ${s.bold(formatCode(code.user_code))}`);
  print(ctx);
  print(ctx, s.dim(`Waiting for approval. The code expires in ${Math.round(code.expires_in / 60)} minutes.`));
  if (options.browser) (ctx.openBrowser ?? defaultOpenBrowser(ctx))(code.verification_uri);

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
  const account = await api.account(token);
  const previous = state.session;
  // The old session is ended where it was issued, never sent to the new server.
  if (previous) await ctx.api(previous.server ?? state.server).signOut(previous.token).catch(() => undefined);
  if (server !== state.server || (previous && previous.email !== account.email)) {
    // Another account's workspace and device do not apply; enabled agents keep their own access.
    delete state.workspace;
    delete state.device;
  }
  state.server = server;
  state.session = { token, email: account.email, expiresAt: account.expiresAt, server };
  saveState(state, stateEnv(ctx));
  print(ctx);
  print(ctx, `Signed in as ${s.bold(account.email)}. Next: ${s.bold("toolstile mcp setup")}`);
  return 0;
}

export async function logout(ctx: Context): Promise<number> {
  const state = loadState(stateEnv(ctx));
  if (!state.session) {
    print(ctx, "Not signed in.");
    return 0;
  }
  let reached = true;
  await ctx
    .api(state.session.server ?? state.server)
    .signOut(state.session.token)
    .catch((error: unknown) => {
      // 401 means the session had already ended; anything else is worth saying.
      if (!(error instanceof ApiError && error.status === 401)) reached = false;
    });
  delete state.session;
  saveState(state, stateEnv(ctx));
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
}

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
  const state = loadState(stateEnv(ctx));
  const session = state.session;
  if (!session) throw new UserError("Sign in first: toolstile auth login");
  const api = ctx.api(session.server ?? state.server);
  const account = await api.account(session.token).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 401)
      throw new UserError("Your sign-in has expired. Run toolstile auth login again.");
    throw error;
  });
  const enable = parseClients(options.enable, "--enable");
  const disable = parseClients(options.disable, "--disable");
  const both = enable.find((c) => disable.includes(c));
  if (both) throw new UserError(`${CLIENT_NAMES[both]} is in both --enable and --disable.`);

  const workspace = await chooseWorkspace(ctx, state, account.workspaces, options.workspace);
  state.workspace = { id: workspace.id, slug: workspace.slug, name: workspace.name };
  saveState(state, stateEnv(ctx));
  /** Created (or renamed) only when something needs it, so listing changes nothing. */
  let device: { id: string; label: string } | undefined;
  const ensureDevice = async () => {
    device ??= await api.device(session.token, {
      workspaceId: workspace.id,
      id: state.device?.id,
      label: options.deviceName ?? state.device?.label ?? hostname().replace(/\.local$/, ""),
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
  const deviceLabel = state.device?.label ?? hostname().replace(/\.local$/, "");
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
  const replaced: string[] = [];
  for (const target of all) {
    const want = wanted.has(target.client);
    const link = state.agents[target.client];
    if (want) {
      if (!live(target.client)) {
        if (link) await removeRemote(link).catch(() => undefined);
        const { id: deviceId } = await ensureDevice();
        const created = await api.addAgent(session.token, { workspaceId: workspace.id, deviceId, label: target.name });
        state.agents[target.client] = {
          id: created.id,
          workspaceId: workspace.id,
          server: state.server,
          label: created.label,
          token: created.token,
        };
        // Saved before touching the agent's config, so a token is never lost.
        saveState(state, stateEnv(ctx));
      }
      try {
        const result = writeEntry(target, proxyCommand(target.client, ctx.version, ctx.platform));
        if (!live(target.client) || result !== "unchanged") changes.push(`${s.bold("+")} ${target.name}  ${s.dim(tildify(target.path, ctx.home))}`);
        if (result === "replaced")
          replaced.push(target.name);
      } catch (error) {
        if (!(error instanceof ManualEditError)) throw error;
        manual.push({ target, error, enable: true });
      }
    } else if (link || isProxyEntry(readEntry(target))) {
      try {
        writeEntry(target, null);
      } catch (error) {
        if (!(error instanceof ManualEditError)) throw error;
        manual.push({ target, error, enable: false });
      }
      if (link) {
        await removeRemote(link);
        delete state.agents[target.client];
        saveState(state, stateEnv(ctx));
      }
      changes.push(`${s.bold("-")} ${target.name}`);
    }
  }

  print(ctx);
  if (changes.length) {
    for (const line of changes) print(ctx, line);
    print(ctx);
    print(ctx, "Restart agents that are running to pick up the change.");
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
    print(ctx, `Choose which MCP servers they can use: ${state.server}/app/${workspace.slug}/access`);
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
    endpoint: `${link.server}/mcp`,
    token: link.token,
    input: ctx.stdin as Readable,
    output: ctx.stdout as Writable,
    log: (message) => ctx.stderr.write(`toolstile: ${message}\n`),
  });
  return 0;
}
