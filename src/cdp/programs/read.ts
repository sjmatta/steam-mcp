import type {
  AppDetail,
  CollectionDetail,
  CollectionSummary,
  LibrarySnapshot,
  StoreProbe,
} from "./types.js";

/*
 * IN-PAGE PROGRAMS — read side.
 *
 * Each export is serialized with Function.prototype.toString() and evaluated
 * inside Steam's SharedJSContext. Therefore every function here must:
 *   - reference nothing from module scope (no imports at runtime, no closures);
 *   - use only syntax that survives the ES2023 emit untouched;
 *   - return plain JSON.
 * The type-only imports above are erased at compile time and are safe.
 */

/** Cheap liveness check: are Steam's stores booted yet? */
export const probeStores = (): StoreProbe => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  return {
    collectionStore: !!cs,
    appStore: !!as,
    steamClient: !!w.SteamClient,
    appCount: (cs?.allAppsCollection?.allApps ? cs.allAppsCollection.allApps.length : 0) as number,
    collectionCount: (cs?.userCollections ? cs.userCollections.length : 0) as number,
  };
};

/**
 * Whole-library snapshot in one evaluation.
 *
 * Sourced from appTypeCollectionMap rather than appStore.allApps: it yields the
 * owned set and the app kind in one pass, excludes shortcuts naturally, and
 * needs no app_type enum table.
 */
export const snapshotLibrary = (arg: { includeTags: boolean }): LibrarySnapshot => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  if (!cs || !as) throw new Error("STORES_NOT_READY");

  const call = (obj: any, method: string, fallback: any): any => {
    try {
      return typeof obj[method] === "function" ? obj[method]() : fallback;
    } catch (e) {
      return fallback;
    }
  };

  // `overview.installed` is unreliable (true for most of a library, meaning
  // "installable"). The local-install collection is the real answer.
  const installedSet = new Set<number>();
  const localInstall = cs.GetCollection ? cs.GetCollection("local-install") : null;
  if (localInstall?.allApps) {
    for (const app of localInstall.allApps) installedSet.add(app.appid);
  }

  const kinds: Array<[string, number]> = [
    ["type-games", 1],
    ["type-software", 2],
    ["type-music", 3],
    ["type-videos", 4],
    ["type-tools", 5],
  ];

  const cols = [
    "appid",
    "name",
    "sortAs",
    "kind",
    "hidden",
    "visible",
    "shortcut",
    "owned",
    "borrowed",
    "sizeOnDisk",
    "lastPlayed",
    "playtimeMinutes",
    "purchasedTime",
    "reviewPercentage",
    "metacriticScore",
    "deckCompat",
  ];

  const rows: Array<Array<number | string>> = [];
  const appTags: Record<string, number[]> = {};
  const tagIds = new Set<number>();
  const seen = new Set<number>();

  for (const pair of kinds) {
    const collection = cs.appTypeCollectionMap ? cs.appTypeCollectionMap.get(pair[0]) : null;
    if (!collection?.allApps) continue;

    for (const app of collection.allApps) {
      const appid = app.appid;
      if (seen.has(appid)) continue;
      seen.add(appid);

      const isShortcut = call(app, "BIsShortcut", false) ? 1 : 0;
      const rawTags = call(app, "GetStoreTags", null) || app.store_tag || [];
      const tags: number[] = [];
      for (const tag of Array.from(rawTags as any[])) {
        if (typeof tag === "number") {
          tags.push(tag);
          tagIds.add(tag);
        }
      }
      if (arg.includeTags && tags.length > 0) appTags[String(appid)] = tags.slice(0, 25);

      rows.push([
        appid,
        app.display_name || String(appid),
        app.sort_as || app.display_name || String(appid),
        isShortcut ? 0 : pair[1],
        cs.BIsHidden?.(appid) ? 1 : 0,
        call(app, "BIsVisible", true) ? 1 : 0,
        isShortcut,
        call(app, "BIsOwned", true) ? 1 : 0,
        call(app, "BIsBorrowed", false) ? 1 : 0,
        app.size_on_disk || 0,
        app.rt_last_time_played || 0,
        app.minutes_playtime_forever || 0,
        app.rt_purchased_time || 0,
        app.review_percentage || 0,
        app.metacritic_score || 0,
        app.steam_deck_compat_category || 0,
      ]);
    }
  }

  // Resolve tag ids once into a shared dictionary rather than repeating strings
  // on every row.
  const tagNames: Record<string, string> = {};
  for (const id of Array.from(tagIds)) {
    let name: string | undefined;
    try {
      if (typeof as.GetLocalizationForStoreTag === "function") {
        name = as.GetLocalizationForStoreTag(id);
      } else if (as.m_mapStoreTagLocalization) {
        name = as.m_mapStoreTagLocalization[id];
      }
    } catch (e) {
      name = undefined;
    }
    if (typeof name === "string" && name.length > 0) tagNames[String(id)] = name;
  }

  return {
    cols,
    rows,
    installed: Array.from(installedSet),
    tagNames,
    appTags,
    total: rows.length,
  };
};

/** All collections, with the flags that decide whether we may write to them. */
export const listCollections = (): CollectionSummary[] => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  if (!cs) throw new Error("STORES_NOT_READY");

  const systemIds = new Set([
    "favorite",
    "hidden",
    "uncategorized",
    "local-install",
    "my-games",
    "play-next",
  ]);

  const summarize = (c: any): CollectionSummary | null => {
    if (!c || typeof c.id !== "string") return null;
    let editable = false;
    try {
      editable = !!c.AsDragDropCollection?.();
    } catch {
      // Steam throws rather than returning null on some collection shapes.
    }
    return {
      id: c.id,
      name: c.displayName || c.id,
      // Two independent signals: they can disagree for system collections.
      isDynamic: !!c.bIsDynamic || !!c.m_filterSpec || !!c.internalAppFilter,
      isEditable: editable,
      isSystem: systemIds.has(c.id) || c.id.indexOf("type-") === 0,
      appCount: c.allApps ? c.allApps.length : 0,
    };
  };

  const out: CollectionSummary[] = [];
  const seen = new Set<string>();
  const push = (c: any): void => {
    const s = summarize(c);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  };

  for (const c of cs.userCollections || []) push(c);
  for (const id of Array.from(systemIds)) {
    try {
      push(cs.GetCollection(id));
    } catch (e) {
      // Not every system collection exists on every client.
    }
  }
  if (cs.appTypeCollectionMap?.forEach) {
    cs.appTypeCollectionMap.forEach((c: any) => {
      push(c);
    });
  }

  return out;
};

/**
 * Just the appids of one collection. Lives here, with the other page programs,
 * so the `auditPageFunction` sweep covers it - a program defined elsewhere is
 * one the closure-capture guard never sees.
 */
export const collectionMembers = (arg: { ref: string }): number[] => {
  const cs = (globalThis as any).collectionStore;
  if (!cs) throw new Error("STORES_NOT_READY");
  const col = cs.GetCollection(arg.ref);
  if (!col) throw new Error("COLLECTION_NOT_FOUND");
  const out: number[] = [];
  for (const app of col.allApps || []) out.push(app.appid);
  return out;
};

/** One collection plus its membership. `ref` is an id or an exact name. */
export const getCollection = (arg: { ref: string }): CollectionDetail => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  if (!cs) throw new Error("STORES_NOT_READY");

  let c: any = null;
  try {
    c = cs.GetCollection(arg.ref);
  } catch {
    // An unknown id throws here; fall through to the by-name lookup.
  }
  if (!c) {
    const byName = cs.GetUserCollectionsByName ? cs.GetUserCollectionsByName(arg.ref) : [];
    if (byName?.length === 1) c = byName[0];
    else if (byName?.length > 1) throw new Error("NAME_COLLISION");
  }
  if (!c) throw new Error("COLLECTION_NOT_FOUND");

  let editable = false;
  try {
    editable = !!c.AsDragDropCollection?.();
  } catch {
    // Steam throws rather than returning null on some collection shapes.
  }

  const appids: number[] = [];
  for (const app of c.allApps || []) appids.push(app.appid);

  const systemIds = [
    "favorite",
    "hidden",
    "uncategorized",
    "local-install",
    "my-games",
    "play-next",
  ];

  return {
    id: c.id,
    name: c.displayName || c.id,
    isDynamic: !!c.bIsDynamic || !!c.m_filterSpec || !!c.internalAppFilter,
    isEditable: editable,
    isSystem: systemIds.includes(c.id) || c.id.indexOf("type-") === 0,
    appCount: appids.length,
    appids,
  };
};

/** Rich detail for a single app, including which collections contain it. */
export const getAppDetail = (arg: { appid: number }): AppDetail => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  if (!cs || !as) throw new Error("STORES_NOT_READY");

  const app = as.GetAppOverviewByAppID(arg.appid);
  if (!app) throw new Error("APP_NOT_FOUND");

  const call = (obj: any, method: string, fallback: any): any => {
    try {
      return typeof obj[method] === "function" ? obj[method]() : fallback;
    } catch (e) {
      return fallback;
    }
  };

  const installedSet = new Set<number>();
  const localInstall = cs.GetCollection ? cs.GetCollection("local-install") : null;
  if (localInstall?.allApps) {
    for (const a of localInstall.allApps) installedSet.add(a.appid);
  }

  const tags: string[] = [];
  const rawTags = call(app, "GetStoreTags", null) || app.store_tag || [];
  for (const tag of Array.from(rawTags as any[]).slice(0, 25)) {
    try {
      const name =
        typeof as.GetLocalizationForStoreTag === "function"
          ? as.GetLocalizationForStoreTag(tag)
          : as.m_mapStoreTagLocalization
            ? as.m_mapStoreTagLocalization[tag]
            : null;
      if (typeof name === "string" && name.length > 0) tags.push(name);
    } catch (e) {
      // unresolved tag id
    }
  }

  const collections: Array<{ id: string; name: string }> = [];
  try {
    for (const c of cs.GetCollectionListForAppID(arg.appid) || []) {
      collections.push({ id: c.id, name: c.displayName || c.id });
    }
  } catch (e) {
    // older clients may not expose this
  }

  let favorite = false;
  try {
    const fav = cs.GetCollection("favorite");
    if (fav?.allApps) {
      for (const a of fav.allApps) {
        if (a.appid === arg.appid) {
          favorite = true;
          break;
        }
      }
    }
  } catch (e) {
    favorite = false;
  }

  return {
    appid: arg.appid,
    name: app.display_name || String(arg.appid),
    sortAs: app.sort_as || app.display_name || String(arg.appid),
    appType: app.app_type || 0,
    installed: installedSet.has(arg.appid),
    hidden: !!cs.BIsHidden?.(arg.appid),
    favorite,
    sizeOnDisk: app.size_on_disk || 0,
    playtimeMinutes: app.minutes_playtime_forever || 0,
    lastPlayed: app.rt_last_time_played || 0,
    purchasedTime: app.rt_purchased_time || 0,
    reviewPercentage: app.review_percentage || 0,
    metacriticScore: app.metacritic_score || 0,
    deckCompat: app.steam_deck_compat_category || 0,
    isShortcut: !!call(app, "BIsShortcut", false),
    isOwned: !!call(app, "BIsOwned", true),
    isBorrowed: !!call(app, "BIsBorrowed", false),
    tags,
    collections,
  };
};
