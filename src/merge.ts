import type { LibrarySnapshot } from "./cdp/programs/types.js";
import type { InstalledApp } from "./local/appmanifests.js";
import type { LocalPlaytime } from "./local/localconfig.js";
import type { OwnedGame } from "./web/webapi.js";

/**
 * Pure reconciliation of the three data sources. No I/O lives here, so the
 * precedence rules can be tested exhaustively without Steam, the network, or
 * the filesystem.
 */

export interface Game {
  appid: number;
  name: string;
  sortAs: string;
  /** 1 game, 2 software, 3 music, 4 video, 5 tool, 0 shortcut/unknown. */
  kind: number;
  installed: boolean;
  hidden: boolean;
  favorite: boolean;
  shortcut: boolean;
  owned: boolean;
  borrowed: boolean;
  sizeOnDisk: number;
  lastPlayed: number;
  playtimeMinutes: number;
  purchasedTime: number;
  reviewPercentage: number;
  metacriticScore: number;
  deckCompat: number;
  tags: string[];
}

/** Name given to an app we know the id of but not the title. */
export function placeholderName(appid: number): string {
  return `App ${appid}`;
}

export const PLACEHOLDER_NAME_RE = /^App \d+$/;

/**
 * Converts the columnar in-page snapshot into Games.
 *
 * The snapshot is columnar because 2000+ apps as objects repeats every key name
 * and triples the payload; column indexes are resolved by name so a future
 * Steam build that adds a column cannot silently shift the data.
 */
export function snapshotToGames(snap: LibrarySnapshot): Game[] {
  const idx = (name: string): number => snap.cols.indexOf(name);
  const c = {
    appid: idx("appid"),
    name: idx("name"),
    sortAs: idx("sortAs"),
    kind: idx("kind"),
    hidden: idx("hidden"),
    shortcut: idx("shortcut"),
    owned: idx("owned"),
    borrowed: idx("borrowed"),
    size: idx("sizeOnDisk"),
    last: idx("lastPlayed"),
    play: idx("playtimeMinutes"),
    purchased: idx("purchasedTime"),
    review: idx("reviewPercentage"),
    meta: idx("metacriticScore"),
    deck: idx("deckCompat"),
  };

  const num = (row: Array<number | string>, i: number, fallback = 0): number => {
    if (i < 0) return fallback;
    const v = Number(row[i]);
    return Number.isFinite(v) ? v : fallback;
  };

  // `installed` comes from the local-install collection, never from
  // overview.installed, which is true for most of a library and really means
  // "installable".
  const installed = new Set(snap.installed);

  return snap.rows.map((row) => {
    const appid = num(row, c.appid);
    const name =
      c.name >= 0 && row[c.name] !== undefined ? String(row[c.name]) : placeholderName(appid);
    const tagIds = snap.appTags[String(appid)] ?? [];
    return {
      appid,
      name,
      sortAs: c.sortAs >= 0 && row[c.sortAs] !== undefined ? String(row[c.sortAs]) : name,
      kind: num(row, c.kind),
      installed: installed.has(appid),
      hidden: num(row, c.hidden) === 1,
      favorite: false, // system collection membership is applied separately
      shortcut: num(row, c.shortcut) === 1,
      owned: num(row, c.owned, 1) === 1,
      borrowed: num(row, c.borrowed) === 1,
      sizeOnDisk: num(row, c.size),
      lastPlayed: num(row, c.last),
      playtimeMinutes: num(row, c.play),
      purchasedTime: num(row, c.purchased),
      reviewPercentage: num(row, c.review),
      metacriticScore: num(row, c.meta),
      deckCompat: num(row, c.deck),
      tags: tagIds
        .map((id) => snap.tagNames[String(id)])
        .filter((n): n is string => typeof n === "string" && n.length > 0),
    };
  });
}

export interface OfflineSources {
  /** Steam Web API result; the only source that knows the full owned set. */
  ownedGames?: OwnedGame[];
  /** appmanifest_*.acf — authoritative for install state and size on disk. */
  installedApps: InstalledApp[];
  /** localconfig.vdf — playtime for anything ever launched on this machine. */
  playtime: Map<number, LocalPlaytime>;
  hiddenIds: Iterable<number>;
  favoriteIds: Iterable<number>;
}

/**
 * Builds the library from everything available without a running client.
 *
 * Precedence: the Web API owns the game set and playtime; local files own
 * install state and size; the flushed collection files own hidden/favorite.
 * Local playtime only fills gaps, because it is per-machine while the Web API
 * total spans every device.
 */
export function mergeOfflineSources(sources: OfflineSources): Game[] {
  const hidden = new Set(sources.hiddenIds);
  const favorite = new Set(sources.favoriteIds);
  const installedById = new Map(sources.installedApps.map((a) => [a.appid, a]));

  const blank = (appid: number, name: string, sortAs?: string): Game => ({
    appid,
    name,
    sortAs: sortAs ?? name,
    kind: 1,
    installed: installedById.has(appid),
    hidden: hidden.has(appid),
    favorite: favorite.has(appid),
    shortcut: false,
    owned: true,
    borrowed: false,
    sizeOnDisk: installedById.get(appid)?.sizeOnDisk ?? 0,
    lastPlayed: 0,
    playtimeMinutes: 0,
    purchasedTime: 0,
    reviewPercentage: 0,
    metacriticScore: 0,
    deckCompat: 0,
    tags: [],
  });

  const byAppid = new Map<number, Game>();

  for (const g of sources.ownedGames ?? []) {
    const game = blank(g.appid, g.name, g.sortAs);
    game.playtimeMinutes = g.playtimeForever;
    game.lastPlayed = g.lastPlayed;
    game.reviewPercentage = g.reviewPercentage;
    byAppid.set(g.appid, game);
  }

  for (const app of sources.installedApps) {
    const existing = byAppid.get(app.appid);
    if (existing) {
      existing.installed = true;
      existing.sizeOnDisk = app.sizeOnDisk;
    } else {
      byAppid.set(app.appid, blank(app.appid, app.name));
    }
  }

  for (const [appid, pt] of sources.playtime) {
    const existing = byAppid.get(appid);
    if (existing) {
      if (existing.playtimeMinutes === 0) existing.playtimeMinutes = pt.playtimeMinutes;
      if (existing.lastPlayed === 0) existing.lastPlayed = pt.lastPlayed;
    } else if (pt.playtimeMinutes > 0 || pt.lastPlayed > 0) {
      const game = blank(appid, placeholderName(appid));
      game.playtimeMinutes = pt.playtimeMinutes;
      game.lastPlayed = pt.lastPlayed;
      byAppid.set(appid, game);
    }
  }

  return [...byAppid.values()];
}

/** Applies system-collection membership to an already-built library. */
export function applyFlags(
  games: Game[],
  favoriteIds: Iterable<number>,
  hiddenIds: Iterable<number>,
): Game[] {
  const favorite = new Set(favoriteIds);
  const hidden = new Set(hiddenIds);
  for (const game of games) {
    game.favorite = favorite.has(game.appid);
    // Hidden is additive: the snapshot's own flag is also authoritative.
    if (hidden.has(game.appid)) game.hidden = true;
  }
  return games;
}
