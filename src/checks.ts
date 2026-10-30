import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { argSecrets, classify, urlSecret } from "./secrets.js";
import { CLIENT_NAMES, pointerJoin, type Discovery } from "./sources.js";
import type { ClientId, Finding, Location, ServerEntry } from "./types.js";

const label = (s: ServerEntry) => `${s.name} (${CLIENT_NAMES[s.client]})`;
const at = (s: ServerEntry, ...keys: string[]): Location => ({
  file: s.file,
  pointer: keys.reduce(pointerJoin, s.pointer),
});

interface Secret {
  server: ServerEntry;
  location: Location;
  kind: string;
  hash: string;
}

const hash = (v: string) => createHash("sha256").update(v.trim()).digest("hex");

function secretsOf(s: ServerEntry): Secret[] {
  const out: Secret[] = [];
  const add = (value: string, kind: string, ...keys: string[]) =>
    out.push({ server: s, location: at(s, ...keys), kind, hash: hash(value) });

  for (const [k, v] of Object.entries(s.env)) {
    const kind = classify(k, v);
    if (kind) add(v, kind, "env", k);
  }
  for (const [k, v] of Object.entries(s.headers)) {
    const kind = classify(k, v);
    if (kind) add(v, kind, "headers", k);
  }
  for (const [k, v] of Object.entries(s.extraSecrets)) {
    const kind = classify(k, v);
    if (kind) add(v, kind, k);
  }
  for (const { index, label: kind } of argSecrets(s.args)) add(s.args[index]!, kind, "args", String(index));
  if (s.url) {
    const kind = urlSecret(s.url);
    if (kind) add(s.url, kind, "url");
  }
  return out;
}

const LAUNCHERS: Record<string, "npm" | "pypi"> = {
  npx: "npm",
  bunx: "npm",
  pnpx: "npm",
  uvx: "pypi",
};

const base = (p: string) => win32.basename(posix.basename(p)).replace(/\.(cmd|exe)$/i, "");

interface Words {
  list: string[];
  /** For each word, its index in `args`, or -1 when it comes from `command`. */
  arg: number[];
}

const split = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** WSL options that take a value. */
const WSL_VALUED = new Set(["-d", "--distribution", "--distribution-id", "-u", "--user", "--cd", "--shell-type"]);

/** Index of the first word after a `cmd /c` or `wsl` wrapper at `start`, or `start` when there is none. */
function afterWrapper(list: string[], start: number): number {
  const name = base(list[start] ?? "").toLowerCase();
  let j = start + 1;
  if (name === "cmd") {
    // cmd [/d] [/s] [/q] … /c|/k command
    while (j < list.length && /^\/[a-z]$/i.test(list[j]!) && !/^\/[ck]$/i.test(list[j]!)) j++;
    return /^\/[ck]$/i.test(list[j] ?? "") ? j + 1 : start;
  }
  if (name === "wsl") {
    while (j < list.length) {
      const a = list[j]!;
      if (WSL_VALUED.has(a)) j += 2;
      else if (a === "-e" || a === "--exec" || a === "--") return j + 1;
      else if (a.startsWith("-")) j++;
      else break;
    }
    return j;
  }
  return start;
}

/**
 * Splits `command` and `args` into words, handling configs that put the whole command in one string,
 * and skips Windows wrappers (`cmd /c npx …`, `wsl npx …`) so the real launcher comes first.
 */
function words(s: ServerEntry): Words {
  if (!s.command) return { list: [], arg: [] };
  const oneString = s.args.length === 0 && /\s/.test(s.command.trim());
  let list = oneString ? split(s.command) : [s.command, ...s.args];
  let arg = oneString ? list.map(() => -1) : list.map((_, i) => i - 1);
  for (;;) {
    const start = afterWrapper(list, 0);
    if (start === 0 || start >= list.length) break;
    list = list.slice(start);
    arg = arg.slice(start);
    // `cmd /c "npx -y pkg"` passes the inner command as one argument.
    if (list.length === 1 && /\s/.test(list[0]!.trim())) {
      const from = arg[0]!;
      list = split(list[0]!);
      arg = list.map(() => from);
    }
  }
  return { list, arg };
}

interface Package {
  registry: "npm" | "pypi" | "docker";
  name: string;
  version: string | null;
  /** Index of the package in the unwrapped words. */
  wordIndex: number;
  /** Index of the package in `args`, or -1 when it is inside `command`. */
  argIndex: number;
}

/** Finds the package a launcher such as npx, uvx or docker runs. */
export function packageOf(s: ServerEntry): Package | null {
  const { list: w, arg } = words(s);
  if (w.length === 0) return null;
  const cmd = base(w[0]!).toLowerCase();
  const sub = w.slice(1);
  let registry: Package["registry"] | undefined = LAUNCHERS[cmd];
  let skip = 0;
  if (!registry) {
    if (cmd === "pipx" && sub[0] === "run") [registry, skip] = ["pypi", 1];
    else if ((cmd === "pnpm" || cmd === "yarn" || cmd === "bun") && sub[0] === "dlx") [registry, skip] = ["npm", 1];
    else if (cmd === "bun" && sub[0] === "x") [registry, skip] = ["npm", 1];
    else if (cmd === "uv" && sub[0] === "tool" && sub[1] === "run") [registry, skip] = ["pypi", 2];
    else if (cmd === "docker" && sub[0] === "run") [registry, skip] = ["docker", 1];
  }
  if (!registry) return null;
  const rest = sub.slice(skip);
  const offset = 1 + skip;
  const at = (spec: string, i: number) => parsePackage(registry, spec, i, arg[i] ?? -1);

  // Flags that take a value; their value is not the package.
  const valued = new Set(["-p", "--package", "--from", "--with", "-e", "--env", "-v", "--volume", "--name", "--network", "--mount", "--env-file", "-w", "--workdir", "--entrypoint", "-u", "--user", "--python"]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") continue;
    if (a.startsWith("-")) {
      if (valued.has(a)) {
        if ((a === "--package" || a === "-p" || a === "--from") && registry !== "docker") {
          return at(rest[i + 1] ?? "", offset + i + 1);
        }
        i++;
      }
      continue;
    }
    return at(a, offset + i);
  }
  return null;
}

function parsePackage(registry: Package["registry"], spec: string, wordIndex: number, argIndex: number): Package | null {
  if (!spec) return null;
  const where = { wordIndex, argIndex };
  if (registry === "docker") {
    const at = spec.indexOf("@sha256:");
    if (at > 0) return { registry, name: spec.slice(0, at), version: spec.slice(at + 1), ...where };
    const slash = spec.lastIndexOf("/");
    const colon = spec.lastIndexOf(":");
    return colon > slash
      ? { registry, name: spec.slice(0, colon), version: spec.slice(colon + 1), ...where }
      : { registry, name: spec, version: null, ...where };
  }
  if (registry === "pypi") {
    const m = /^([A-Za-z0-9._\-[\],]+?)(?:(==|@|>=|~=)(.+))?$/.exec(spec);
    if (!m) return null;
    return { registry, name: m[1]!, version: m[2] === "==" || m[2] === "@" ? m[3]! : null, ...where };
  }
  if (/^(https?:|git\+|file:|\.|\/)/.test(spec)) return null;
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0
    ? { registry, name: spec.slice(0, at), version: spec.slice(at + 1), ...where }
    : { registry, name: spec, version: null, ...where };
}

const isPinned = (p: Package) =>
  p.version !== null &&
  p.version !== "latest" &&
  p.version !== "next" &&
  !/[\^~*xX><]/.test(p.version) &&
  (p.registry !== "npm" || /^\d+\.\d+\.\d+/.test(p.version) || p.version.startsWith("sha"));

/** A stable identity for the same server configured in several places. */
export function identityOf(s: ServerEntry): string | null {
  if (s.url) {
    try {
      const u = new URL(s.url);
      return `url:${u.host}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return `url:${s.url}`;
    }
  }
  const pkg = packageOf(s);
  if (pkg) return `${pkg.registry}:${pkg.name.toLowerCase()}`;
  const w = words(s).list;
  return w.length ? `cmd:${w.join(" ")}` : null;
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;

function broadRoots(s: ServerEntry, home: string): string[] {
  const pkg = packageOf(s);
  const isFs = pkg ? /server-filesystem|mcp-server-filesystem|filesystem-mcp/i.test(pkg.name) : false;
  if (!isFs || !pkg) return [];
  const homes = new Set([home, home.replace(/\/+$/, ""), "~", "~/", "$HOME", "${HOME}", "%USERPROFILE%"]);
  return words(s)
    .list.slice(pkg.wordIndex + 1)
    .filter((a) => a === "/" || /^[A-Za-z]:\\?$/.test(a) || homes.has(a) || homes.has(a.replace(/\/+$/, "")));
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as const;

/** Toolstile's own gateway is meant to be added to every client. */
const TOOLSTILE = /^url:([a-z0-9-]+\.)*toolstile\.com\//i;

/** A path for a shell command: `~/...` under the home folder, single-quoted when needed. */
export function shellPath(path: string, home: string): string {
  const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
  return home && path.startsWith(home + "/") ? `~/${quote(path.slice(home.length + 1))}` : quote(path);
}

export function runChecks(d: Discovery, home: string): Finding[] {
  const findings: Finding[] = [];
  const secrets = d.servers.flatMap(secretsOf);

  // Plaintext secrets, grouped per server.
  const byServer = new Map<ServerEntry, Secret[]>();
  for (const s of secrets) byServer.set(s.server, [...(byServer.get(s.server) ?? []), s]);
  const counted = new Set<string>();
  for (const [server, list] of byServer) {
    const fresh = new Set(list.map((s) => s.hash).filter((h) => !counted.has(h)));
    fresh.forEach((h) => counted.add(h));
    const kinds = [...new Set(list.map((s) => s.kind))].join(", ");
    const one = list.length === 1;
    const what = one ? `${/^[aeiou]/i.test(kinds) ? "An" : "A"} ${kinds} is` : `${list.length} secrets (${kinds}) are`;
    findings.push({
      rule: "plaintext-secret",
      severity: "high",
      title: `Plaintext secret in ${label(server)}`,
      detail: `${what} written directly into the config file. Anything that can read the file, including backups, dotfile syncs and other tools, can use ${one ? "it" : "them"}.`,
      fix: "Reference an environment variable instead (for example ${API_TOKEN}, or \"Bearer ${API_TOKEN}\" in a header), or use the server's OAuth sign-in. Rotate the secret if the file was ever shared or synced.",
      locations: list.map((s) => s.location),
      // A secret pasted into several files is one leak; the copies are scored by copied-secret.
      weight: 10 * fresh.size,
    });
  }

  // The same secret copied into several files.
  const byHash = new Map<string, Secret[]>();
  for (const s of secrets) byHash.set(s.hash, [...(byHash.get(s.hash) ?? []), s]);
  for (const list of byHash.values()) {
    const files = new Set(list.map((s) => s.location.file));
    if (files.size < 2) continue;
    findings.push({
      rule: "copied-secret",
      severity: "medium",
      title: `Same ${list[0]!.kind} copied into ${files.size} files`,
      detail: `One credential is pasted into ${files.size} separate config files (${[...new Set(list.map((s) => CLIENT_NAMES[s.server.client]))].join(", ")}). Rotating or revoking it means finding every copy.`,
      fix: "Keep one copy in your environment or keychain and reference it from each client, or route the clients through one gateway.",
      locations: list.map((s) => s.location),
      weight: 2,
    });
  }

  // Config files that hold secrets and that other accounts on the machine can actually reach.
  const secretFiles = new Set(secrets.map((s) => s.location.file));
  for (const f of d.files) {
    if (f.mode === undefined || !f.exposure || !secretFiles.has(f.path)) continue;
    const [open, who] = f.exposure === "others" ? ["everyone", "every account on this machine"] : ["its group", "other accounts in that group"];
    findings.push({
      rule: "readable-config",
      severity: "medium",
      title: "Config file with secrets is readable by other accounts",
      detail: `This file holds plaintext secrets and has permissions ${f.mode.toString(8).padStart(3, "0")}, and every folder above it is open to ${open}, so ${who} can read it.`,
      fix: `Restrict it to your user: chmod 600 ${shellPath(f.path, home)}`,
      locations: [{ file: f.path, pointer: "(file permissions)" }],
      weight: 4,
    });
  }

  for (const s of d.servers) {
    if (s.url) {
      try {
        const u = new URL(s.url);
        if (u.protocol === "http:" && !LOOPBACK.test(u.hostname)) {
          findings.push({
            rule: "insecure-transport",
            severity: "high",
            title: `Unencrypted remote server: ${label(s)}`,
            detail: `${u.host} is reached over plain http://, so requests, tool results and any credentials travel unencrypted.`,
            fix: "Use the server's https:// endpoint.",
            locations: [at(s, "url")],
            weight: 10,
          });
        }
      } catch {
        // Not a URL; nothing to check.
      }
    }

    const pkg = packageOf(s);
    if (pkg && !isPinned(pkg)) {
      const where = pkg.registry === "docker" ? "image" : "package";
      findings.push({
        rule: "unpinned-package",
        severity: "medium",
        title: `Unpinned ${where}: ${label(s)}`,
        detail: `${pkg.name}${pkg.version ? `@${pkg.version}` : ""} resolves to whatever version is newest each time the server starts, so a compromised or broken release runs with this server's access.`,
        fix:
          pkg.registry === "docker"
            ? `Pin an image digest or exact tag, for example ${pkg.name}:<version>.`
            : `Pin an exact version, for example ${pkg.name}${pkg.registry === "pypi" ? "==" : "@"}<version>.`,
        locations: [pkg.argIndex >= 0 ? at(s, "args", String(pkg.argIndex)) : at(s, "command")],
        weight: 4,
      });
    }

    const w = words(s).list;
    if (pkg?.registry === "docker") {
      const risky = w.filter((a) => a === "--privileged" || /\/var\/run\/docker\.sock/.test(a) || a === "--net=host" || a === "--network=host");
      if (risky.length) {
        findings.push({
          rule: "privileged-container",
          severity: "high",
          title: `Container with host-level access: ${label(s)}`,
          detail: `The server runs with ${[...new Set(risky)].join(", ")}, which gives it effective control of the host.`,
          fix: "Remove --privileged and the Docker socket mount unless the server truly needs them.",
          locations: [at(s, "args")],
          weight: 10,
        });
      }
    }

    const roots = broadRoots(s, home);
    if (roots.length) {
      findings.push({
        rule: "broad-filesystem",
        severity: "medium",
        title: `Filesystem server can read ${roots.includes("/") ? "the whole disk" : "your whole home folder"}: ${label(s)}`,
        detail: `Allowed root ${roots.join(", ")} includes SSH keys, cloud credentials and every other config file.`,
        fix: "Allow only the project folders the agent needs.",
        locations: [at(s, "args")],
        weight: 4,
      });
    }

    if (s.autoApproved.length) {
      findings.push({
        rule: "auto-approved-tools",
        severity: "low",
        title: `${s.autoApproved.length} tool${s.autoApproved.length === 1 ? "" : "s"} run without asking: ${label(s)}`,
        detail: `Auto-approved: ${s.autoApproved.slice(0, 6).join(", ")}${s.autoApproved.length > 6 ? ", …" : ""}. A prompt injection in any content the agent reads can call these.`,
        fix: "Keep auto-approval to read-only tools.",
        locations: [at(s)],
        weight: 1,
      });
    }
  }

  for (const a of d.approvals) {
    const all = a.subject === "mcp__*" || a.subject.startsWith("every");
    findings.push({
      rule: "auto-approved-tools",
      severity: "medium",
      title: all
        ? `${CLIENT_NAMES[a.client]} approves ${a.subject === "mcp__*" ? "every MCP tool" : a.subject} without asking`
        : `${CLIENT_NAMES[a.client]} runs every tool of ${a.subject.replace(/^mcp__/, "").replace(/__\*$/, "")} without asking`,
      detail: `Permission rule ${a.subject} skips the confirmation prompt, including for write and delete tools. A prompt injection in a web page, issue or email the agent reads can call them.`,
      fix: "Allow specific read-only tools (mcp__server__tool) instead of whole servers.",
      locations: [a.location],
      weight: 4,
    });
  }

  // The same server configured separately in several clients. Context only: remote servers need an
  // entry per client, and copies that carry credentials are already scored by copied-secret.
  const byIdentity = new Map<string, ServerEntry[]>();
  for (const s of d.servers) {
    const id = identityOf(s);
    if (id && !TOOLSTILE.test(id)) byIdentity.set(id, [...(byIdentity.get(id) ?? []), s]);
  }
  for (const list of byIdentity.values()) {
    const clients = [...new Set(list.map((s) => s.client))] as ClientId[];
    if (clients.length < 2) continue;
    findings.push({
      rule: "duplicated-server",
      severity: "info",
      title: `${list[0]!.name} is set up separately in ${clients.length} clients`,
      detail: `Configured in ${clients.map((c) => CLIENT_NAMES[c]).join(", ")}. Each copy has its own settings and sign-in to keep in sync and revoke.`,
      fix: "Nothing to fix; listed so you know where each copy lives.",
      locations: list.map((s) => at(s)),
      weight: 0,
    });
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * 100 / (1 + weight / 50): one leaked secret (10) scores 83, four score about 50, and the score
 * keeps separating bad setups from worse ones instead of bottoming out at zero.
 */
export function score(findings: Finding[]): { score: number; grade: string } {
  const weight = findings.reduce((n, f) => n + f.weight, 0);
  const total = Math.round(100 / (1 + weight / 50));
  const grade = total >= 90 ? "A" : total >= 75 ? "B" : total >= 60 ? "C" : total >= 40 ? "D" : "F";
  return { score: total, grade };
}
