import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cdp } from "../cdp/client.js";
import { getAppDetail } from "../cdp/programs/read.js";
import { SteamError } from "../errors.js";
import {
  ALL_FIELDS,
  DEFAULT_FIELDS,
  KIND_NAMES,
  SORT_KEYS,
  applyFilters,
  paginate,
  parseSince,
  project,
  searchGames,
  sortGames,
  type Filters,
  type SortKey,
} from "../library.js";
import {
  account,
  fetchCollectionMembers,
  loadCollections,
  loadLibrary,
  type Game,
} from "../model.js";
import { readLibraryCacheEntry } from "../local/librarycache.js";
import { getReviewSummary, getStoreDetails } from "../web/store.js";
import { getRecentlyPlayed, getWishlist, hasApiKey } from "../web/webapi.js";
import { resolveAppNames } from "../web/storebrowse.js";
import { handler, ok, paginationShape, registerStrictTool } from "./shared.js";

const GB = 1e9;

/** Games the offline path could not name arrive as "App 12345". */
const PLACEHOLDER_NAME = /^App \d+$/;

/** Resolves placeholder names in place, for a bounded set of games. */
async function fillPlaceholderNames(games: Game[]): Promise<void> {
  const unnamed = games.filter((g) => PLACEHOLDER_NAME.test(g.name));
  if (unnamed.length === 0) return;
  const names = await resolveAppNames(unnamed.map((g) => g.appid));
  for (const game of unnamed) {
    const name = names.get(game.appid);
    if (name) {
      game.name = name;
      game.sortAs = name;
    }
  }
}

/** Resolves a collection reference to the set of appids it contains. */
async function collectionMembers(ref: string): Promise<Set<number>> {
  const { collections, members } = await loadCollections();
  const needle = ref.toLowerCase();
  const match =
    collections.find((c) => c.id === ref) ??
    collections.find((c) => c.name.toLowerCase() === needle);
  if (!match) {
    throw new SteamError("COLLECTION_NOT_FOUND", `No collection matched "${ref}".`, {
      hint: "Call steam_collections_list to see valid ids and names.",
    });
  }

  if (members[match.id]) return new Set(members[match.id]);

  // Membership was not preloaded; fetch it from the live client.
  return new Set(await fetchCollectionMembers(match.id));
}

export function registerLibraryTools(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_library_list",
    {
      title: "List Steam games",
      description:
        "List, filter and sort games in the Steam library. Returns a compact projection and is paginated - it never dumps the whole library. " +
        "Hidden games are excluded unless hidden=true. Always check the returned 'total' before assuming you have seen everything.",
      inputSchema: {
        ...paginationShape,
        installed: z.boolean().optional().describe("Only games installed on this machine."),
        hidden: z
          .boolean()
          .optional()
          .describe(
            "Include only hidden (true) or only visible (false) games. Omitted means visible only.",
          ),
        favorite: z.boolean().optional(),
        played: z
          .boolean()
          .optional()
          .describe("true = playtime above zero; false = never played."),
        kind: z
          .enum(["game", "software", "music", "video", "tool", "shortcut"])
          .optional()
          .describe("App type."),
        collection: z.string().optional().describe("Collection id or exact name to filter by."),
        tag: z.string().optional().describe('Store tag name, e.g. "Roguelike".'),
        min_playtime_minutes: z.number().int().min(0).optional(),
        max_playtime_minutes: z.number().int().min(0).optional(),
        played_since: z
          .string()
          .optional()
          .describe(
            'Only games played since then. ISO date or relative such as "30d", "6m", "2y".',
          ),
        not_played_since: z
          .string()
          .optional()
          .describe("Only games not played since then. Includes never-played games."),
        min_size_gb: z.number().min(0).optional(),
        max_size_gb: z.number().min(0).optional(),
        min_review_percentage: z.number().int().min(0).max(100).optional(),
        sort: z.enum(SORT_KEYS).default("name"),
        order: z.enum(["asc", "desc"]).default("asc"),
        fields: z
          .array(z.enum(ALL_FIELDS))
          .optional()
          .describe(`Fields to return. Default: ${DEFAULT_FIELDS.join(", ")}.`),
        refresh: z.boolean().default(false).describe("Bypass the cached library snapshot."),
      },
    },
    handler(async (args: Record<string, unknown>) => {
      const view = await loadLibrary({ force: args["refresh"] === true });

      const filters: Filters = {};
      if (args["installed"] !== undefined) filters.installed = args["installed"] as boolean;
      if (args["hidden"] !== undefined) filters.hidden = args["hidden"] as boolean;
      if (args["favorite"] !== undefined) filters.favorite = args["favorite"] as boolean;
      if (args["played"] !== undefined) filters.played = args["played"] as boolean;
      if (args["kind"] !== undefined) filters.kind = args["kind"] as string;
      if (args["tag"] !== undefined) filters.tag = args["tag"] as string;
      if (args["min_playtime_minutes"] !== undefined) {
        filters.minPlaytimeMinutes = args["min_playtime_minutes"] as number;
      }
      if (args["max_playtime_minutes"] !== undefined) {
        filters.maxPlaytimeMinutes = args["max_playtime_minutes"] as number;
      }
      if (args["min_size_gb"] !== undefined)
        filters.minSizeBytes = (args["min_size_gb"] as number) * GB;
      if (args["max_size_gb"] !== undefined)
        filters.maxSizeBytes = (args["max_size_gb"] as number) * GB;
      if (args["min_review_percentage"] !== undefined) {
        filters.minReviewPercentage = args["min_review_percentage"] as number;
      }

      for (const [key, target] of [
        ["played_since", "playedSinceEpoch"],
        ["not_played_since", "playedBeforeEpoch"],
      ] as const) {
        const raw = args[key];
        if (typeof raw === "string") {
          const epoch = parseSince(raw);
          if (epoch === null) {
            throw new SteamError("UNSUPPORTED", `Could not parse ${key}="${raw}".`, {
              hint: 'Use an ISO date such as "2025-01-01" or a relative value such as "30d".',
            });
          }
          (filters as Record<string, unknown>)[target] = epoch;
        }
      }

      const members =
        typeof args["collection"] === "string"
          ? await collectionMembers(args["collection"])
          : undefined;

      const filtered = applyFilters(view.games, filters, members);
      const sorted = sortGames(
        filtered,
        (args["sort"] as SortKey) ?? "name",
        (args["order"] as "asc" | "desc") ?? "asc",
      );

      const limit = (args["limit"] as number) ?? 50;
      const offset = (args["offset"] as number) ?? 0;
      const fields = (args["fields"] as string[] | undefined) ?? [...DEFAULT_FIELDS];
      const page = paginate(sorted, limit, offset);

      // Offline reads can only name games Steam has local records for; the rest
      // arrive as "App <id>" placeholders. Resolve just the page being returned.
      await fillPlaceholderNames(page);

      return ok({
        total: filtered.length,
        returned: Math.min(limit, Math.max(0, filtered.length - offset)),
        offset,
        source: view.source,
        degraded: view.degraded,
        games: page.map((g) => project(g, fields)),
      });
    }),
  );

  registerStrictTool(
    server,
    "steam_library_search",
    {
      title: "Search Steam games by name",
      description:
        "Find games by name. Fuzzy and punctuation-insensitive, ranked best-first. Use this to turn a game name into an appid before calling any tool that takes appids.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        installed_only: z.boolean().default(false),
        include_hidden: z.boolean().default(false),
      },
    },
    handler(
      async ({
        query,
        limit,
        installed_only,
        include_hidden,
      }: {
        query: string;
        limit: number;
        installed_only: boolean;
        include_hidden: boolean;
      }) => {
        const view = await loadLibrary();
        let pool: Game[] = view.games;
        if (installed_only) pool = pool.filter((g) => g.installed);
        if (!include_hidden) pool = pool.filter((g) => !g.hidden);

        const hits = searchGames(pool, query, limit);
        return ok({
          query,
          source: view.source,
          degraded: view.degraded,
          matches: hits.map((h) => ({
            appid: h.game.appid,
            name: h.game.name,
            installed: h.game.installed,
            playtimeMinutes: h.game.playtimeMinutes,
            kind: KIND_NAMES[h.game.kind] ?? "unknown",
          })),
        });
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_game_details",
    {
      title: "Game details",
      description:
        "Everything known about one game: install state, playtime, tags, which collections contain it, plus store metadata (description, genres, developers, release date, review score). " +
        "Store data is fetched on demand and cached for two weeks; it draws on a shared budget of roughly 200 store requests per 5 minutes, so avoid calling this in a loop over many games.",
      inputSchema: {
        appid: z.number().int().positive().optional(),
        name: z
          .string()
          .optional()
          .describe("Alternative to appid. Ambiguous names return candidates instead of guessing."),
        include_store: z.boolean().default(true).describe("Fetch store metadata (rate-limited)."),
        include_reviews: z.boolean().default(true),
        refresh: z.boolean().default(false),
      },
    },
    handler(
      async ({
        appid,
        name,
        include_store,
        include_reviews,
        refresh,
      }: {
        appid?: number;
        name?: string;
        include_store: boolean;
        include_reviews: boolean;
        refresh: boolean;
      }) => {
        const view = await loadLibrary();

        let resolved = appid;
        if (resolved === undefined) {
          if (!name) {
            throw new SteamError("UNSUPPORTED", "Provide either appid or name.");
          }
          const hits = searchGames(view.games, name, 5);
          if (hits.length === 0) {
            throw new SteamError("APP_NOT_FOUND", `No game matched "${name}".`);
          }
          const best = hits[0]!;
          const runnerUp = hits[1];
          if (runnerUp && runnerUp.score >= best.score - 1) {
            return ok({
              ambiguous: true,
              message: `"${name}" matched several games; call again with an explicit appid.`,
              candidates: hits.map((h) => ({ appid: h.game.appid, name: h.game.name })),
            });
          }
          resolved = best.game.appid;
        }

        const local = view.games.find((g) => g.appid === resolved);
        const payload: Record<string, unknown> = {
          appid: resolved,
          source: view.source,
        };

        // Prefer the live client, which knows collections and hidden state.
        try {
          const detail = await cdp.evalInPage(getAppDetail, { appid: resolved }, "getAppDetail");
          Object.assign(payload, detail, {
            sizeGB: Number((detail.sizeOnDisk / GB).toFixed(2)),
            lastPlayed:
              detail.lastPlayed > 0
                ? new Date(detail.lastPlayed * 1000).toISOString().slice(0, 10)
                : null,
            kind: KIND_NAMES[detail.appType] ?? undefined,
          });
        } catch {
          if (!local) {
            throw new SteamError("APP_NOT_FOUND", `Appid ${resolved} is not in the library.`);
          }
          Object.assign(payload, project(local, ALL_FIELDS));
          payload["degraded"] = true;
        }

        // Free, offline extras that Steam already cached locally.
        try {
          const acct = account();
          const cached = readLibraryCacheEntry(acct.accountId, resolved);
          if (cached?.associations) payload["associations"] = cached.associations;
          if (cached?.shortDescription && !payload["shortDescription"]) {
            payload["shortDescription"] = cached.shortDescription;
          }
          if (cached?.achievementsTotal !== undefined) {
            payload["achievementsTotal"] = cached.achievementsTotal;
          }
        } catch {
          // Non-fatal.
        }

        if (include_store) {
          const store = await getStoreDetails(resolved, { force: refresh });
          if (store.success) {
            payload["store"] = {
              type: store.type,
              isFree: store.isFree,
              shortDescription: store.shortDescription,
              developers: store.developers,
              publishers: store.publishers,
              genres: store.genres,
              categories: store.categories,
              releaseDate: store.releaseDate,
              comingSoon: store.comingSoon,
              metacritic: store.metacritic,
              controllerSupport: store.controllerSupport,
              platforms: store.platforms,
              price: store.priceFormatted,
              discountPercent: store.discountPercent,
            };
          } else {
            payload["store"] = {
              available: false,
              note: "Not available on the store (delisted or region-locked).",
            };
          }
        }

        if (include_reviews) {
          const reviews = await getReviewSummary(resolved, { force: refresh });
          if (reviews) {
            payload["reviews"] = {
              summary: reviews.reviewScoreDesc,
              positivePercent: reviews.positivePercent,
              total: reviews.totalReviews,
            };
          }
        }

        return ok(payload);
      },
    ),
  );

  registerStrictTool(
    server,
    "steam_tags_list",
    {
      title: "List store tags in the library",
      description:
        "List the store tags present across the library with how many games carry each. Use this to discover valid values for the 'tag' filter of steam_library_list.",
      inputSchema: {
        limit: z.number().int().min(1).max(300).default(60),
        min_count: z.number().int().min(1).default(2),
      },
    },
    handler(async ({ limit, min_count }: { limit: number; min_count: number }) => {
      const view = await loadLibrary();
      const counts = new Map<string, number>();
      for (const game of view.games) {
        for (const tag of game.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const tags = [...counts.entries()]
        .filter(([, n]) => n >= min_count)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag, count]) => ({ tag, count }));

      return ok({
        total_distinct: counts.size,
        source: view.source,
        note:
          counts.size === 0
            ? "No tags available. Tags come from the running Steam client; start Steam and call steam_restart."
            : undefined,
        tags,
      });
    }),
  );

  registerStrictTool(
    server,
    "steam_recently_played",
    {
      title: "Recently played games",
      description: "Games played recently, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    handler(async ({ limit }: { limit: number }) => {
      // The live library already carries last-played timestamps; only fall
      // back to the Web API when that is unavailable.
      const view = await loadLibrary();
      const played = view.games.filter((g) => g.lastPlayed > 0);

      if (played.length === 0 && hasApiKey()) {
        const acct = account();
        const recent = await getRecentlyPlayed(acct.steamId64, limit);
        return ok({
          source: "webapi",
          games: recent.map((g) => ({
            appid: g.appid,
            name: g.name,
            playtimeMinutes: g.playtimeForever,
            playtime2WeeksMinutes: g.playtime2Weeks,
          })),
        });
      }

      const sorted = sortGames(played, "lastPlayed", "desc").slice(0, limit);
      return ok({
        source: view.source,
        degraded: view.degraded,
        games: sorted.map((g) => ({
          appid: g.appid,
          name: g.name,
          playtimeMinutes: g.playtimeMinutes,
          lastPlayed: new Date(g.lastPlayed * 1000).toISOString().slice(0, 10),
          installed: g.installed,
        })),
      });
    }),
  );

  registerStrictTool(
    server,
    "steam_wishlist",
    {
      title: "Steam wishlist",
      description: "List wishlisted games. Requires STEAM_API_KEY to be configured.",
      inputSchema: { ...paginationShape },
    },
    handler(async ({ limit, offset }: { limit: number; offset: number }) => {
      const acct = account();
      const items = await getWishlist(acct.steamId64);
      const view = await loadLibrary().catch(() => null);
      const names = new Map(view?.games.map((g) => [g.appid, g.name]) ?? []);

      const sorted = [...items].sort((a, b) => a.priority - b.priority);
      const page = paginate(sorted, limit, offset);

      // Wishlisted games are by definition unowned, so neither the Steam client
      // nor GetOwnedGames knows their names. Resolve the page from the store.
      const unresolved = page.map((i) => i.appid).filter((id) => !names.has(id));
      if (unresolved.length > 0) {
        for (const [appid, name] of await resolveAppNames(unresolved)) names.set(appid, name);
      }

      return ok({
        total: items.length,
        offset,
        returned: page.length,
        items: page.map((i) => ({
          appid: i.appid,
          name: names.get(i.appid) ?? null,
          priority: i.priority,
          addedAt: i.addedAt > 0 ? new Date(i.addedAt * 1000).toISOString().slice(0, 10) : null,
        })),
      });
    }),
  );
}
