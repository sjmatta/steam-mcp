/**
 * Structured error codes. These are surfaced to the model verbatim so it can
 * decide what to do next (e.g. STEAM_NOT_RUNNING -> suggest steam_restart)
 * rather than having to interpret prose.
 */
export type SteamErrorCode =
  | "STEAM_NOT_RUNNING"
  | "DEBUG_PORT_CLOSED"
  | "PORT_OCCUPIED"
  | "STORES_NOT_READY"
  | "TARGET_LOST"
  | "EVAL_TIMEOUT"
  | "EVAL_FAILED"
  | "DYNAMIC_COLLECTION"
  | "NOT_EDITABLE"
  | "NAME_COLLISION"
  | "COLLECTION_NOT_FOUND"
  | "APP_NOT_FOUND"
  | "WRITES_DISABLED"
  | "NEEDS_CONFIRMATION"
  | "UNSUPPORTED"
  | "NO_API_KEY"
  | "NO_ACCOUNT"
  | "RATE_LIMITED"
  | "LOCAL_READ_FAILED"
  | "NETWORK_ERROR";

export class SteamError extends Error {
  readonly code: SteamErrorCode;
  /** Free-form extra fields merged into the tool's error payload. */
  readonly details: Record<string, unknown>;
  /** What the caller should try next, in one sentence. */
  readonly hint?: string;

  constructor(
    code: SteamErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; hint?: string } = {},
  ) {
    super(message);
    this.name = "SteamError";
    this.code = code;
    this.details = opts.details ?? {};
    if (opts.hint) this.hint = opts.hint;
  }

  toPayload(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      error: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...this.details,
    };
  }
}

export function isSteamError(e: unknown): e is SteamError {
  return e instanceof SteamError;
}

/** Normalises any thrown value into an error payload for a tool response. */
export function toErrorPayload(e: unknown): Record<string, unknown> {
  if (isSteamError(e)) return e.toPayload();
  return {
    ok: false,
    code: "EVAL_FAILED",
    error: e instanceof Error ? e.message : String(e),
  };
}

export const writesDisabled = (): SteamError =>
  new SteamError(
    "WRITES_DISABLED",
    "Write operations are disabled. Set STEAM_MCP_ALLOW_WRITES=1 in the server environment to enable them.",
    { hint: "This is a deliberate safety default; the user must opt in." },
  );

export const needsConfirmation = (what: string, extra: Record<string, unknown> = {}): SteamError =>
  new SteamError("NEEDS_CONFIRMATION", `${what} Re-run with confirm: true to proceed.`, {
    details: extra,
  });
