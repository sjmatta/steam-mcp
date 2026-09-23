import { SteamError } from "../errors.js";

/**
 * Builds the JavaScript sent to Steam's page for one evaluation.
 *
 * Kept separate from the transport so it can be exercised without a socket:
 * this string is the entire contract between our TypeScript and Steam's runtime,
 * and a mistake here fails in a very confusing way inside someone else's app.
 */

/** Envelope every in-page program returns, so page errors arrive as data. */
export interface PageResult<R> {
  ok: boolean;
  v?: R;
  e?: string;
  s?: string;
}

export function buildExpression(fnSource: string, arg: unknown): string {
  return `(async () => {
  const __name = (f) => f;
  try {
    const __r = await (${fnSource})(${JSON.stringify(arg) ?? "undefined"});
    return { ok: true, v: __r };
  } catch (e) { return { ok: false, e: String((e && e.message) || e), s: String((e && e.stack) || "") }; }
})()`;
}

/**
 * Turns a raw Runtime.evaluate reply into the program's return value, or the
 * appropriate SteamError. Separated from the socket so the whole decode path —
 * including every malformed-response branch — is unit testable.
 */
export function interpretEvalResult<R>(
  raw: {
    result?: { value?: PageResult<R> };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  },
  label: string,
): R {
  if (raw?.exceptionDetails) {
    const detail =
      raw.exceptionDetails.exception?.description ?? raw.exceptionDetails.text ?? "unknown";
    throw new SteamError("EVAL_FAILED", `Steam threw while running "${label}": ${detail}`);
  }

  const payload = raw?.result?.value;
  if (!payload || typeof payload.ok !== "boolean") {
    throw new SteamError("EVAL_FAILED", `Steam returned an unexpected payload for "${label}".`, {
      details: { payload },
    });
  }
  if (!payload.ok) {
    throw new SteamError("EVAL_FAILED", `Steam threw while running "${label}": ${payload.e}`, {
      details: { stack: payload.s },
    });
  }
  return payload.v as R;
}

/**
 * Compiler helpers that must never appear in shipped page source. `__name` is
 * esbuild's keepNames wrapper (so `npm run dev` via tsx differs from a tsc
 * build); the rest are TypeScript downlevel helpers. The expression defines a
 * `__name` shim so both toolchains work, but a helper we do NOT shim would be a
 * hard runtime failure inside Steam.
 */
const FORBIDDEN_PAGE_TOKENS =
  /\b(__awaiter|__generator|__spreadArray|__assign|__rest|__importDefault|__importStar|tslib)\b|\brequire\s*\(|\bimport\s*\(/;

/** Identifiers from our own modules; presence means a closure capture. */
const MODULE_LEAK_TOKENS =
  /\b(SteamError|cdp|createCache|RateLimiter|defaultPaths|readInstalledApps)\b/;

export interface PageFnAudit {
  ok: boolean;
  problems: string[];
  length: number;
}

/**
 * Static audit of a function about to be shipped to the page. Used by tests to
 * catch closure captures and helper injection before they reach Steam.
 */
export function auditPageFunction(fn: unknown): PageFnAudit {
  const problems: string[] = [];
  if (typeof fn !== "function") {
    return { ok: false, problems: ["not a function"], length: 0 };
  }

  const src = fn.toString();
  const trimmed = src.trim();

  const helper = FORBIDDEN_PAGE_TOKENS.exec(trimmed);
  if (helper) problems.push(`compiler helper or module plumbing in page source: ${helper[0]}`);

  const leak = MODULE_LEAK_TOKENS.exec(trimmed);
  if (leak) problems.push(`captures module-scoped identifier: ${leak[0]}`);

  const standalone = /^(async\s*)?\(/.test(trimmed) || /^(async\s+)?function\b/.test(trimmed);
  if (!standalone) problems.push("not a standalone-callable function expression");

  return { ok: problems.length === 0, problems, length: src.length };
}
