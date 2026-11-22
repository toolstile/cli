import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { style } from "../src/report.js";
import {
  dataDir,
  downloadBase,
  executablePath,
  install,
  isLoopbackOrigin,
  shellQuote,
  type ServerContext,
  ServerError,
  serverHome,
  start,
  uninstall,
  upgrade,
} from "../src/server.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "toolstile-server-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A stand-in for toolstile-server: a script that prints its version. */
const script = (version: string) => Buffer.from(`#!/bin/sh\necho ${version}\n`);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function context(files: Record<string, Buffer | string> = {}, overrides: Partial<ServerContext> = {}) {
  const requests: string[] = [];
  const calls: string[][] = [];
  const stderr = new PassThrough();
  let err = "";
  stderr.on("data", (chunk) => (err += chunk));
  const ctx: ServerContext = {
    home,
    env: { TOOLSTILE_SERVER_DOWNLOAD_URL: "https://releases.test/v1" },
    platform: "linux",
    arch: "x64",
    fetch: (async (url: string) => {
      requests.push(url);
      const file = files[url.replace("https://releases.test/v1/", "")];
      return file === undefined ? new Response("missing", { status: 404 }) : new Response(typeof file === "string" ? file : new Uint8Array(file));
    }) as typeof fetch,
    stdout: new PassThrough(),
    stderr,
    style: style(false),
    run: async (file, args) => {
      calls.push([file, ...args]);
      return 0;
    },
    ...overrides,
  };
  return { ctx, requests, calls, stderr: () => err };
}

function release(version: string, checksum?: string) {
  const executable = script(version);
  return {
    "toolstile-server-linux-x64.br": brotliCompressSync(executable),
    "toolstile-server-linux-x64.sha256": `${checksum ?? sha256(executable)}  toolstile-server-linux-x64\n`,
  };
}

describe.skipIf(process.platform === "win32")("toolstile server", () => {
  it("keeps the executable apart from the instance it serves", () => {
    const { ctx } = context();
    expect(serverHome(ctx)).toBe(join(home, ".local", "share", "toolstile-server"));
    expect(serverHome({ home, env: { XDG_DATA_HOME: join(home, "xdg") } })).toBe(join(home, "xdg", "toolstile-server"));
    expect(dataDir(ctx, [])).toBe(join(home, ".local", "share", "toolstile"));
    expect(dataDir({ home, env: { TOOLSTILE_DATA_DIR: "/srv/a" } }, [])).toBe("/srv/a");
    expect(dataDir(ctx, ["start", "--data-dir", "/srv/b"])).toBe("/srv/b");
    expect(dataDir(ctx, ["--data-dir=/srv/c"])).toBe("/srv/c");
  });

  it("downloads the latest release or a named one, and only over HTTPS", () => {
    expect(downloadBase({ env: {} })).toBe("https://github.com/toolstile/toolstile/releases/latest/download");
    expect(downloadBase({ env: {} }, "v1.2.0")).toBe("https://github.com/toolstile/toolstile/releases/download/v1.2.0");
    expect(downloadBase({ env: { TOOLSTILE_SERVER_DOWNLOAD_URL: "http://127.0.0.1:9000/" } })).toBe("http://127.0.0.1:9000");
    expect(() => downloadBase({ env: { TOOLSTILE_SERVER_DOWNLOAD_URL: "http://example.com" } })).toThrow(ServerError);
  });

  it("installs a verified download and keeps the executable it replaces", async () => {
    const first = context(release("1.0.0"));
    expect(await install(first.ctx)).toBe("1.0.0");
    expect(first.requests).toEqual([
      "https://releases.test/v1/toolstile-server-linux-x64.sha256",
      "https://releases.test/v1/toolstile-server-linux-x64.br",
    ]);
    const path = executablePath(first.ctx);
    expect(readFileSync(path)).toEqual(script("1.0.0"));
    expect(await install(context(release("1.1.0")).ctx)).toBe("1.1.0");
    expect(readFileSync(path)).toEqual(script("1.1.0"));
    expect(readFileSync(`${path}.previous`)).toEqual(script("1.0.0"));
  });

  it("refuses a download that does not match its checksum and leaves nothing behind", async () => {
    const { ctx } = context(release("1.0.0", "0".repeat(64)));
    await expect(install(ctx)).rejects.toThrow(/does not match its published checksum/);
    expect(readdirSync(serverHome(ctx))).toEqual([]);
  });

  it("follows redirects only to HTTPS", async () => {
    const files = release("1.0.0");
    const fetchVia = (target: string) =>
      (async (url: string) => {
        if (url.startsWith("https://releases.test/"))
          return new Response(null, { status: 302, headers: { location: `${target}/${url.split("/").at(-1)}` } });
        const file = files[url.split("/").at(-1) as keyof typeof files];
        return new Response(typeof file === "string" ? file : new Uint8Array(file));
      }) as typeof fetch;
    expect(await install(context({}, { fetch: fetchVia("https://storage.test") }).ctx)).toBe("1.0.0");
    await expect(install(context({}, { fetch: fetchVia("http://storage.test") }).ctx)).rejects.toThrow(/not HTTPS/);
  });

  it("explains a missing release and an unsupported platform", async () => {
    await expect(install(context().ctx)).rejects.toThrow(/was not found/);
    await expect(install(context(release("1.0.0"), { platform: "win32" }).ctx)).rejects.toThrow(/no toolstile-server build for win32-x64/);
  });

  it("installs a local build, compressed or not", async () => {
    const { ctx } = context();
    const raw = join(home, "toolstile-server");
    writeFileSync(raw, script("2.0.0"));
    expect(await install(ctx, { from: raw })).toBe("2.0.0");
    writeFileSync(`${raw}.br`, brotliCompressSync(script("2.1.0")));
    expect(await install(ctx, { from: `${raw}.br` })).toBe("2.1.0");
  });

  it("initializes and invites on first start, then serves the same folder", async () => {
    const { ctx, calls } = context(release("1.0.0"));
    const data = join(home, "instance");
    const code = await start(ctx, ["--data-dir", data, "--email", "you@example.com", "--port", "4500"]);
    expect(code).toBe(0);
    const exe = executablePath(ctx);
    expect(calls).toEqual([
      [exe, "init", "--port", "4500", "--data-dir", data],
      [exe, "bootstrap", "you@example.com", "--data-dir", data],
      [exe, "start", "--data-dir", data],
    ]);
  });

  it("leaves the first account to the server's setup link on a new loopback instance", async () => {
    const { ctx, calls, stderr } = context(release("1.0.0"));
    const data = join(home, "instance");
    const run = ctx.run;
    ctx.run = async (file, args) => {
      if (args[0] === "init") {
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, "instance.json"), JSON.stringify({ origin: "http://127.0.0.1:4310" }));
      }
      return run!(file, args);
    };
    expect(await start(ctx, ["--data-dir", data])).toBe(0);
    expect(calls.map((c) => c[1])).toEqual(["init", "start"]);
    expect(stderr()).not.toMatch(/bootstrap|Connect Claude Code/);
  });

  it("points a new non-loopback instance at start --email with a quoted folder", async () => {
    const { ctx, stderr } = context(release("1.0.0"));
    const data = join(home, "Toolstile Data");
    const run = ctx.run;
    ctx.run = async (file, args) => {
      if (args[0] === "init") {
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, "instance.json"), JSON.stringify({ origin: "https://tools.example.com" }));
      }
      return run!(file, args);
    };
    expect(await start(ctx, ["--data-dir", data])).toBe(0);
    expect(stderr()).toContain(`npx toolstile server start --email you@example.com --data-dir '${data}'`);
    expect(stderr()).toMatch(/Connect Claude Code: .*https:\/\/tools.example.com\/mcp/);
  });

  it("quotes paths for the shell", () => {
    expect(shellQuote("/tmp/toolstile-data")).toBe("/tmp/toolstile-data");
    expect(shellQuote("/tmp/Toolstile Data")).toBe("'/tmp/Toolstile Data'");
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });

  it("recognizes loopback origins", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:4310")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:4310")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:4310")).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1:4310")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.2:4310")).toBe(false);
  });

  it("starts an existing instance without initializing it again", async () => {
    const { ctx, calls } = context(release("1.0.0"));
    const data = join(home, "instance");
    mkdirSync(data);
    writeFileSync(join(data, "instance.json"), JSON.stringify({ origin: "http://127.0.0.1:4310" }));
    await start(ctx, ["--data-dir", data]);
    expect(calls.map((c) => c[1])).toEqual(["start"]);
    await expect(start(ctx, ["--data-dir", data, "--port", "1"])).rejects.toThrow(/already initialized/);
  });

  it("refuses to start or upgrade an instance that is running", async () => {
    const { ctx } = context(release("1.0.0"));
    await install(ctx);
    const data = join(home, "instance");
    mkdirSync(data);
    writeFileSync(join(data, "instance.json"), "{}");
    writeFileSync(join(data, "pglite.owner"), String(process.pid));
    await expect(start(ctx, ["--data-dir", data])).rejects.toThrow(/already running/);
    await expect(upgrade(ctx, ["--data-dir", data])).rejects.toThrow(/Stop the server first/);
  });

  it("upgrades only an instance it can back up, with the options it knows", async () => {
    const { ctx } = context(release("1.0.0"));
    const data = join(home, "instance");
    mkdirSync(data);
    writeFileSync(join(data, "instance.json"), "{}");
    await expect(upgrade(ctx, ["--data-dir", data])).rejects.toThrow(/cannot be backed up first/);
    expect(existsSync(executablePath(ctx))).toBe(false);
    await install(ctx);
    await expect(upgrade(ctx, ["--data-di", data])).rejects.toThrow(/Unknown option: --data-di/);
    await expect(upgrade(ctx, ["--data-dir="])).rejects.toThrow(/--data-dir needs a value/);
    await expect(upgrade(ctx, ["--from="])).rejects.toThrow(/--from needs a value/);
  });

  it("backs up a stopped instance before upgrading", async () => {
    const { ctx, calls } = context(release("1.0.0"));
    await install(ctx);
    const data = join(home, "instance");
    mkdirSync(data);
    writeFileSync(join(data, "instance.json"), "{}");
    expect(await upgrade(ctx, ["--data-dir", data])).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(1, 2)).toEqual(["backup"]);
    expect(calls[0]![2]).toContain(join(serverHome(ctx), "backups"));
    expect(calls[0]!.slice(3)).toEqual(["--data-dir", data]);
    expect(existsSync(`${executablePath(ctx)}.previous`)).toBe(true);
  });

  it("uninstalls the executables and keeps the instance", async () => {
    const { ctx } = context(release("1.0.0"));
    await install(ctx);
    const data = join(home, ".local", "share", "toolstile");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "instance.json"), "{}");
    expect(uninstall(ctx)).toBe(0);
    expect(existsSync(executablePath(ctx))).toBe(false);
    expect(existsSync(join(data, "instance.json"))).toBe(true);
  });
});
