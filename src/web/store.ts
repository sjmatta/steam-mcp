import { cache, RateLimiter } from "../cache.js";

/**
 * Steam storefront endpoints. No API key, but a hard IP budget of roughly
 * 200 requests per 5 minutes, so every call is serialised behind a limiter and
 * everything is cached — including failures.
 */

const DETAILS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Delisted or region-locked apps answer success:false. Cache that too, or we
 *  burn the budget re-asking about the same dead appids on every request. */
const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEWS_TTL_MS = 24 * 60 * 60 * 1000;

// ~1.6s between calls keeps us comfortably under 200 per 5 minutes.
const storeLimiter = new RateLimiter(1600);

export interface StoreDetails {
  appid: number;
  success: boolean;
  name?: string;
  type?: string;
  isFree?: boolean;
  shortDescription?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  categories?: string[];
  releaseDate?: string;
  comingSoon?: boolean;
  metacritic?: number;
  requiredAge?: number;
  controllerSupport?: string;
  platforms?: { windows: boolean; mac: boolean; linux: boolean };
  headerImage?: string;
  priceFormatted?: string;
  discountPercent?: number;
}

export interface ReviewSummary {
  appid: number;
  reviewScore: number;
  reviewScoreDesc: string;
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
  positivePercent: number;
}

async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "steam-mcp/0.1 (local)" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Store metadata for one app. The endpoint only returns full data for a single
 * appid at a time, so batching is not an option.
 */
export async function getStoreDetails(
  appid: number,
  opts: { force?: boolean } = {},
): Promise<StoreDetails> {
  const key = String(appid);
  if (!opts.force) {
    const cached = cache().get<StoreDetails>("store-details", DETAILS_TTL_MS, key);
    if (cached?.success) return cached;
    const negative = cache().get<StoreDetails>("store-details", NEGATIVE_TTL_MS, key);
    if (negative && !negative.success) return negative;
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english`;
  const body = await storeLimiter.run(() =>
    getJson<Record<string, { success?: boolean; data?: Record<string, unknown> }>>(url),
  );

  const entry = body?.[key];
  if (!entry?.success || !entry.data) {
    const miss: StoreDetails = { appid, success: false };
    cache().set("store-details", miss, key);
    return miss;
  }

  const d = entry.data;
  const names = (v: unknown): string[] =>
    Array.isArray(v)
      ? v
          .map((x) =>
            typeof x === "string"
              ? x
              : typeof (x as { description?: unknown })?.description === "string"
                ? (x as { description: string }).description
                : "",
          )
          .filter((s) => s.length > 0)
      : [];

  const release = d["release_date"] as { date?: string; coming_soon?: boolean } | undefined;
  const price = d["price_overview"] as
    { final_formatted?: string; discount_percent?: number } | undefined;
  const platforms = d["platforms"] as
    { windows?: boolean; mac?: boolean; linux?: boolean } | undefined;
  const metacritic = d["metacritic"] as { score?: number } | undefined;

  const details: StoreDetails = {
    appid,
    success: true,
    name: typeof d["name"] === "string" ? d["name"] : undefined,
    type: typeof d["type"] === "string" ? d["type"] : undefined,
    isFree: d["is_free"] === true,
    shortDescription:
      typeof d["short_description"] === "string" ? d["short_description"] : undefined,
    developers: names(d["developers"]),
    publishers: names(d["publishers"]),
    genres: names(d["genres"]),
    categories: names(d["categories"]),
    releaseDate: release?.date,
    comingSoon: release?.coming_soon === true,
    metacritic: metacritic?.score,
    requiredAge: typeof d["required_age"] === "number" ? d["required_age"] : undefined,
    controllerSupport:
      typeof d["controller_support"] === "string" ? d["controller_support"] : undefined,
    platforms: platforms
      ? {
          windows: platforms.windows === true,
          mac: platforms.mac === true,
          linux: platforms.linux === true,
        }
      : undefined,
    headerImage: typeof d["header_image"] === "string" ? d["header_image"] : undefined,
    priceFormatted: price?.final_formatted,
    discountPercent: price?.discount_percent,
  };

  cache().set("store-details", details, key);
  return details;
}

/** Aggregate review score. num_per_page=0 returns only the summary. */
export async function getReviewSummary(
  appid: number,
  opts: { force?: boolean } = {},
): Promise<ReviewSummary | null> {
  const key = String(appid);
  if (!opts.force) {
    const cached = cache().get<ReviewSummary>("store-reviews", REVIEWS_TTL_MS, key);
    if (cached) return cached;
  }

  const url = `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`;
  const body = await storeLimiter.run(() =>
    getJson<{
      success?: number;
      query_summary?: {
        review_score?: number;
        review_score_desc?: string;
        total_positive?: number;
        total_negative?: number;
        total_reviews?: number;
      };
    }>(url),
  );

  const q = body?.query_summary;
  if (!q) return null;

  const positive = q.total_positive ?? 0;
  const negative = q.total_negative ?? 0;
  const total = q.total_reviews ?? positive + negative;

  const summary: ReviewSummary = {
    appid,
    reviewScore: q.review_score ?? 0,
    reviewScoreDesc: q.review_score_desc ?? "",
    totalPositive: positive,
    totalNegative: negative,
    totalReviews: total,
    positivePercent: total > 0 ? Math.round((positive / total) * 100) : 0,
  };

  cache().set("store-reviews", summary, key);
  return summary;
}
