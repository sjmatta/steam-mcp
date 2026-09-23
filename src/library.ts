import type { Game } from "./model.js";

/**
 * Filtering, sorting, searching and projection.
 *
 * The projection defaults matter as much as the filters: a 2300-game library
 * returned in full would swamp the caller's context, so every list path is
 * paginated and returns only a compact field set unless asked otherwise.
 */

export const DEFAULT_FIELDS = [
  "appid",
  "name",
  "installed",
  "playtimeMinutes",
  "lastPlayed",
] as const;

export const ALL_FIELDS = [
  "appid",
  "name",
  "sortAs",
  "kind",
  "installed",
  "hidden",
  "favorite",
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
  "tags",
] as const;

export const SORT_KEYS = [
  "name",
  "playtime",
  "lastPlayed",
  "purchased",
  "size",
  "review",
  "metacritic",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const KIND_NAMES: Record<number, string> = {
  0: "shortcut",
  1: "game",
  2: "software",
  3: "music",
  4: "video",
  5: "tool",
};

export interface Filters {
  installed?: boolean;
  hidden?: boolean;
  favorite?: boolean;
  played?: boolean;
  kind?: string;
  tag?: string;
  minPlaytimeMinutes?: number;
  maxPlaytimeMinutes?: number;
  playedSinceEpoch?: number;
  playedBeforeEpoch?: number;
  minSizeBytes?: number;
  maxSizeBytes?: number;
  minReviewPercentage?: number;
  appids?: number[];
}

/** Parses "30d", "6m", "2y" or an ISO date into epoch seconds. */
export function parseSince(value: string): number | null {
  const rel = /^(\d+)\s*([dwmy])$/i.exec(value.trim());
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const days = unit === "d" ? 1 : unit === "w" ? 7 : unit === "m" ? 30 : 365;
    return Math.floor(Date.now() / 1000) - amount * days * 86400;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function applyFilters(games: Game[], f: Filters, memberIds?: Set<number>): Game[] {
  return games.filter((g) => {
    if (memberIds && !memberIds.has(g.appid)) return false;
    if (f.appids && !f.appids.includes(g.appid)) return false;
    if (f.installed !== undefined && g.installed !== f.installed) return false;
    // Hidden games are excluded unless explicitly asked for.
    if (f.hidden === undefined ? g.hidden : g.hidden !== f.hidden) return false;
    if (f.favorite !== undefined && g.favorite !== f.favorite) return false;
    if (f.played !== undefined && g.playtimeMinutes > 0 !== f.played) return false;
    if (f.kind !== undefined && KIND_NAMES[g.kind] !== f.kind) return false;
    if (f.tag !== undefined) {
      const needle = f.tag.toLowerCase();
      if (!g.tags.some((t) => t.toLowerCase() === needle)) return false;
    }
    if (f.minPlaytimeMinutes !== undefined && g.playtimeMinutes < f.minPlaytimeMinutes)
      return false;
    if (f.maxPlaytimeMinutes !== undefined && g.playtimeMinutes > f.maxPlaytimeMinutes)
      return false;
    if (f.playedSinceEpoch !== undefined && g.lastPlayed < f.playedSinceEpoch) return false;
    if (f.playedBeforeEpoch !== undefined) {
      // "Not played since X" should include never-played games.
      if (g.lastPlayed !== 0 && g.lastPlayed >= f.playedBeforeEpoch) return false;
    }
    if (f.minSizeBytes !== undefined && g.sizeOnDisk < f.minSizeBytes) return false;
    if (f.maxSizeBytes !== undefined && g.sizeOnDisk > f.maxSizeBytes) return false;
    if (f.minReviewPercentage !== undefined && g.reviewPercentage < f.minReviewPercentage) {
      return false;
    }
    return true;
  });
}

export function sortGames(games: Game[], key: SortKey, order: "asc" | "desc"): Game[] {
  const dir = order === "asc" ? 1 : -1;
  const value = (g: Game): number | string => {
    switch (key) {
      case "name":
        return (g.sortAs || g.name).toLowerCase();
      case "playtime":
        return g.playtimeMinutes;
      case "lastPlayed":
        return g.lastPlayed;
      case "purchased":
        return g.purchasedTime;
      case "size":
        return g.sizeOnDisk;
      case "review":
        return g.reviewPercentage;
      case "metacritic":
        return g.metacriticScore;
    }
  };

  return [...games].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * dir;
    }
    if (av === bv) return (a.sortAs || a.name).localeCompare(b.sortAs || b.name);
    return (av - bv) * dir;
  });
}

/** Strips punctuation and diacritics so "FTL: Faster Than Light" matches "ftl". */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (needle[i] === haystack[j]) i++;
  }
  return i === needle.length;
}

export interface SearchHit {
  game: Game;
  score: number;
}

/**
 * Ranked name search. Exact beats prefix beats all-tokens beats subsequence;
 * ties break toward the game the user has actually played.
 */
export function searchGames(games: Game[], query: string, limit: number): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const tokens = q.split(" ").filter(Boolean);

  const hits: SearchHit[] = [];
  for (const game of games) {
    const name = normalize(game.name);
    const sortAs = normalize(game.sortAs);
    let score = 0;

    if (name === q || sortAs === q) score = 1000;
    else if (name.startsWith(q) || sortAs.startsWith(q)) score = 800;
    else if (name.includes(q)) score = 600;
    else if (tokens.length > 1 && tokens.every((t) => name.includes(t))) score = 450;
    else if (String(game.appid) === query.trim()) score = 1000;
    else if (isSubsequence(q.replace(/ /g, ""), name.replace(/ /g, ""))) score = 200;

    if (score === 0) continue;

    // Nudge shorter names up: "Portal" should outrank "Portal 2 Soundtrack".
    score += Math.max(0, 40 - name.length) / 10;
    if (game.playtimeMinutes > 0) score += 5;
    if (game.installed) score += 3;

    hits.push({ game, score });
  }

  hits.sort((a, b) => b.score - a.score || a.game.name.localeCompare(b.game.name));
  return hits.slice(0, limit);
}

/** Reduces a game to the requested fields, with human-friendly extras. */
export function project(game: Game, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    switch (field) {
      case "kind":
        out["kind"] = KIND_NAMES[game.kind] ?? "unknown";
        break;
      case "lastPlayed":
        out["lastPlayed"] =
          game.lastPlayed > 0 ? new Date(game.lastPlayed * 1000).toISOString().slice(0, 10) : null;
        break;
      case "purchasedTime":
        out["purchasedTime"] =
          game.purchasedTime > 0
            ? new Date(game.purchasedTime * 1000).toISOString().slice(0, 10)
            : null;
        break;
      case "sizeOnDisk":
        out["sizeGB"] = game.sizeOnDisk > 0 ? Number((game.sizeOnDisk / 1e9).toFixed(2)) : 0;
        break;
      default:
        out[field] = (game as unknown as Record<string, unknown>)[field];
    }
  }
  return out;
}

export function paginate<T>(items: T[], limit: number, offset: number): T[] {
  return items.slice(offset, offset + limit);
}
