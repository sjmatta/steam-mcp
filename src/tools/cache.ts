import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cache } from "../cache.js";
import { loadLibrary } from "../model.js";
import { getReviewSummary, getStoreDetails } from "../web/store.js";
import { handler, ok, registerStrictTool } from "./shared.js";

/** Kept small on purpose: the store API allows ~200 requests per 5 minutes. */
const MAX_WARM_APPS = 60;

export function registerCacheTools(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_cache_refresh",
    {
      title: "Refresh cached Steam data",
      description:
        "Re-read the library from Steam, and optionally pre-fetch store metadata for specific games. " +
        `Store fetches are rate-limited to roughly one every 1.6s (Steam allows about 200 per 5 minutes), so at most ${MAX_WARM_APPS} appids are accepted per call and the call can take a couple of minutes.`,
      inputSchema: {
        library: z.boolean().default(true).describe("Re-read the library snapshot."),
        store_appids: z
          .array(z.number().int().positive())
          .max(MAX_WARM_APPS)
          .default([])
          .describe("Games to pre-fetch store metadata and review scores for."),
        force: z.boolean().default(false).describe("Refetch even if already cached and fresh."),
      },
    },
    handler(
      async ({
        library,
        store_appids,
        force,
      }: {
        library: boolean;
        store_appids: number[];
        force: boolean;
      }) => {
        const result: Record<string, unknown> = { cache_dir: cache().dir };

        if (library) {
          const view = await loadLibrary({ force: true });
          result["library"] = {
            games: view.games.length,
            source: view.source,
            degraded: view.degraded,
          };
        }

        if (store_appids.length > 0) {
          let fetched = 0;
          let missing = 0;
          for (const appid of store_appids) {
            const details = await getStoreDetails(appid, { force });
            await getReviewSummary(appid, { force });
            if (details.success) fetched++;
            else missing++;
          }
          result["store"] = { requested: store_appids.length, fetched, unavailable: missing };
        }

        return ok(result);
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_cache_clear",
    {
      title: "Clear cached Steam data",
      description:
        "Delete this server's cached data. Steam's own files are never touched, and collection backups are preserved.",
      inputSchema: {
        scope: z
          .enum(["all", "library", "store-details", "store-reviews", "owned-games", "app-names"])
          .default("all"),
        dry_run: z
          .boolean()
          .default(false)
          .describe("Report how much would be removed without deleting anything."),
      },
    },
    handler(async ({ scope, dry_run }: { scope: string; dry_run: boolean }) => {
      const target = scope === "all" ? undefined : scope;
      if (dry_run) {
        return ok({
          dry_run: true,
          scope,
          files_that_would_be_removed: cache().count(target),
          cache_dir: cache().dir,
          note: "Backups are never removed by this tool.",
        });
      }
      const removed = cache().clear(target);
      return ok({ scope, files_removed: removed, cache_dir: cache().dir });
    }),
  );

  registerStrictTool(
    server,
    "steam_cache_status",
    {
      title: "Cache status",
      description: "Report how fresh this server's cached library snapshot is.",
      inputSchema: {},
    },
    handler(async () => {
      const age = cache().age("library");
      return ok({
        cache_dir: cache().dir,
        library_age_seconds: age === null ? null : Math.round(age / 1000),
      });
    }),
  );
}
