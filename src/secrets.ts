/**
 * Secret detection. Values are only classified here; callers never print them.
 */

const PATTERNS: [RegExp, string][] = [
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "GitLab token"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/, "OpenAI API key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bxapp-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/, "Linear API key"],
  [/\b(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,})/, "Notion token"],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/, "Stripe key"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "SendGrid key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
  [/\bsntr[ysu]_[A-Za-z0-9_=-]{30,}/, "Sentry token"],
  [/\bdop_v1_[a-f0-9]{64}\b/, "DigitalOcean token"],
  [/\bhf_[A-Za-z0-9]{30,}/, "Hugging Face token"],
  [/\bfig[dhu]_[A-Za-z0-9_-]{30,}/, "Figma token"],
  [/\bpplx-[A-Za-z0-9]{40,}/, "Perplexity API key"],
  [/\bgsk_[A-Za-z0-9]{40,}/, "Groq API key"],
  [/\bATATT3[A-Za-z0-9_=-]{40,}/, "Atlassian API token"],
  [/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/, "Shopify token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "JWT"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i, "password in connection string"],
];

const SECRET_KEY =
  /(token|secret|passw(or)?d|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth|bearer|session|cookie|\bpat\b|_pat$|^pat_|(^|[_-])key$)/i;

/** Key suffixes that name configuration about a secret, or a public half, rather than the secret itself. */
const NOT_SECRET_KEY = /(url|uri|endpoint|host|port|path|file|dir|type|mode|enabled|header|name|user(name)?|id|region|scope|scopes|method|env_var|_var|public[_-]?key)$/i;

const PLACEHOLDER =
  /^(<.*>|\{.*\}|\[.*\]|x{4,}|\*{3,}|\.{3,}|your[-_ ].*|change[-_ ]?me|todo|placeholder|example|redacted|none|null|undefined|true|false|test|secret|token)$/i;

/** True for `${VAR}`, `${env:VAR}`, `$VAR`, `%VAR%` and `{env:VAR}` references. */
export function isReference(value: string): boolean {
  const v = value.trim();
  return /^(Bearer\s+|Basic\s+|token\s+)?(\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\{env:[^}]+\})$/.test(v);
}

/** Returns a label for a known secret format in `value`, or null. */
export function matchPattern(value: string): string | null {
  for (const [re, label] of PATTERNS) if (re.test(value)) return label;
  return null;
}

/**
 * Classifies a literal value stored under `key`. Returns a label such as "GitHub token"
 * when it looks like a credential written into the file, or null.
 */
export function classify(key: string, value: string): string | null {
  const v = value.trim();
  if (!v || isReference(v)) return null;
  const known = matchPattern(v);
  if (known) return known;
  if (/^authorization$/i.test(key) || /^(Bearer|Basic|token)\s+\S{8,}$/i.test(v)) {
    return isReference(v) ? null : "authorization header";
  }
  if (!SECRET_KEY.test(key) || NOT_SECRET_KEY.test(key)) return null;
  if (v.length < 8 || PLACEHOLDER.test(v) || /\s/.test(v) || /^https?:\/\//i.test(v)) return null;
  if (/^\d+$/.test(v) || /^(\/|~\/|\.\/|[A-Za-z]:\\)/.test(v)) return null;
  return "credential";
}

/** URL query parameters that carry credentials. */
const URL_SECRET_PARAM = /^(token|access_token|api[_-]?key|apikey|key|secret|auth|password|pat|sig|signature)$/i;

export function urlSecret(url: string): string | null {
  const known = matchPattern(url);
  if (known) return known;
  try {
    const parsed = new URL(url);
    if (parsed.password) return "password in URL";
    for (const [k, v] of parsed.searchParams) {
      if (URL_SECRET_PARAM.test(k) && v.length >= 8 && !isReference(v)) return "credential in URL query";
    }
  } catch {
    return null;
  }
  return null;
}

/** Finds credentials passed as command-line arguments, e.g. `--api-key VALUE` or `--token=VALUE`. */
export function argSecrets(args: string[]): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = [];
  args.forEach((arg, i) => {
    const eq = /^--?([A-Za-z0-9_-]+)=(.+)$/.exec(arg);
    if (eq) {
      const label = classify(eq[1]!, eq[2]!);
      if (label) out.push({ index: i, label });
      return;
    }
    // `docker run -e KEY=VALUE` and similar.
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(arg);
    if (assign) {
      const label = classify(assign[1]!, assign[2]!);
      if (label) out.push({ index: i, label });
      return;
    }
    const prev = args[i - 1];
    const flag = prev && /^--?([A-Za-z0-9_-]+)$/.exec(prev);
    if (flag) {
      const label = classify(flag[1]!, arg);
      if (label) {
        out.push({ index: i, label });
        return;
      }
    }
    const known = matchPattern(arg);
    if (known) out.push({ index: i, label: known });
  });
  return out;
}
