import { parse as parseToml, TomlError } from "smol-toml";

/**
 * A config file that could not be parsed. The message is fixed text plus a position: parser
 * messages quote the offending source line, which can hold a secret, so they are never kept.
 */
export class ConfigParseError extends Error {
  constructor(
    readonly format: "JSON" | "TOML",
    readonly line?: number,
    readonly column?: number,
  ) {
    super(`invalid ${format}${line ? ` at line ${line}${column ? `, column ${column}` : ""}` : ""}`);
    this.name = "ConfigParseError";
  }
}

/**
 * Parses JSON that may contain comments and trailing commas (VS Code style). Comments and
 * trailing commas become spaces so parser positions still match the original text.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += blank(text[i]!);
        i++;
      }
      if (i < text.length) out += "\n";
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += blank(text[i]!);
      i--;
    } else {
      out += ch;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

/** Keeps line breaks so line numbers survive; everything else becomes a space. */
const blank = (ch: string) => (ch === "\n" || ch === "\r" ? ch : " ");

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        out += " ";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** 1-based line and column of a character offset. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.min(Math.max(offset, 0), text.length));
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
}

/** Reads only the position from a V8 JSON error; the rest of its message may quote the file. */
function jsonPosition(error: unknown, text: string): { line?: number; column?: number } {
  const message = error instanceof Error ? error.message : "";
  const at = /\bposition (\d+)/.exec(message);
  if (at) return lineColumn(text, Number(at[1]));
  if (/Unexpected end of JSON input/.test(message)) return lineColumn(text, text.length);
  return {};
}

/** Parses a config file. Throws only {@link ConfigParseError}, whose message never contains file text. */
export function parseConfig(path: string, text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (path.endsWith(".toml")) {
    try {
      return parseToml(body);
    } catch (error) {
      if (error instanceof TomlError) throw new ConfigParseError("TOML", error.line, error.column);
      throw new ConfigParseError("TOML");
    }
  }
  if (body.trim() === "") return {};
  try {
    return parseJsonc(body);
  } catch (error) {
    const { line, column } = jsonPosition(error, body);
    throw new ConfigParseError("JSON", line, column);
  }
}
