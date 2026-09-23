import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cdp } from "../cdp/client.js";
import { getCollection } from "../cdp/programs/read.js";
import { collectionOp, setAppFlags, type CollectionOpArg } from "../cdp/programs/write.js";
import type { MutationResult } from "../cdp/programs/types.js";
import { SteamError, needsConfirmation } from "../errors.js";
import { KIND_NAMES } from "../library.js";
import { loadCollections, loadLibrary } from "../model.js";
import { resolveAppNames } from "../web/storebrowse.js";
import {
  appidsSchema,
  assertWritesAllowed,
  backupCollections,
  confirmSchema,
  handler,
  mapPageError,
  ok,
  paginationShape,
  registerStrictTool,
} from "./shared.js";

/** Replacing more than this many games needs explicit confirmation. */
const BULK_REMOVAL_THRESHOLD = 10;

const refShape = {
  id: z
    .string()
    .optional()
    .describe(
      'Collection id. Ids are opaque and may contain "+" and "*" (e.g. "uc-8qBpJj1*+Borh") - pass them back exactly as given.',
    ),
  name: z.string().optional().describe("Exact collection name. Alternative to id."),
};

function requireRef(args: { id?: string; name?: string }): string {
  const ref = args.id ?? args.name;
  if (!ref) {
    throw new SteamError("COLLECTION_NOT_FOUND", "Provide either id or name.", {
      hint: "Call steam_collections_list to see valid ids.",
    });
  }
  return ref;
}

/** Runs a mutation in the page and reports what actually changed. */
async function mutate(arg: CollectionOpArg, label: string): Promise<MutationResult> {
  try {
    return await cdp.evalInPage(collectionOp, arg, label);
  } catch (e) {
    return mapPageError(e, { op: arg.op, ref: arg.ref, name: arg.name });
  }
}

function mutationPayload(
  result: MutationResult,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    collection: { id: result.id, name: result.name, appCount: result.after.length },
    added: result.added,
    removed: result.removed,
    skipped: result.skipped,
    created: result.created,
    reused: result.reused,
    ...extra,
  };
}

export function registerCollectionTools(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_collections_list",
    {
      title: "List Steam collections",
      description:
        "List every library collection with its id, name, game count, and whether it is dynamic (filter-based, therefore read-only) or a Steam system collection. " +
        "Works with Steam closed, reading the last state Steam wrote to disk, in which case degraded=true.",
      inputSchema: {
        include_dynamic: z.boolean().default(true),
        include_system: z
          .boolean()
          .default(true)
          .describe("Include Steam's own collections such as Favorites and Hidden."),
      },
    },
    handler(
      async ({
        include_dynamic,
        include_system,
      }: {
        include_dynamic: boolean;
        include_system: boolean;
      }) => {
        const { collections, source, degraded } = await loadCollections();
        const filtered = collections.filter(
          (c) => (include_dynamic || !c.isDynamic) && (include_system || !c.isSystem),
        );
        return ok({
          total: filtered.length,
          source,
          degraded,
          collections: filtered.map((c) => ({
            id: c.id,
            name: c.name,
            appCount: c.appCount,
            ...(c.isDynamic ? { dynamic: true } : {}),
            ...(c.isSystem ? { system: true } : {}),
            editable: c.isEditable,
          })),
        });
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_collection_get",
    {
      title: "Get a collection and its games",
      description: "Return one collection with its games. Paginated.",
      inputSchema: {
        ...refShape,
        ...paginationShape,
        include_games: z.boolean().default(true),
      },
    },
    handler(
      async (args: {
        id?: string;
        name?: string;
        limit: number;
        offset: number;
        include_games: boolean;
      }) => {
        const ref = requireRef(args);

        let detail: {
          id: string;
          name: string;
          isDynamic: boolean;
          isEditable: boolean;
          isSystem: boolean;
          appids: number[];
        };
        let source = "live";
        let degraded = false;
        try {
          detail = await cdp.evalInPage(getCollection, { ref }, "getCollection");
        } catch (e) {
          // Offline fallback.
          const { collections, members, source: s, degraded: d } = await loadCollections();
          if (s === "live") mapPageError(e, { ref });
          const needle = ref.toLowerCase();
          const match =
            collections.find((c) => c.id === ref) ??
            collections.find((c) => c.name.toLowerCase() === needle);
          if (!match) mapPageError(new Error("COLLECTION_NOT_FOUND"), { ref });
          detail = { ...match, appids: members[match.id] ?? [] };
          source = s;
          degraded = d;
        }

        const payload: Record<string, unknown> = {
          collection: {
            id: detail.id,
            name: detail.name,
            appCount: detail.appids.length,
            dynamic: detail.isDynamic,
            system: detail.isSystem,
            editable: detail.isEditable,
          },
          source,
          degraded,
        };

        if (args.include_games) {
          const view = await loadLibrary();
          const byAppid = new Map(view.games.map((g) => [g.appid, g]));
          const page = detail.appids.slice(args.offset, args.offset + args.limit);
          payload["offset"] = args.offset;
          payload["returned"] = page.length;

          // A collection can reference apps the library snapshot does not know
          // (removed from the account, or a degraded offline read). Resolve
          // those from the store rather than emitting name: null.
          const unresolved = page.filter((appid) => !byAppid.get(appid));
          const extra =
            unresolved.length > 0 ? await resolveAppNames(unresolved) : new Map<number, string>();

          payload["games"] = page.map((appid) => {
            const g = byAppid.get(appid);
            return g
              ? {
                  appid,
                  name: g.name,
                  installed: g.installed,
                  playtimeMinutes: g.playtimeMinutes,
                  kind: KIND_NAMES[g.kind] ?? "unknown",
                }
              : { appid, name: extra.get(appid) ?? null, inLibrary: false };
          });
        }

        return ok(payload);
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_collection_create",
    {
      title: "Create a collection",
      description:
        "Create a static collection, optionally seeded with games. " +
        "If a collection with this name already exists it is REUSED and the games are added to it - Steam deletes a same-named collection when creating a duplicate, so this tool never blind-creates. " +
        "Requires Steam to be running with debugging enabled.",
      inputSchema: {
        name: z.string().min(1).max(64),
        appids: z.array(z.number().int().positive()).max(500).default([]),
        on_existing: z
          .enum(["reuse", "fail"])
          .default("reuse")
          .describe("What to do when a collection with this name already exists."),
        dry_run: z.boolean().default(false).describe("Report what would change without writing."),
      },
    },
    handler(
      async ({
        name,
        appids,
        on_existing,
        dry_run,
      }: {
        name: string;
        appids: number[];
        on_existing: "reuse" | "fail";
        dry_run: boolean;
      }) => {
        if (!dry_run) {
          assertWritesAllowed();
          backupCollections("create");
        }
        const result = await mutate(
          { op: "create", name, appids, onExisting: on_existing, dryRun: dry_run },
          "collection:create",
        );
        return ok(
          mutationPayload(result, {
            dry_run,
            verified: dry_run ? undefined : result.created || result.reused,
          }),
        );
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_collection_add_games",
    {
      title: "Add games to a collection",
      description:
        "Add games to an existing static collection. Refuses dynamic (filter-based) collections, where such edits are silently reverted by Steam.",
      inputSchema: {
        ...refShape,
        appids: appidsSchema,
        dry_run: z.boolean().default(false),
      },
    },
    handler(async (args: { id?: string; name?: string; appids: number[]; dry_run: boolean }) => {
      const ref = requireRef(args);
      if (!args.dry_run) {
        assertWritesAllowed();
        backupCollections("add");
      }
      const result = await mutate(
        { op: "add", ref, appids: args.appids, dryRun: args.dry_run },
        "collection:add",
      );
      const expected = new Set([
        ...result.before,
        ...args.appids.filter((a) => !result.skipped.some((s) => s.appid === a)),
      ]);
      return ok(
        mutationPayload(result, {
          dry_run: args.dry_run,
          verified: args.dry_run
            ? undefined
            : result.after.every((a) => expected.has(a)) && expected.size === result.after.length,
        }),
      );
    }),
  );

  registerStrictTool(
    server,
    "steam_collection_remove_games",
    {
      title: "Remove games from a collection",
      description:
        "Remove games from a static collection. The games stay in the library; only the collection membership changes.",
      inputSchema: {
        ...refShape,
        appids: appidsSchema,
        dry_run: z.boolean().default(false),
      },
    },
    handler(async (args: { id?: string; name?: string; appids: number[]; dry_run: boolean }) => {
      const ref = requireRef(args);
      if (!args.dry_run) {
        assertWritesAllowed();
        backupCollections("remove");
      }
      const result = await mutate(
        { op: "remove", ref, appids: args.appids, dryRun: args.dry_run },
        "collection:remove",
      );
      return ok(mutationPayload(result, { dry_run: args.dry_run }));
    }),
  );

  registerStrictTool(
    server,
    "steam_collection_replace_games",
    {
      title: "Replace a collection's games",
      description:
        "Replace the entire membership of a collection. DESTRUCTIVE: any game not in appids is removed from the collection. " +
        `Requires confirm=true when it would remove more than ${BULK_REMOVAL_THRESHOLD} games. Run with dry_run=true first to see the diff.`,
      inputSchema: {
        ...refShape,
        appids: z.array(z.number().int().positive()).max(500),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            `Required when the replacement removes more than ${BULK_REMOVAL_THRESHOLD} games.`,
          ),
        dry_run: z.boolean().default(false),
      },
    },
    handler(
      async (args: {
        id?: string;
        name?: string;
        appids: number[];
        confirm: boolean;
        dry_run: boolean;
      }) => {
        const ref = requireRef(args);

        // Work out the removal count before touching anything.
        const preview = await mutate(
          { op: "replace", ref, appids: args.appids, dryRun: true },
          "collection:replace:preview",
        );
        const keep = new Set(args.appids);
        const wouldRemove = preview.before.filter((a) => !keep.has(a));

        if (args.dry_run) {
          return ok({
            collection: { id: preview.id, name: preview.name, appCount: preview.before.length },
            dry_run: true,
            would_remove: wouldRemove,
            would_add: args.appids.filter((a) => !preview.before.includes(a)),
            skipped: preview.skipped,
          });
        }

        if (wouldRemove.length > BULK_REMOVAL_THRESHOLD && !args.confirm) {
          throw needsConfirmation(
            `This would remove ${wouldRemove.length} games from "${preview.name}".`,
            { would_remove_count: wouldRemove.length, collection: preview.name },
          );
        }

        assertWritesAllowed();
        backupCollections("replace", true);

        const result = await mutate(
          { op: "replace", ref, appids: args.appids },
          "collection:replace",
        );
        const expected = new Set(
          args.appids.filter((a) => !result.skipped.some((s) => s.appid === a)),
        );
        return ok(
          mutationPayload(result, {
            dry_run: false,
            verified:
              result.after.length === expected.size && result.after.every((a) => expected.has(a)),
          }),
        );
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_collection_rename",
    {
      title: "Rename a collection",
      description:
        "Rename a collection, keeping its id and membership. Renaming is preferred over delete-and-recreate because your library shelf layout references collection ids.",
      inputSchema: {
        ...refShape,
        new_name: z.string().min(1).max(64),
        dry_run: z.boolean().default(false),
      },
    },
    handler(async (args: { id?: string; name?: string; new_name: string; dry_run: boolean }) => {
      const ref = requireRef(args);
      if (!args.dry_run) {
        assertWritesAllowed();
        backupCollections("rename");
      }
      const result = await mutate(
        { op: "rename", ref, name: args.new_name, dryRun: args.dry_run },
        "collection:rename",
      );
      return ok({
        collection: { id: result.id, name: result.name, appCount: result.after.length },
        renamed_to: args.new_name,
        verified: args.dry_run ? undefined : result.name === args.new_name,
        dry_run: args.dry_run,
      });
    }),
  );

  registerStrictTool(
    server,
    "steam_collection_delete",
    {
      title: "Delete a collection",
      description:
        "Delete a collection. DESTRUCTIVE: the collection and its id are gone, and recreating it produces a NEW id. The games themselves are untouched, and Steam's collection files are backed up first. " +
        "Requires confirm=true. Run with dry_run=true first to see exactly which games would lose their membership.",
      inputSchema: {
        ...refShape,
        confirm: confirmSchema,
        dry_run: z
          .boolean()
          .default(false)
          .describe("Report what would be deleted without deleting anything."),
      },
    },
    handler(async (args: { id?: string; name?: string; confirm: true; dry_run: boolean }) => {
      const ref = requireRef(args);
      if (args.dry_run) {
        const preview = await mutate({ op: "delete", ref, dryRun: true }, "collection:delete:dry");
        return ok({
          dry_run: true,
          would_delete: {
            id: preview.id,
            name: preview.name,
            appCount: preview.before.length,
          },
          appids_that_would_lose_membership: preview.before,
          note: "Nothing was deleted. Re-run without dry_run to proceed.",
        });
      }

      assertWritesAllowed();
      const backup = backupCollections("delete", true);

      const result = await mutate({ op: "delete", ref }, "collection:delete");
      return ok({
        deleted: { id: result.id, name: result.name, appCount: result.before.length },
        appids_that_were_in_it: result.before,
        backup_path: backup,
        verified: result.after.length === 0,
        note: "To restore, create a collection with the same name and these appids. It will receive a new id.",
      });
    }),
  );

  registerStrictTool(
    server,
    "steam_set_favorite",
    {
      title: "Mark games as favorite",
      description: "Add games to, or remove them from, Steam's Favorites collection.",
      inputSchema: {
        appids: appidsSchema,
        value: z.boolean().describe("true to favorite, false to un-favorite."),
        dry_run: z.boolean().default(false),
      },
    },
    handler(
      async ({
        appids,
        value,
        dry_run,
      }: {
        appids: number[];
        value: boolean;
        dry_run: boolean;
      }) => {
        if (!dry_run) {
          assertWritesAllowed();
          backupCollections("favorite");
        }
        try {
          const result = await cdp.evalInPage(
            setAppFlags,
            { appids, flag: "favorite", value, dryRun: dry_run },
            "setFavorite",
          );
          const after = new Set(result.after);
          return ok({
            flag: "favorite",
            value,
            applied: result.applied,
            skipped: result.skipped,
            favoriteCount: result.after.length,
            verified: dry_run ? undefined : result.applied.every((a) => after.has(a) === value),
            dry_run,
          });
        } catch (e) {
          return mapPageError(e, { flag: "favorite" });
        }
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_set_hidden",
    {
      title: "Hide or unhide games",
      description:
        "Hide games from the Steam library, or unhide them. This affects the library view on every device signed into this account.",
      inputSchema: {
        appids: appidsSchema,
        value: z.boolean().describe("true to hide, false to unhide."),
        dry_run: z.boolean().default(false),
      },
    },
    handler(
      async ({
        appids,
        value,
        dry_run,
      }: {
        appids: number[];
        value: boolean;
        dry_run: boolean;
      }) => {
        if (!dry_run) {
          assertWritesAllowed();
          backupCollections("hidden");
        }
        try {
          const result = await cdp.evalInPage(
            setAppFlags,
            { appids, flag: "hidden", value, dryRun: dry_run },
            "setHidden",
          );
          const after = new Set(result.after);
          return ok({
            flag: "hidden",
            value,
            applied: result.applied,
            skipped: result.skipped,
            hiddenCount: result.after.length,
            verified: dry_run ? undefined : result.applied.every((a) => after.has(a) === value),
            dry_run,
          });
        } catch (e) {
          return mapPageError(e, { flag: "hidden" });
        }
      },
    ),
  );
}
