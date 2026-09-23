import { cache, RateLimiter } from "../cache.js";

/**
 * Name resolution for apps that are not in the user's library.
 *
 * Wishlisted (and other unowned) apps are invisible to both the Steam client's
 * appStore and IPlayerService/GetOwnedGames, so they have no name locally.
 * The storefront's own browse service resolves many appids in a single request,
 * which the per-app appdetails endpoint cannot do — that one ignores extra ids
 * and returns null when given a list with filters.
 *
 * No API key required.
 */

const NAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Keeps the query string well inside limits and each response small. */
const CHUNK_SIZE = 50;

// api.steampowered.com is far more generous than the storefront, but there is
// no reason to hammer it.
const limiter = new RateLimiter(400);

interface StoreItem {
  appid?: number;
  name?: string;
  type?: number;
}

async function fetchChunk(appids: number[]): Promise<Map<number, string>> {
  const input = {
    ids: appids.map((appid) => ({ appid })),
    context: { language: "english", country_code: "US" },
    data_request: { include_basic_info: true },
  };
  const url =
    "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" +
    encodeURIComponent(JSON.stringify(input));

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "steam-mcp/0.1 (local)" },
    });
    if (!res.ok) return new Map();
    const body = (await res.json()) as { response?: { store_items?: StoreItem[] } };
    const out = new Map<number, string>();
    for (const item of body.response?.store_items ?? []) {
      if (typeof item.appid === "number" && typeof item.name === "string" && item.name) {
        out.set(item.appid, item.name);
      }
    }
    return out;
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves appids to store names, caching each one individually so repeated
 * lookups across different calls cost nothing.
 */
export async function resolveAppNames(appids: number[]): Promise<Map<number, string>> {
  const resolved = new Map<number, string>();
  const missing: number[] = [];

  for (const appid of new Set(appids)) {
    const cached = cache().get<string>("app-names", NAME_TTL_MS, String(appid));
    if (cached) resolved.set(appid, cached);
    else missing.push(appid);
  }

  for (let i = 0; i < missing.length; i += CHUNK_SIZE) {
    const chunk = missing.slice(i, i + CHUNK_SIZE);
    const names = await limiter.run(() => fetchChunk(chunk));
    for (const [appid, name] of names) {
      resolved.set(appid, name);
      cache().set("app-names", name, String(appid));
    }
  }

  return resolved;
}
