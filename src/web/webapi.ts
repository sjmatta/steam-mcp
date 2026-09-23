import { steamApiKey } from "../config.js";
import { SteamError } from "../errors.js";
import { cache } from "../cache.js";

const BASE = "https://api.steampowered.com";
const OWNED_TTL_MS = 6 * 60 * 60 * 1000;

export interface OwnedGame {
  appid: number;
  name: string;
  playtimeForever: number;
  playtime2Weeks: number;
  lastPlayed: number;
  reviewPercentage: number;
  sortAs: string;
}

function requireKey(): string {
  const key = steamApiKey();
  if (!key) {
    throw new SteamError("NO_API_KEY", "No Steam Web API key configured.", {
      hint: "Set STEAM_API_KEY in the server environment. Get one at https://steamcommunity.com/dev/apikey (any domain works for local use).",
    });
  }
  return key;
}

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "steam-mcp/0.1 (local)" },
    });
  } catch {
    // The request URL contains STEAM_API_KEY; fetch errors may include that URL.
    throw new SteamError("NETWORK_ERROR", "Steam Web API request failed.");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new SteamError("RATE_LIMITED", "Steam Web API rate limit hit.", {
      hint: "Wait a minute and retry.",
    });
  }
  if (!res.ok) {
    throw new SteamError(
      "NETWORK_ERROR",
      `Steam Web API returned HTTP ${res.status}.`,
      res.status === 401 || res.status === 403
        ? { hint: "Check that STEAM_API_KEY is valid." }
        : {},
    );
  }
  return (await res.json()) as T;
}

export function hasApiKey(): boolean {
  return steamApiKey() !== null;
}

/**
 * The full owned library, including games that are not installed locally.
 * Using your own key against your own steamid works even when the profile's
 * game details are private.
 */
export async function getOwnedGames(
  steamId64: string,
  opts: { force?: boolean } = {},
): Promise<OwnedGame[]> {
  const key = requireKey();
  if (!opts.force) {
    const cached = cache().get<OwnedGame[]>("owned-games", OWNED_TTL_MS, steamId64);
    if (cached) return cached;
  }

  const url =
    `${BASE}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}` +
    `&steamid=${encodeURIComponent(steamId64)}` +
    `&include_appinfo=1&include_played_free_games=1&include_extended_appinfo=1&language=english`;

  const body = await getJson<{
    response?: {
      game_count?: number;
      games?: Array<{
        appid: number;
        name?: string;
        playtime_forever?: number;
        playtime_2weeks?: number;
        rtime_last_played?: number;
        review_percentage?: number;
        sort_as?: string;
      }>;
    };
  }>(url);

  const games = (body.response?.games ?? []).map((g) => ({
    appid: g.appid,
    name: g.name ?? String(g.appid),
    playtimeForever: g.playtime_forever ?? 0,
    playtime2Weeks: g.playtime_2weeks ?? 0,
    lastPlayed: g.rtime_last_played ?? 0,
    reviewPercentage: g.review_percentage ?? 0,
    sortAs: g.sort_as ?? g.name ?? String(g.appid),
  }));

  cache().set("owned-games", games, steamId64);
  return games;
}

export interface PlayerSummary {
  steamId64: string;
  personaName: string;
  profileUrl: string;
  avatar: string;
  personaState: number;
  createdAt: number;
  currentGame: string | null;
}

export async function getPlayerSummary(steamId64: string): Promise<PlayerSummary | null> {
  const key = requireKey();
  const url = `${BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${encodeURIComponent(steamId64)}`;
  const body = await getJson<{
    response?: {
      players?: Array<{
        steamid: string;
        personaname?: string;
        profileurl?: string;
        avatarfull?: string;
        personastate?: number;
        timecreated?: number;
        gameextrainfo?: string;
      }>;
    };
  }>(url);

  const p = body.response?.players?.[0];
  if (!p) return null;
  return {
    steamId64: p.steamid,
    personaName: p.personaname ?? "",
    profileUrl: p.profileurl ?? "",
    avatar: p.avatarfull ?? "",
    personaState: p.personastate ?? 0,
    createdAt: p.timecreated ?? 0,
    currentGame: p.gameextrainfo ?? null,
  };
}

export interface RecentGame {
  appid: number;
  name: string;
  playtime2Weeks: number;
  playtimeForever: number;
}

export async function getRecentlyPlayed(steamId64: string, count = 20): Promise<RecentGame[]> {
  const key = requireKey();
  const url = `${BASE}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId64)}&count=${count}`;
  const body = await getJson<{
    response?: {
      games?: Array<{
        appid: number;
        name?: string;
        playtime_2weeks?: number;
        playtime_forever?: number;
      }>;
    };
  }>(url);

  return (body.response?.games ?? []).map((g) => ({
    appid: g.appid,
    name: g.name ?? String(g.appid),
    playtime2Weeks: g.playtime_2weeks ?? 0,
    playtimeForever: g.playtime_forever ?? 0,
  }));
}

export interface WishlistItem {
  appid: number;
  priority: number;
  addedAt: number;
}

export async function getWishlist(steamId64: string): Promise<WishlistItem[]> {
  const key = requireKey();
  const url = `${BASE}/IWishlistService/GetWishlist/v1/?key=${encodeURIComponent(key)}&steamid=${encodeURIComponent(steamId64)}`;
  const body = await getJson<{
    response?: {
      items?: Array<{ appid: number; priority?: number; date_added?: number }>;
    };
  }>(url);

  return (body.response?.items ?? []).map((i) => ({
    appid: i.appid,
    priority: i.priority ?? 0,
    addedAt: i.date_added ?? 0,
  }));
}
