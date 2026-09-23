import { cache } from "./cache.js";
import { cdp } from "./cdp/client.js";
import { collectionMembers, listCollections, snapshotLibrary } from "./cdp/programs/read.js";
import type { CollectionSummary } from "./cdp/programs/types.js";
import { detectAccount, type SteamAccount } from "./config.js";
import { SteamError } from "./errors.js";
import { applyFlags, mergeOfflineSources, snapshotToGames, type Game } from "./merge.js";
import { readInstalledApps } from "./local/appmanifests.js";
import { readLocalConfig } from "./local/localconfig.js";
import { readOfflineCollections } from "./local/cloudstorage.js";
import { getOwnedGames, hasApiKey } from "./web/webapi.js";

export type { Game } from "./merge.js";

/** How long a live snapshot is reused before we re-read from the client. */
const LIVE_TTL_MS = 5 * 60 * 1000;
const STALE_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

export type LibrarySource = "live" | "webapi" | "local";

export interface LibraryView {
  games: Game[];
  source: LibrarySource;
  /** True when the data did not come from the running client. */
  degraded: boolean;
  fetchedAt: number;
  tagNames: Record<string, string>;
  /** Collection id -> member appids, when known. */
  collectionMembers: Record<string, number[]>;
}

export interface CollectionsView {
  collections: CollectionSummary[];
  members: Record<string, number[]>;
  source: "live" | "local";
  degraded: boolean;
}

export function account(): SteamAccount {
  const acct = detectAccount();
  if (!acct) {
    throw new SteamError(
      "NO_ACCOUNT",
      "Could not determine which Steam account to use; loginusers.vdf is missing or unreadable.",
      { hint: "Set STEAM_ACCOUNT_ID to the userdata directory name if auto-detection fails." },
    );
  }
  return acct;
}

export async function fetchCollectionMembers(ref: string): Promise<number[]> {
  return cdp.evalInPage(collectionMembers, { ref }, `members:${ref}`);
}

/** Reads the whole library from the running client. */
async function loadLive(includeTags: boolean): Promise<LibraryView> {
  const snap = await cdp.evalInPage(snapshotLibrary, { includeTags }, "snapshotLibrary");
  const { members } = await loadCollections();

  const games = applyFlags(
    snapshotToGames(snap),
    members["favorite"] ?? [],
    members["hidden"] ?? [],
  );

  return {
    games,
    source: "live",
    degraded: false,
    fetchedAt: Date.now(),
    tagNames: snap.tagNames,
    collectionMembers: members,
  };
}

/** Builds the library from local files plus the Web API, with Steam closed. */
async function loadOffline(): Promise<LibraryView> {
  const acct = account();
  const installedApps = readInstalledApps();
  const localCfg = readLocalConfig(acct.accountId);
  const offlineCollections = readOfflineCollections(acct.accountId);

  const findMembers = (id: string): number[] =>
    offlineCollections.collections.find((c) => c.id === id)?.added ?? [];

  let source: LibrarySource = "local";
  let ownedGames;
  if (hasApiKey()) {
    try {
      ownedGames = await getOwnedGames(acct.steamId64);
      source = "webapi";
    } catch {
      // Fall through to local-only; steam_status reports why.
    }
  }

  const games = mergeOfflineSources({
    ...(ownedGames ? { ownedGames } : {}),
    installedApps,
    playtime: localCfg.playtime,
    hiddenIds: findMembers("hidden"),
    favoriteIds: findMembers("favorite"),
  });

  const members: Record<string, number[]> = {};
  for (const c of offlineCollections.collections) members[c.id] = c.added;

  return {
    games,
    source,
    degraded: true,
    fetchedAt: Date.now(),
    tagNames: Object.fromEntries([...localCfg.tagNames].map(([id, n]) => [String(id), n])),
    collectionMembers: members,
  };
}

/**
 * Loads the library, preferring the running client and falling back to offline
 * sources. The live path is cached briefly so a burst of tool calls does not
 * re-snapshot the whole library each time.
 */
export async function loadLibrary(
  opts: { force?: boolean; includeTags?: boolean } = {},
): Promise<LibraryView> {
  const includeTags = opts.includeTags ?? true;

  if (!opts.force) {
    const cached = cache().get<LibraryView>("library", LIVE_TTL_MS);
    if (cached?.source === "live" && (!includeTags || hasTags(cached))) return cached;
  }

  try {
    const live = await loadLive(includeTags);
    cache().set("library", live);
    return live;
  } catch {
    // Steam closed, port blocked, or stores not booted: fall back rather than
    // fail. A stale live snapshot still beats nothing.
    const stale = cache().get<LibraryView>("library", STALE_FALLBACK_TTL_MS);
    if (stale) return { ...stale, degraded: true };
  }

  const offline = await loadOffline();
  cache().set("library", offline);
  return offline;
}

function hasTags(view: LibraryView): boolean {
  return view.games.some((g) => g.tags.length > 0);
}

/**
 * Collections, live if possible. The offline fallback is read-only and lags
 * whatever the running client holds in memory.
 */
export async function loadCollections(): Promise<CollectionsView> {
  try {
    const summaries = await cdp.evalInPage(listCollections, undefined, "listCollections");
    const members: Record<string, number[]> = {};
    // Favorite and hidden membership is needed to flag every game.
    for (const id of ["favorite", "hidden"]) {
      if (!summaries.some((c) => c.id === id)) continue;
      try {
        members[id] = await fetchCollectionMembers(id);
      } catch {
        members[id] = [];
      }
    }
    return { collections: summaries, members, source: "live", degraded: false };
  } catch {
    const acct = account();
    const offline = readOfflineCollections(acct.accountId);
    const members: Record<string, number[]> = {};
    const collections: CollectionSummary[] = offline.collections.map((c) => {
      members[c.id] = c.added;
      return {
        id: c.id,
        name: c.name,
        isDynamic: c.isDynamic,
        // Editability cannot be determined from the file; assume static user
        // collections are editable and system ones are not.
        isEditable: !c.isDynamic && !c.isSystem,
        isSystem: c.isSystem,
        appCount: c.added.length,
      };
    });
    return { collections, members, source: "local", degraded: true };
  }
}
