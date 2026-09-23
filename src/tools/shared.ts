import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allowWrites, backupDirPath } from "../config.js";
import { SteamError, toErrorPayload, writesDisabled } from "../errors.js";
import { namespaceSidecarFiles } from "../local/cloudstorage.js";
import { account } from "../model.js";

/**
 * Registers a tool whose arguments reject unrecognized keys.
 *
 * The SDK turns a bare ZodRawShape into a non-strict object, which silently
 * *strips* unknown keys — so a caller passing `dry_run: true` to a tool that has
 * no `dry_run` gets the real, destructive operation with no warning. (That is
 * not hypothetical; it deleted a collection during development.) The JSON Schema
 * the SDK advertises already says `additionalProperties: false`, so enforcing it
 * makes the runtime match the published contract rather than tightening it.
 */
export function registerStrictTool(
  server: McpServer,
  name: string,
  config: { inputSchema?: ZodRawShape } & Record<string, unknown>,
  cb: (args: never) => Promise<ToolResult>,
): void {
  const { inputSchema, ...rest } = config;
  const finalConfig =
    inputSchema === undefined ? rest : { ...rest, inputSchema: z.object(inputSchema).strict() };
  // The SDK's generics are written for the raw-shape form; the strict object is
  // accepted at runtime (normalizeObjectSchema passes ZodObjects through) and
  // each handler declares its own argument type.
  (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(
    name,
    finalConfig,
    cb,
  );
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Compact JSON in a single text block; token budget matters here. */
export function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }] };
}

function fail(e: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(toErrorPayload(e)) }],
    isError: true,
  };
}

/** Wraps a handler so domain errors come back as readable, actionable JSON. */
export function handler<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

export function assertWritesAllowed(): void {
  if (!allowWrites()) throw writesDisabled();
}

export const paginationShape = {
  limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return."),
  offset: z.number().int().min(0).default(0).describe("Rows to skip, for paging."),
};

export const appidsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(500)
  .describe("Steam appids. Use steam_library_search to resolve names to appids first.");

export const confirmSchema = z
  .literal(true)
  .describe("Must be true. Acknowledges the destructive effect described in this tool's summary.");

/**
 * Snapshots Steam's collection files before the first mutation of the session.
 *
 * Writes go through the live client, so these files are not what we edit — but
 * having them makes the 29 collections restorable if a write goes wrong.
 */
let backedUpThisSession = false;

export function backupCollections(reason: string, force = false): string | null {
  if (backedUpThisSession && !force) return null;

  try {
    const acct = account();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(backupDirPath(), `${stamp}-${reason}`);
    mkdirSync(dir, { recursive: true });

    let copied = 0;
    for (const file of namespaceSidecarFiles(acct.accountId)) {
      if (!existsSync(file)) continue;
      copyFileSync(file, join(dir, basename(file)));
      copied++;
    }
    if (copied === 0) {
      rmSync(dir, { recursive: true, force: true });
      return null;
    }

    backedUpThisSession = true;
    pruneBackups(20);
    return dir;
  } catch (e) {
    // A failed backup must not silently pass for a successful one.
    throw new SteamError(
      "LOCAL_READ_FAILED",
      `Could not back up Steam's collection files before writing: ${String(e)}`,
      { hint: "Check that the cache directory is writable." },
    );
  }
}

function pruneBackups(keep: number): void {
  try {
    const entries = readdirSync(backupDirPath(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
      rmSync(join(backupDirPath(), name), { recursive: true, force: true });
    }
  } catch {
    // Pruning is best-effort.
  }
}

/**
 * Translates the terse error strings thrown by in-page programs into the
 * structured errors the model can act on.
 */
export function mapPageError(e: unknown, context: Record<string, unknown> = {}): never {
  const message = e instanceof Error ? e.message : String(e);

  const contains = (needle: string): boolean => message.includes(needle);

  if (contains("DYNAMIC_COLLECTION")) {
    throw new SteamError(
      "DYNAMIC_COLLECTION",
      "That is a dynamic (filter-based) collection. Steam recomputes its membership from a filter, so adding or removing games is silently reverted.",
      {
        details: context,
        hint: "Edit the collection's filter in Steam, or use a static collection.",
      },
    );
  }
  if (contains("NOT_EDITABLE")) {
    throw new SteamError(
      "NOT_EDITABLE",
      "Steam does not allow editing that collection (it is a system or filter-backed collection).",
      { details: context },
    );
  }
  if (contains("NAME_COLLISION")) {
    throw new SteamError(
      "NAME_COLLISION",
      "More than one collection matches that name, or the name is reserved by Steam.",
      {
        details: context,
        hint: "Pass the collection id instead of the name; ids are listed by steam_collections_list.",
      },
    );
  }
  if (contains("COLLECTION_NOT_FOUND")) {
    throw new SteamError("COLLECTION_NOT_FOUND", "No collection matched that id or name.", {
      details: context,
      hint: "Call steam_collections_list to see valid ids.",
    });
  }
  if (contains("APP_NOT_FOUND")) {
    throw new SteamError("APP_NOT_FOUND", "That appid is not in your Steam library.", {
      details: context,
    });
  }
  if (contains("STORES_NOT_READY")) {
    throw new SteamError(
      "STORES_NOT_READY",
      "Steam is running but its library UI has not finished loading.",
      { details: context, hint: "Wait a few seconds and retry." },
    );
  }
  if (contains("UNSUPPORTED")) {
    throw new SteamError(
      "UNSUPPORTED",
      "This Steam client build does not expose the API needed for that operation.",
      { details: context },
    );
  }
  if (contains("INVALID_NAME")) {
    throw new SteamError("UNSUPPORTED", "A non-empty collection name is required.", {
      details: context,
    });
  }
  throw e;
}
