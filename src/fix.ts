import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { withoutTomlTable, writeText } from "./agents.js";
import { isPinned, packageOf, type Secret, secretsOf, shellPath, words } from "./checks.js";
import type { ReadStream, WriteStream } from "node:tty";
import { audit } from "./index.js";
import { parseConfig } from "./parse.js";
import { checklist } from "./prompt.js";
import { type Style, tildify, wrap } from "./report.js";
import { CLIENT_NAMES, discover, pointerJoin, type ScanOptions } from "./sources.js";
import { stateDir } from "./state.js";
import type { ClientId, Severity, ServerEntry } from "./types.js";

type Key = string | number;

/** One edit to a config file. TOML edits rewrite the server's table from the edited data. */
/** `was` is the value the plan saw; a file changed since then is left alone. */
type Op =
  | { type: "set"; file: string; path: Key[]; value: unknown; was?: unknown }
  | { type: "remove"; file: string; path: Key[]; was?: unknown }
  /** Removes a string from an array, wherever it sits by the time the edit runs. */
  | { type: "remove-item"; file: string; path: Key[]; value: string }
  /** Adds a string to an array (created when missing) unless it is already there. */
  | { type: "append"; file: string; path: Key[]; value: string }
  | { type: "chmod"; file: string; mode: number };

export interface Fix {
  rule: string;
  severity: Severity;
  /** One line for the checklist. */
  label: string;
  file: string;
  /** What changes where. Secret values are shown as •••• and never printed. */
  changes: Change[];
  /** Selected at first; approval changes alter how the agent works, so they start off. */
  checked: boolean;
  ops: Op[];
  /** Variables this fix moves into the secrets file. */
  secrets: { name: string; value: string }[];
}

export interface Change {
  /** Key inside the file, or a description such as `permissions`. */
  where: string;
  from: string;
  to: string;
}

export interface ManualFix {
  severity: Severity;
  subject: string;
  reason: string;
}

export interface Plan {
  fixes: Fix[];
  manual: ManualFix[];
  secretsFile: string;
  /** The shell file that loads the secrets file, or null where `--fix` cannot load one (Windows). */
  profile: { path: string; line: string } | null;
  /** Packages whose current version was looked up on npm or PyPI. */
  lookedUp: number;
}

export interface PlanOptions extends ScanOptions {
  fetch?: typeof fetch;
}

const label = (s: ServerEntry) => `${s.name} (${CLIENT_NAMES[s.client]})`;
const MASK = "••••";

/** How each client writes a reference to an environment variable, where it supports one. */
const REFERENCE: Partial<Record<ClientId, (name: string) => string>> = {
  "claude-code": (name) => `\${${name}}`,
  gemini: (name) => `\${${name}}`,
  cursor: (name) => `\${env:${name}}`,
  windsurf: (name) => `\${env:${name}}`,
  vscode: (name) => `\${env:${name}}`,
};

const envName = (text: string) => {
  const name = text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(name) ? `_${name}` : name || "SECRET";
};

/** The file `--fix` keeps moved secrets in, next to the CLI's credentials. */
export const secretsPath = (opts: { home: string; env: Record<string, string | undefined>; platform: NodeJS.Platform }) =>
  join(stateDir(opts), "secrets.env");

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Reads `export NAME='value'` lines written by an earlier `--fix`. */
function readSecrets(path: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^export ([A-Za-z_][A-Za-z0-9_]*)='(.*)'$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.replace(/'\\''/g, "'"));
  }
  return out;
}

/** The startup file of the user's shell, and the line that loads the secrets file from it. */
export function profileFor(opts: PlanOptions, secretsFile: string): Plan["profile"] {
  if (opts.platform === "win32") return null;
  const shell = basename(opts.env.SHELL ?? "");
  const file = shellPath(secretsFile, opts.home);
  if (shell === "fish") {
    const config = opts.env.XDG_CONFIG_HOME ?? join(opts.home, ".config");
    return { path: join(config, "fish", "conf.d", "toolstile.fish"), line: `test -f ${file}; and source ${file}` };
  }
  const path =
    shell === "zsh"
      ? join(opts.env.ZDOTDIR ?? opts.home, ".zshrc")
      : shell === "bash"
        ? join(opts.home, opts.platform === "darwin" ? ".bash_profile" : ".bashrc")
        : join(opts.home, ".profile");
  return { path, line: `[ -f ${file} ] && . ${file}  # MCP server secrets, added by toolstile audit --fix` };
}

/** Picks a variable name per secret: one name per value, never one already holding something else. */
class Names {
  private readonly taken = new Map<string, string>();
  private readonly byValue = new Map<string, string>();

  constructor(
    stored: Map<string, string>,
    private readonly env: Record<string, string | undefined>,
  ) {
    for (const [name, value] of stored) this.claim(name, value);
  }

  private claim(name: string, value: string) {
    this.taken.set(name, value);
    if (!this.byValue.has(value)) this.byValue.set(value, name);
  }

  /** Whether `name` is free for `value`: unused, or already holding that same value. */
  fits(name: string, value: string) {
    const held = this.taken.get(name) ?? this.env[name];
    return held === undefined || held === value;
  }

  pick(bases: string[], value: string, exact = false): string | null {
    const known = this.byValue.get(value);
    if (known && !exact) return known;
    const candidates = exact
      ? bases.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      : [...bases, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${bases[0]}_${n}`)].map(envName);
    for (const name of candidates) {
      if (this.fits(name, value)) {
        this.claim(name, value);
        return name;
      }
    }
    return null;
  }
}

interface SecretMove {
  ops: Op[];
  change: Change;
  secret: { name: string; value: string };
}

/** Plans moving one secret into a variable, or returns why it has to be moved by hand. */
function moveSecret(sec: Secret, names: Names): SecretMove | string {
  const s = sec.server;
  const [where, key] = sec.keys;
  const at = (...keys: Key[]): Key[] => [...s.path, ...keys];
  const pointer = sec.location.pointer;
  const server = envName(s.name);
  const scheme = /^(Bearer|token)\s+(\S+)$/i.exec(sec.value.trim());
  if (/[\r\n]/.test(sec.value)) return "it spans several lines, so it cannot go in the secrets file";

  if (s.client === "codex") {
    if (where === "env" && key) {
      // Codex passes only variables named in env_vars, under their own name, so the key is kept as written.
      const name = names.pick([key], sec.value, true);
      if (!name)
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          ? `${key} is already set to something else in your environment`
          : `${key} is not a name a shell variable can have`;
      return {
        ops: [
          { type: "remove", file: s.file, path: at("env", key), was: sec.value },
          { type: "append", file: s.file, path: at("env_vars"), value: name },
        ],
        change: { where: pointer, from: `"${MASK}"`, to: `removed; env_vars = ["${name}"] passes $${name} through` },
        secret: { name, value: sec.value },
      };
    }
    const bearer = (where === "http_headers" && /^authorization$/i.test(key ?? "") && scheme?.[1]?.toLowerCase() === "bearer") || where === "bearer_token";
    if (bearer) {
      const raw = where === "bearer_token" ? sec.value.trim() : scheme![2]!;
      const name = names.pick([`${server}_TOKEN`], raw);
      if (!name) return "no free variable name";
      return {
        ops: [
          { type: "remove", file: s.file, path: at(...sec.keys), was: sec.value },
          { type: "set", file: s.file, path: at("bearer_token_env_var"), value: name },
        ],
        change: { where: pointer, from: `"${scheme ? "Bearer " : ""}${MASK}"`, to: `removed; bearer_token_env_var = "${name}"` },
        secret: { name, value: raw },
      };
    }
    if (where === "http_headers" && key) {
      const name = names.pick([`${server}_${key}`], sec.value);
      if (!name) return "no free variable name";
      return {
        ops: [
          { type: "remove", file: s.file, path: at("http_headers", key), was: sec.value },
          { type: "set", file: s.file, path: at("env_http_headers", key), value: name },
        ],
        change: { where: pointer, from: `"${MASK}"`, to: `removed; env_http_headers.${key} = "${name}"` },
        secret: { name, value: sec.value },
      };
    }
    return "only env and header values can be moved for you";
  }

  const ref = REFERENCE[s.client];
  if (!ref) return `${CLIENT_NAMES[s.client]} does not read environment variables in its config`;
  if (where === "env" && key) {
    const name = names.pick([key, `${server}_${key}`], sec.value);
    if (!name) return "no free variable name";
    return {
      ops: [{ type: "set", file: s.file, path: at("env", key), value: ref(name), was: sec.value }],
      change: { where: pointer, from: `"${MASK}"`, to: `"${ref(name)}"` },
      secret: { name, value: sec.value },
    };
  }
  if (where === "headers" && key) {
    // `Bearer <token>` keeps its scheme in the config and only the token moves.
    const [prefix, value, base] = scheme ? [`${scheme[1]} `, scheme[2]!, `${server}_TOKEN`] : ["", sec.value, `${server}_${key}`];
    const name = names.pick([base], value);
    if (!name) return "no free variable name";
    return {
      ops: [{ type: "set", file: s.file, path: at("headers", key), value: `${prefix}${ref(name)}`, was: sec.value }],
      change: { where: pointer, from: `"${prefix}${MASK}"`, to: `"${prefix}${ref(name)}"` },
      secret: { name, value },
    };
  }
  return "only env and header values can be moved for you";
}

const registryUrl = (registry: "npm" | "pypi", name: string, tag: string) =>
  registry === "npm"
    ? `https://registry.npmjs.org/${name.replace("/", "%2F")}/${encodeURIComponent(tag)}`
    : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;

async function currentVersion(fetcher: typeof fetch, registry: "npm" | "pypi", name: string, tag: string): Promise<string | null> {
  try {
    const res = await fetcher(registryUrl(registry, name, tag), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown; info?: { version?: unknown } };
    const version = registry === "npm" ? body.version : body.info?.version;
    return typeof version === "string" && /^[\w.+-]+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Plans an exact-version pin, or returns why it has to be done by hand. */
async function pinPackage(s: ServerEntry, fetcher: typeof fetch): Promise<{ fix: Fix; looked: boolean } | string | null> {
  const pkg = packageOf(s);
  if (!pkg || isPinned(pkg)) return null;
  const w = words(s).list;
  const launcher = basename(w[0] ?? "").replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (pkg.registry === "docker") return "pin an image digest or an exact tag by hand";
  if (pkg.argIndex < 0 || s.args[pkg.argIndex] !== w[pkg.wordIndex]) return "the package is inside a single command string";
  if (pkg.registry === "pypi" && (launcher === "pipx" || /[[\]]/.test(pkg.name))) return "pin it by hand";
  const tag = pkg.version ?? "latest";
  if (pkg.registry === "pypi" ? pkg.version !== null : /[\^~*xX><| ]/.test(tag)) return `${pkg.name}@${tag} is a range; pick the version by hand`;
  const version = await currentVersion(fetcher, pkg.registry, pkg.name, tag);
  if (!version) return `could not look up the current version of ${pkg.name}`;
  const fromFlag = w[pkg.wordIndex - 1] === "--from";
  const spec = pkg.registry === "pypi" && fromFlag ? `${pkg.name}==${version}` : `${pkg.name}@${version}`;
  const before = s.args[pkg.argIndex]!;
  const pointer = pointerJoin(pointerJoin(s.pointer, "args"), String(pkg.argIndex));
  return {
    looked: true,
    fix: {
      rule: "unpinned-package",
      severity: "medium",
      label: `${label(s)}: pin ${pkg.name} to ${version}`,
      file: s.file,
      changes: [{ where: pointer, from: `"${before}"`, to: `"${spec}"` }],
      checked: true,
      ops: [{ type: "set", file: s.file, path: [...s.path, "args", pkg.argIndex], value: spec, was: before }],
      secrets: [],
    },
  };
}

/**
 * Works out every change `audit --fix` can make, without making any. Looks up the current
 * version of unpinned npm and PyPI packages; nothing else leaves the machine.
 */
export async function planFixes(opts: PlanOptions): Promise<Plan> {
  const d = discover(opts);
  const fixes: Fix[] = [];
  const manual: ManualFix[] = [];
  const secretsFile = secretsPath(opts);
  const profile = profileFor(opts, secretsFile);
  const saved = readSecrets(secretsFile);
  const fish = profile?.path.endsWith(".fish") ?? false;
  const names = new Names(saved, opts.env);

  for (const s of d.servers) {
    const secrets = secretsOf(s);
    if (!secrets.length) continue;
    if (!profile) {
      manual.push({ severity: "high", subject: label(s), reason: "move its secrets into environment variables by hand" });
      continue;
    }
    const moves: SecretMove[] = [];
    for (const sec of secrets) {
      let move = moveSecret(sec, names);
      // fish reads backslashes inside single quotes as escapes.
      if (typeof move !== "string" && fish && move.secret.value.includes("\\")) move = "it contains a backslash, which fish would read differently";
      if (typeof move === "string") manual.push({ severity: "high", subject: `${label(s)} ${sec.location.pointer}`, reason: move });
      else moves.push(move);
    }
    if (!moves.length) continue;
    const vars = [...new Set(moves.map((m) => m.secret.name))];
    fixes.push({
      rule: "plaintext-secret",
      severity: "high",
      label: `${label(s)}: move ${moves.length === 1 ? "secret" : `${moves.length} secrets`} to ${vars.map((v) => `$${v}`).join(", ")}`,
      file: s.file,
      changes: moves.map((m) => m.change),
      checked: true,
      ops: moves.flatMap((m) => m.ops),
      // A value already set under that name, by the secrets file or the user's own shell setup, is
      // not saved again: a second copy would outlive the user rotating their own.
      secrets: moves.map((m) => m.secret).filter((x) => saved.get(x.name) !== x.value && opts.env[x.name] !== x.value),
    });
  }

  const secretFiles = new Set(d.servers.filter((s) => secretsOf(s).length).map((s) => s.file));
  for (const f of d.files) {
    if (f.mode === undefined || !f.exposure || !secretFiles.has(f.path)) continue;
    fixes.push({
      rule: "readable-config",
      severity: "medium",
      label: `${tildify(f.path, opts.home)}: readable only by you`,
      file: f.path,
      changes: [{ where: "(file permissions)", from: f.mode.toString(8).padStart(3, "0"), to: "600" }],
      checked: true,
      ops: [{ type: "chmod", file: f.path, mode: 0o600 }],
      secrets: [],
    });
  }

  const fetcher = opts.fetch ?? fetch;
  const pins = await Promise.all(d.servers.map((s) => pinPackage(s, fetcher)));
  let lookedUp = 0;
  pins.forEach((pin, i) => {
    if (pin === null) return;
    if (typeof pin === "string") manual.push({ severity: "medium", subject: `${label(d.servers[i]!)} unpinned package`, reason: pin });
    else {
      lookedUp++;
      fixes.push(pin.fix);
    }
  });

  for (const a of d.approvals) {
    const enableAll = a.location.pointer === "enableAllProjectMcpServers";
    fixes.push({
      rule: "auto-approved-tools",
      severity: "medium",
      label: enableAll
        ? `${CLIENT_NAMES[a.client]}: ask before using a project's MCP servers`
        : `${CLIENT_NAMES[a.client]}: ask before ${a.subject} tools run`,
      file: a.location.file,
      changes: [
        enableAll
          ? { where: "enableAllProjectMcpServers", from: "true", to: "removed" }
          : { where: a.location.pointer, from: `"${a.subject}"`, to: "removed" },
      ],
      checked: false,
      ops: [
        enableAll
          ? { type: "remove", file: a.location.file, path: ["enableAllProjectMcpServers"], was: true }
          : { type: "remove-item", file: a.location.file, path: ["permissions", "allow"], value: a.subject },
      ],
      secrets: [],
    });
  }

  for (const s of d.servers) {
    if (s.url) {
      try {
        const u = new URL(s.url);
        if (u.protocol === "http:" && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname))
          manual.push({ severity: "high", subject: `${label(s)} uses http://`, reason: "switch to https:// if the server offers it" });
      } catch {}
    }
    if (s.autoApproved.length)
      manual.push({ severity: "low", subject: `${label(s)} auto-approves ${s.autoApproved.length} tools`, reason: "keep only read-only tools on its list" });
  }

  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  fixes.sort((a, b) => order[a.severity] - order[b.severity]);
  manual.sort((a, b) => order[a.severity] - order[b.severity]);
  return { fixes, manual, secretsFile, profile, lookedUp };
}

/** Keys sorted, so two parses of the same data compare equal whatever order the file uses. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Follows `path` in `data`, creating objects on the way when `create` is set. */
function parentOf(data: unknown, path: Key[], create: boolean): Record<Key, unknown> | null {
  let node = data as Record<Key, unknown>;
  for (const key of path.slice(0, -1)) {
    if (node[key] === undefined && create) node[key] = {};
    if (typeof node[key] !== "object" || node[key] === null) return null;
    node = node[key] as Record<Key, unknown>;
  }
  return node;
}

/** Applies an edit to parsed data; this is what the file must parse to afterwards. */
function applyToData(data: unknown, op: Exclude<Op, { type: "chmod" }>) {
  const last = op.path[op.path.length - 1]!;
  const parent = parentOf(data, op.path, op.type === "set" || op.type === "append");
  if (!parent) return;
  if (op.type === "set") parent[last] = op.value;
  else if (op.type === "remove") delete parent[last];
  else if (op.type === "append") {
    const list = Array.isArray(parent[last]) ? (parent[last] as unknown[]) : [];
    if (!list.includes(op.value)) parent[last] = [...list, op.value];
  } else if (Array.isArray(parent[last])) {
    parent[last] = (parent[last] as unknown[]).filter((x) => x !== op.value);
  }
}

/**
 * The file's new text, with comments and layout kept for JSON. A Codex server's table is
 * rewritten from its edited data at the end of the file. Throws when the result would not
 * parse to exactly the intended data.
 */
function editedText(file: string, text: string, ops: Exclude<Op, { type: "chmod" }>[]): string {
  const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  let body = bom ? text.slice(1) : text;
  const expected = parseConfig(file, body);
  const valueAt = (path: Key[]) => path.reduce<unknown>((node, key) => (node as Record<Key, unknown> | undefined)?.[key], expected);
  for (const op of ops)
    if ((op.type === "set" || op.type === "remove") && "was" in op && op.was !== undefined && valueAt(op.path) !== op.was)
      throw new Error("the file changed after the changes were listed; run --fix again");
  for (const op of ops) applyToData(expected, op);

  if (file.endsWith(".toml")) {
    const servers = (expected as { mcp_servers?: Record<string, unknown> }).mcp_servers ?? {};
    for (const name of new Set(ops.map((op) => String(op.path[1])))) {
      // Tables emptied by the edit (an `env` whose only secret moved) are dropped.
      const server = servers[name] as Record<string, unknown>;
      for (const [key, value] of Object.entries(server))
        if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !Object.keys(value).length)
          delete server[key];
      body = withoutTomlTable(body, name, stringifyToml({ mcp_servers: { [name]: server } }));
    }
  } else {
    const indent = body.match(/\n([ \t]+)"/)?.[1] ?? "  ";
    const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length };
    for (const op of ops) {
      let path = op.path;
      let value: unknown = op.type === "set" ? op.value : undefined;
      if (op.type === "remove-item" || op.type === "append") {
        const list = (path.reduce<unknown>((node, key) => (node as Record<Key, unknown> | undefined)?.[key], parseConfig(file, body)) ?? []) as unknown[];
        if (op.type === "append") value = list.includes(op.value) ? list : [...list, op.value];
        else {
          const index = list.indexOf(op.value);
          if (index === -1) continue;
          path = [...path, index];
        }
      }
      body = applyEdits(body, modify(body, path, value, { formattingOptions }));
    }
  }
  let actual: unknown;
  try {
    actual = parseConfig(file, body);
  } catch {
    actual = undefined;
  }
  if (canonical(actual) !== canonical(expected)) throw new Error("the edited file did not match the planned change");
  return bom + body;
}

export interface ApplyResult {
  applied: Fix[];
  failed: { fix: Fix; reason: string }[];
  backups: string | null;
  profileAdded: boolean;
}

/**
 * Makes the chosen changes. Every edited file is checked in memory first; secrets are saved
 * and the original files backed up before any config is rewritten.
 */
export function applyFixes(plan: Plan, chosen: Fix[], opts: { home: string; now?: Date }): ApplyResult {
  const failed: ApplyResult["failed"] = [];
  const byFile = new Map<string, Fix[]>();
  for (const fix of chosen) byFile.set(fix.file, [...(byFile.get(fix.file) ?? []), fix]);

  const texts = new Map<string, { before: string; after: string }>();
  for (const [file, fixes] of byFile) {
    const ops = fixes.flatMap((f) => f.ops).filter((op): op is Exclude<Op, { type: "chmod" }> => op.type !== "chmod");
    if (!ops.length) continue;
    try {
      const before = readFileSync(file, "utf8");
      const after = editedText(file, before, ops);
      if (after !== before) texts.set(file, { before, after });
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ? "the file could not be read" : (error as Error).message;
      for (const fix of fixes) if (fix.ops.some((op) => op.type !== "chmod")) failed.push({ fix, reason });
    }
  }
  const ok = chosen.filter((fix) => !failed.some((f) => f.fix === fix));

  // Secrets first: a config never points at a variable that was not saved.
  const secrets = ok.flatMap((f) => f.secrets);
  let profileAdded = false;
  if (secrets.length) {
    const stored = readSecrets(plan.secretsFile);
    let text = "";
    try {
      text = readFileSync(plan.secretsFile, "utf8");
    } catch {
      text = "# MCP server secrets moved out of agent configs by toolstile audit --fix.\n# Only your user can read this file. Loaded by your shell; see the line in your shell profile.\n";
    }
    for (const { name, value } of secrets) {
      if (stored.get(name) === value) continue;
      stored.set(name, value);
      text = `${text.replace(/\n?$/, "\n")}export ${name}=${quote(value)}\n`;
    }
    mkdirSync(dirname(plan.secretsFile), { recursive: true, mode: 0o700 });
    writeText(plan.secretsFile, text);
    chmodSync(plan.secretsFile, 0o600);
    if (plan.profile) {
      let profile = "";
      try {
        profile = readFileSync(plan.profile.path, "utf8");
      } catch {}
      if (!profile.includes(shellPath(plan.secretsFile, opts.home)) && !profile.includes(plan.secretsFile)) {
        const mode = existsSync(plan.profile.path) ? statSync(plan.profile.path).mode & 0o777 : 0o644;
        writeText(plan.profile.path, `${profile}${profile && !profile.endsWith("\n") ? "\n" : ""}\n${plan.profile.line}\n`);
        chmodSync(plan.profile.path, mode);
        profileAdded = true;
      }
    }
  }

  let backups: string | null = null;
  if (texts.size) {
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    backups = join(dirname(plan.secretsFile), "backups", stamp);
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const used = new Set<string>();
    for (const file of texts.keys()) {
      const flat = tildify(file, opts.home).replace(/^~[\\/]/, "").replace(/[\\/:]/g, "_");
      let name = flat;
      for (let n = 2; used.has(name); n++) name = `${flat}.${n}`;
      used.add(name);
      const copy = join(backups, name);
      copyFileSync(file, copy);
      chmodSync(copy, 0o600);
    }
    for (const [file, { after }] of texts) writeText(file, after);
  }
  for (const fix of ok) for (const op of fix.ops) if (op.type === "chmod") chmodSync(op.file, op.mode);
  return { applied: ok, failed, backups, profileAdded };
}

export interface FixRun extends PlanOptions {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  style: Style;
  /** Apply the changes that start selected, without asking. */
  yes: boolean;
  /** Only show the changes. */
  dryRun: boolean;
}

/** `toolstile audit --fix`: shows every change it can make, lets the user pick, then makes them. */
export async function runFix(o: FixRun): Promise<number> {
  const s = o.style;
  const width = Math.max(40, Math.min(o.stdout.columns || 80, 100) - 1);
  const out = (text = "") => o.stdout.write(`${text}\n`);
  const para = (text: string, indent: string) => indent + wrap(text, width - indent.length, indent);
  out();
  out(`${s.bold("toolstile audit --fix")} ${s.dim("· nothing changes until you confirm")}`);
  out();

  const before = audit(o);
  const plan = await planFixes(o);
  if (plan.lookedUp) {
    out(s.dim(`Looked up the current version of ${plan.lookedUp} package${plan.lookedUp === 1 ? "" : "s"} on npm or PyPI.`));
    out();
  }
  if (!plan.fixes.length && !plan.manual.length) {
    out(before.grade === null ? "No MCP servers found." : "Nothing to fix.");
    out();
    return 0;
  }

  if (plan.fixes.length) {
    out(s.bold(`Changes it can make (${plan.fixes.length})`));
    out();
    const pad = " ".repeat(13);
    plan.fixes.forEach((fix, i) => {
      const n = `${i + 1}.`.padEnd(4);
      const off = fix.checked ? "" : s.dim("  (off at first: changes how the agent works)");
      out(`  ${n}${s.sev(fix.severity, fix.severity.toUpperCase().padEnd(7))}${fix.label}${off}`);
      for (const c of fix.changes) {
        const where = `${tildify(fix.file, o.home)}  ${c.where}`;
        out(s.dim(where.length <= width - 13 ? `${pad}${where}` : para(where, pad)));
        out(`${pad}${s.sev("high", "-")} ${c.from}`);
        out(`${pad}${s.grade("A", "+")} ${c.to}`);
      }
    });
    out();
    if (plan.fixes.some((f) => f.secrets.length || f.rule === "plaintext-secret") && plan.profile) {
      out(
        para(
          `Moved secrets are saved in ${tildify(plan.secretsFile, o.home)}, which only you can read, and loaded by one line in ${tildify(plan.profile.path, o.home)}. Original files are backed up first.`,
          "  ",
        ),
      );
      out();
    }
  }
  if (plan.manual.length) {
    out(s.bold(`Needs a change by hand (${plan.manual.length})`));
    for (const m of plan.manual) out(para(`${s.sev(m.severity, "•")} ${m.subject}: ${s.dim(m.reason)}`, "    ").replace(/^ {4}/, "  "));
    out(s.dim(para("Run toolstile audit for the reasons and fixes.", "  ")));
    out();
  }
  if (!plan.fixes.length || o.dryRun) return 0;

  let chosen: Fix[];
  if (o.yes) chosen = plan.fixes.filter((f) => f.checked);
  else if (o.stdin.isTTY && o.stdout.isTTY) {
    const picked = await checklist(
      "Apply which changes?",
      plan.fixes.map((f, i) => ({ label: `${i + 1}. ${f.label}`, checked: f.checked })),
      o.stdin as unknown as ReadStream,
      o.stdout as unknown as WriteStream,
    );
    if (!picked) {
      out("Cancelled; nothing changed.");
      return 0;
    }
    chosen = plan.fixes.filter((_, i) => picked[i]);
  } else {
    out("Nothing changed. Run this in a terminal to choose changes, or add --yes to apply the ones that start selected.");
    return 0;
  }
  if (!chosen.length) {
    out("Nothing selected; nothing changed.");
    return 0;
  }

  const result = applyFixes(plan, chosen, o);
  out();
  for (const fix of result.applied) out(`  ${s.bold("✓")} ${fix.label}`);
  for (const { fix, reason } of result.failed) out(`  ${s.sev("high", "✗")} ${fix.label}: ${reason}; left unchanged`);
  out();
  if (result.backups) out(s.dim(para(`Original files: ${tildify(result.backups, o.home)} (they still hold any moved secrets; delete them once your agents work).`, "  ")));
  if (result.applied.some((f) => f.rule === "plaintext-secret")) {
    const load = `. ${shellPath(plan.secretsFile, o.home)}`;
    out(
      para(
        `Next: open a new terminal (or run ${s.bold(load)}) and restart your agents, so they start with the new variables.${result.profileAdded ? ` Added the line that loads them to ${tildify(plan.profile!.path, o.home)}.` : ""} Rotate any secret that was in a shared or synced file.`,
        "  ",
      ),
    );
  }
  const after = audit(o);
  if (before.grade !== null && after.grade !== null) {
    out();
    out(`  ${s.grade(before.grade, `Grade ${before.grade}`)} ${s.dim(`${before.score}`)} → ${s.bold(s.grade(after.grade, `Grade ${after.grade}`))} ${s.dim(`${after.score}/100`)}`);
  }
  out();
  return result.failed.length ? 1 : 0;
}
