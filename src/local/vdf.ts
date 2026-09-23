/**
 * Minimal parser for Valve's text KeyValues format (.vdf / .acf).
 *
 * Grammar is just quoted tokens and braces:
 *
 *   "AppState"
 *   {
 *       "appid"  "3219010"
 *       "UserConfig"  { "language" "english" }
 *   }
 *
 * Unquoted tokens are legal in the wild, as are `//` comments and
 * `#include`-style directives; we handle the first two and ignore the third.
 * Duplicate sibling keys keep the last occurrence, matching Steam's own
 * behaviour when it re-reads these files.
 */

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

class Cursor {
  constructor(
    readonly src: string,
    public pos = 0,
  ) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  /** Advances past whitespace and `//` line comments. */
  skipTrivia(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (WHITESPACE.has(c)) {
        this.pos++;
        continue;
      }
      if (c === "/" && this.src[this.pos + 1] === "/") {
        const nl = this.src.indexOf("\n", this.pos);
        this.pos = nl === -1 ? this.src.length : nl + 1;
        continue;
      }
      break;
    }
  }

  peek(): string | undefined {
    return this.src[this.pos];
  }

  readToken(): string {
    const c = this.src[this.pos];
    if (c === '"') return this.readQuoted();
    return this.readBare();
  }

  private readQuoted(): string {
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        this.pos += 2;
        switch (next) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case "\\":
            out += "\\";
            break;
          case '"':
            out += '"';
            break;
          default:
            // Unknown escape: Steam keeps the backslash verbatim.
            out += "\\" + (next ?? "");
        }
        continue;
      }
      if (c === '"') {
        this.pos++;
        return out;
      }
      out += c;
      this.pos++;
    }
    return out; // unterminated string: return what we have
  }

  private readBare(): string {
    const start = this.pos;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (WHITESPACE.has(c) || c === "{" || c === "}" || c === '"') break;
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }
}

function parseObject(cur: Cursor): VdfObject {
  const obj: VdfObject = {};
  for (;;) {
    cur.skipTrivia();
    if (cur.eof()) return obj;

    const c = cur.peek();
    if (c === "}") {
      cur.pos++;
      return obj;
    }

    const key = cur.readToken();
    if (key === "") {
      // Guard against zero-width progress on malformed input.
      cur.pos++;
      continue;
    }

    cur.skipTrivia();
    if (cur.peek() === "{") {
      cur.pos++;
      obj[key] = parseObject(cur);
    } else {
      obj[key] = cur.readToken();
    }
  }
}

/** Parses a full VDF document into a nested object. */
export function parseVdf(text: string): VdfObject {
  // Strip a UTF-8 BOM; Steam writes these occasionally.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return parseObject(new Cursor(src));
}

/**
 * Case-insensitive path lookup. Steam is inconsistent about casing across
 * client versions ("Software"/"software", "Valve"/"valve"), so every lookup
 * into these files must tolerate it.
 */
export function vdfGet(root: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
  let node: VdfValue | undefined = root;
  for (const segment of path) {
    if (typeof node !== "object" || node === null) return undefined;
    const direct = node[segment];
    if (direct !== undefined) {
      node = direct;
      continue;
    }
    const lower = segment.toLowerCase();
    const hit = Object.keys(node).find((k) => k.toLowerCase() === lower);
    if (hit === undefined) return undefined;
    node = node[hit];
  }
  return node;
}

export function vdfGetObject(root: VdfValue | undefined, ...path: string[]): VdfObject | undefined {
  const v = vdfGet(root, ...path);
  return typeof v === "object" && v !== null ? v : undefined;
}

export function vdfGetString(root: VdfValue | undefined, ...path: string[]): string | undefined {
  const v = vdfGet(root, ...path);
  return typeof v === "string" ? v : undefined;
}

export function vdfGetNumber(root: VdfValue | undefined, ...path: string[]): number | undefined {
  const s = vdfGetString(root, ...path);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
