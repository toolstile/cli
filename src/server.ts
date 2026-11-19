import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress } from "node:zlib";
import type { Style } from "./report.js";

/** Where release executables are published; `TOOLSTILE_SERVER_DOWNLOAD_URL` replaces it. */
export const RELEASES = "https://github.com/toolstile/toolstile/releases";
/** Platforms with a published `toolstile-server` build. */
export const PLATFORMS = ["darwin-arm64", "linux-arm64", "linux-x64"];
const NAME = "toolstile-server";

export interface ServerContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  fetch: typeof fetch;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  style: Style;
  /** Runs the executable with inherited stdio and resolves to its exit code. */
  run?: (file: string, args: string[]) => Promise<number>;
}

/** A failure explained to the user; exits 1 without a stack trace. */
export class ServerError extends Error {}

/** `TOOLSTILE_SERVER_HOME`, else `toolstile-server` in the per-user data folder. */
export function serverHome({ home, env }: Pick<ServerContext, "home" | "env">): string {
  if (env.TOOLSTILE_SERVER_HOME) return resolve(env.TOOLSTILE_SERVER_HOME);
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), NAME);
}
export const executablePath = (ctx: Pick<ServerContext, "home" | "env">) => join(serverHome(ctx), NAME);

/** The instance folder `toolstile-server` uses: `--data-dir`, `TOOLSTILE_DATA_DIR` or its default. */
export function dataDir(ctx: Pick<ServerContext, "home" | "env">, args: string[]): string {
  const i = args.findIndex((a) => a === "--data-dir" || a.startsWith("--data-dir="));
  const given = i === -1 ? undefined : args[i]!.includes("=") ? args[i]!.slice(args[i]!.indexOf("=") + 1) : args[i + 1];
  return resolve(given ?? ctx.env.TOOLSTILE_DATA_DIR ?? join(ctx.home, ".local", "share", "toolstile"));
}

function target(ctx: Pick<ServerContext, "platform" | "arch">): string {
  const id = `${ctx.platform}-${ctx.arch}`;
  if (!PLATFORMS.includes(id))
    throw new ServerError(
      `There is no toolstile-server build for ${id} yet (available: ${PLATFORMS.join(", ")}). Run it from source instead: https://github.com/toolstile/toolstile/blob/main/docs/local-operation.md`,
    );
  return `${NAME}-${id}`;
}

/** Release download folder for `release` (`latest` or a tag). */
export function downloadBase(ctx: Pick<ServerContext, "env">, release = "latest"): string {
  const custom = ctx.env.TOOLSTILE_SERVER_DOWNLOAD_URL;
  if (custom) {
    const url = new URL(custom);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname)))
      throw new ServerError("TOOLSTILE_SERVER_DOWNLOAD_URL must use https://");
    return url.href.replace(/\/$/, "");
  }
  return release === "latest" ? `${RELEASES}/latest/download` : `${RELEASES}/download/${encodeURIComponent(release)}`;
}

const say = (ctx: ServerContext, text = "") => ctx.stderr.write(`${text}\n`);

function runner(ctx: ServerContext) {
  return (
    ctx.run ??
    ((file: string, args: string[]) =>
      new Promise<number>((done, fail) => {
        // In its own process group, Ctrl-C reaches only this process, which passes each
        // signal on once: the server treats a second SIGINT as "stop without draining".
        const child = spawn(file, args, { stdio: "inherit", detached: true });
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        const forward = (signal: NodeJS.Signals) => child.kill(signal);
        for (const signal of signals) process.on(signal, forward);
        child.once("error", fail);
        child.once("exit", (code, signal) => {
          for (const s of signals) process.off(s, forward);
          done(code ?? (signal ? 1 : 0));
        });
      }))
  );
}

/** Output of a short command, for `version`. */
function capture(file: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", fail);
    child.once("exit", (code) => (code === 0 ? done(out.trim()) : fail(new Error(`exited with ${code}`))));
  });
}

async function get(ctx: ServerContext, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new ServerError(`Could not download ${url}: ${(error as Error).message}`);
  }
  if (response.status === 404)
    throw new ServerError(`${url} was not found. Check the release name, or that this release has a build for your platform.`);
  if (!response.ok || !response.body) throw new ServerError(`Downloading ${url} failed (HTTP ${response.status})`);
  return response;
}

/** Counts bytes through the stream and redraws a progress line on a terminal. */
function progress(ctx: ServerContext, total: number) {
  let seen = 0;
  let shown = -1;
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      seen += chunk.length;
      const percent = total ? Math.floor((seen / total) * 100) : -1;
      if (ctx.stderr.isTTY && percent !== shown) {
        shown = percent;
        const mb = (seen / 1048576).toFixed(1);
        ctx.stderr.write(`\r  ${total ? `${percent}% ` : ""}${mb} MB`);
      }
      next(null, chunk);
    },
    flush(done) {
      if (ctx.stderr.isTTY) ctx.stderr.write("\r\x1b[2K");
      done();
    },
  });
}

/**
 * Download (or copy `from`), verify and install the executable, keeping the one it replaces
 * as `toolstile-server.previous`. Returns the installed version.
 */
export async function install(ctx: ServerContext, options: { release?: string; from?: string } = {}): Promise<string> {
  const destination = executablePath(ctx);
  mkdirSync(serverHome(ctx), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.download-${process.pid}`;
  try {
    if (options.from) {
      const source = resolve(options.from);
      if (!existsSync(source)) throw new ServerError(`${source} does not exist`);
      say(ctx, `Installing ${source}`);
      const output = createWriteStream(temporary, { mode: 0o755 });
      if (source.endsWith(".br")) await pipeline(createReadStream(source), createBrotliDecompress(), output);
      else await pipeline(createReadStream(source), output);
    } else {
      const name = target(ctx);
      const base = downloadBase(ctx, options.release);
      const sums = await (await get(ctx, `${base}/${name}.sha256`)).text();
      const expected = sums.trim().split(/\s+/)[0] ?? "";
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new ServerError(`${base}/${name}.sha256 is not a SHA-256 checksum`);
      const response = await get(ctx, `${base}/${name}.br`);
      say(ctx, `Downloading ${name} (${options.release ?? "latest"})`);
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        progress(ctx, Number(response.headers.get("content-length")) || 0),
        createBrotliDecompress(),
        new Transform({
          transform(chunk: Buffer, _encoding, next) {
            hash.update(chunk);
            next(null, chunk);
          },
        }),
        createWriteStream(temporary, { mode: 0o755 }),
      );
      if (hash.digest("hex") !== expected)
        throw new ServerError("The download does not match its published checksum, so it was not installed. Try again.");
    }
    let version: string;
    try {
      version = await capture(temporary, ["version"]);
    } catch (error) {
      throw new ServerError(`The downloaded executable does not run on this machine (${(error as Error).message})`);
    }
    if (existsSync(destination)) renameSync(destination, `${destination}.previous`);
    renameSync(temporary, destination);
    say(ctx, `Installed toolstile-server ${version} at ${destination}`);
    return version;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Whether a process still owns the instance's database, as the server records it. */
export function running(directory: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(directory, "pglite.owner"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function ask(ctx: ServerContext, question: string): Promise<string> {
  const lines = createInterface({ input: ctx.stdin, output: ctx.stderr });
  try {
    return await new Promise<string>((done) => lines.question(question, (answer) => done(answer.trim())));
  } finally {
    lines.close();
  }
}

/** Options only `init` reads; `start` passes them on when it creates the instance. */
const INIT_OPTIONS = ["--origin", "--listen", "--port"];

/** Separate `names` (each taking a value) from the other arguments. */
export function split(args: string[], names: string[]) {
  const own: Record<string, string> = {};
  const rest: string[] = [];
  const forward: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (names.includes(name)) {
      const value = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (value === undefined || value.startsWith("-")) throw new ServerError(`${name} needs a value`);
      own[name] = value;
      forward.push(name, value);
    } else rest.push(a);
  }
  return { own, rest, forward };
}

/**
 * `toolstile server start`: install on first use, initialize and invite the first account on
 * a new instance, then run the server in the foreground.
 */
export async function start(ctx: ServerContext, args: string[]): Promise<number> {
  const { own, rest: other } = split(args, ["--email", "--data-dir"]);
  const { forward: initArgs, rest } = split(other, INIT_OPTIONS);
  const run = runner(ctx);
  const executable = executablePath(ctx);
  if (!existsSync(executable)) await install(ctx);
  const directory = dataDir(ctx, own["--data-dir"] ? ["--data-dir", own["--data-dir"]] : []);
  const pid = running(directory);
  if (pid) throw new ServerError(`The instance in ${directory} is already running (process ${pid})`);
  const data = ["--data-dir", directory];
  let email = own["--email"];
  if (!existsSync(join(directory, "instance.json"))) {
    if ((await run(executable, ["init", ...initArgs, ...data])) !== 0) return 1;
    if (!email && ctx.stdin.isTTY) email = await ask(ctx, "Email for your account (enter to skip): ");
    if (!email) say(ctx, "Invite an account later with: npx toolstile server bootstrap you@example.com");
  } else if (initArgs.length)
    throw new ServerError(`${directory} is already initialized; --origin, --listen and --port apply only to a new instance.`);
  if (email) {
    if ((await run(executable, ["bootstrap", email, ...data])) !== 0) return 1;
    say(ctx, ctx.style.dim("Open the invitation link once the server is listening, then create your account."));
  }
  const origin = instanceOrigin(directory);
  if (origin) say(ctx, `Connect Claude Code: claude mcp add --transport http toolstile ${origin}/mcp`);
  return run(executable, ["start", ...rest, ...data]);
}

function instanceOrigin(directory: string): string | undefined {
  try {
    const origin = JSON.parse(readFileSync(join(directory, "instance.json"), "utf8")).origin;
    return typeof origin === "string" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** Install a newer executable after backing up a stopped instance. */
export async function upgrade(ctx: ServerContext, args: string[]): Promise<number> {
  const { own, rest } = split(args, ["--release", "--from"]);
  const executable = executablePath(ctx);
  if (!existsSync(executable)) {
    await install(ctx, { release: own["--release"], from: own["--from"] });
    return 0;
  }
  const directory = dataDir(ctx, rest);
  const pid = running(directory);
  if (pid) throw new ServerError(`Stop the server first (process ${pid}), then upgrade.`);
  const current = await capture(executable, ["version"]).catch(() => "unknown");
  if (existsSync(join(directory, "instance.json"))) {
    const backup = join(serverHome(ctx), "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${current.replace(/[^\w.-]/g, "_")}`);
    mkdirSync(join(serverHome(ctx), "backups"), { recursive: true, mode: 0o700 });
    if ((await runner(ctx)(executable, ["backup", backup, "--data-dir", directory])) !== 0)
      throw new ServerError("The backup failed, so nothing was upgraded.");
    say(ctx, `Backed up the instance to ${backup}`);
  }
  const next = await install(ctx, { release: own["--release"], from: own["--from"] });
  say(ctx, `Upgraded ${current} → ${next}. The previous executable is ${executable}.previous; start the server to apply migrations.`);
  return 0;
}

/** Remove the executables; the instance and its backups stay. */
export function uninstall(ctx: ServerContext): number {
  const executable = executablePath(ctx);
  if (!existsSync(executable)) {
    say(ctx, "toolstile-server is not installed.");
    return 0;
  }
  rmSync(executable, { force: true });
  rmSync(`${executable}.previous`, { force: true });
  say(ctx, `Removed ${executable}. Instance data and backups were kept.`);
  return 0;
}

/** Run an installed `toolstile-server` command. */
export async function passthrough(ctx: ServerContext, args: string[]): Promise<number> {
  const executable = executablePath(ctx);
  if (!existsSync(executable)) throw new ServerError("toolstile-server is not installed. Run: npx toolstile server install");
  return runner(ctx)(executable, args);
}
