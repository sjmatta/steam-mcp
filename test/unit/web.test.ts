import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../helpers/fixtures.js";
import { stubFetch } from "../helpers/http.js";

const STEAMID = "76561197972611406";
const cleanups: Array<() => void> = [];

/** Each test gets a private cache dir so nothing leaks between cases. */
beforeEach(() => {
  const { dir, cleanup } = tempDir("steam-mcp-web-");
  cleanups.push(cleanup);
  vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
  vi.stubEnv("STEAM_API_KEY", "TESTKEY");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  while (cleanups.length) cleanups.pop()!();
});

describe("Steam Web API", () => {
  it("requests owned games with the fields the model needs", async () => {
    const http = stubFetch(() => ({
      body: {
        response: {
          game_count: 2,
          games: [
            { appid: 1, name: "One", playtime_forever: 100, rtime_last_played: 50, sort_as: "one" },
            { appid: 2, name: "Two" },
          ],
        },
      },
    }));
    const { getOwnedGames } = await import("../../src/web/webapi.js");

    const games = await getOwnedGames(STEAMID);
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({ appid: 1, name: "One", playtimeForever: 100, lastPlayed: 50 });
    // Missing fields default rather than becoming undefined.
    expect(games[1]).toMatchObject({ appid: 2, playtimeForever: 0, lastPlayed: 0 });

    const url = http.calls[0]!.url;
    expect(url).toContain("IPlayerService/GetOwnedGames");
    expect(url).toContain("include_appinfo=1");
    expect(url).toContain("include_played_free_games=1");
    expect(url).toContain("key=TESTKEY");
  });

  it("caches owned games and does not refetch", async () => {
    const http = stubFetch(() => ({ body: { response: { games: [{ appid: 1, name: "One" }] } } }));
    const { getOwnedGames } = await import("../../src/web/webapi.js");

    await getOwnedGames(STEAMID);
    await getOwnedGames(STEAMID);
    expect(http.countMatching("GetOwnedGames")).toBe(1);

    await getOwnedGames(STEAMID, { force: true });
    expect(http.countMatching("GetOwnedGames")).toBe(2);
  });

  it("reports a missing API key as an actionable error", async () => {
    vi.stubEnv("STEAM_API_KEY", "");
    vi.resetModules();
    const { getOwnedGames, hasApiKey } = await import("../../src/web/webapi.js");

    expect(hasApiKey()).toBe(false);
    // The remedy lives in `hint`, which is what the tool surfaces to the model.
    await expect(getOwnedGames(STEAMID)).rejects.toMatchObject({
      code: "NO_API_KEY",
      hint: expect.stringContaining("steamcommunity.com/dev/apikey"),
    });
  });

  it("distinguishes rate limiting from other failures", async () => {
    stubFetch(() => ({ status: 429, body: {} }));
    const { getOwnedGames } = await import("../../src/web/webapi.js");
    await expect(getOwnedGames(STEAMID)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("suggests checking the key on an auth failure", async () => {
    stubFetch(() => ({ status: 403, body: {} }));
    const { getOwnedGames } = await import("../../src/web/webapi.js");
    await expect(getOwnedGames(STEAMID)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(getOwnedGames(STEAMID)).rejects.toThrow(/HTTP 403/);
  });

  it("wraps a transport failure", async () => {
    stubFetch(() => ({ throws: true }));
    const { getOwnedGames } = await import("../../src/web/webapi.js");
    await expect(getOwnedGames(STEAMID)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("does not expose an API key from a transport error", async () => {
    const fakeKey = "A".repeat(32);
    vi.stubEnv("STEAM_API_KEY", fakeKey);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`request failed: key=${fakeKey}`)));
    const { getOwnedGames } = await import("../../src/web/webapi.js");
    await expect(getOwnedGames(STEAMID)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Steam Web API request failed.",
    });
  });

  it("reads a player summary", async () => {
    stubFetch(() => ({
      body: {
        response: {
          players: [
            { steamid: STEAMID, personaname: "shaydin", timecreated: 1106352000, personastate: 1 },
          ],
        },
      },
    }));
    const { getPlayerSummary } = await import("../../src/web/webapi.js");
    expect(await getPlayerSummary(STEAMID)).toMatchObject({
      personaName: "shaydin",
      createdAt: 1106352000,
    });
  });

  it("returns null when the profile is absent", async () => {
    stubFetch(() => ({ body: { response: { players: [] } } }));
    const { getPlayerSummary } = await import("../../src/web/webapi.js");
    expect(await getPlayerSummary(STEAMID)).toBeNull();
  });

  it("reads the wishlist, which returns appids only", async () => {
    stubFetch(() => ({
      body: { response: { items: [{ appid: 990080, priority: 1, date_added: 100 }] } },
    }));
    const { getWishlist } = await import("../../src/web/webapi.js");
    const items = await getWishlist(STEAMID);
    // No name field: this is exactly why names need separate resolution.
    expect(items).toEqual([{ appid: 990080, priority: 1, addedAt: 100 }]);
  });

  it("reads recently played games", async () => {
    stubFetch(() => ({
      body: { response: { games: [{ appid: 1, name: "One", playtime_2weeks: 30 }] } },
    }));
    const { getRecentlyPlayed } = await import("../../src/web/webapi.js");
    expect(await getRecentlyPlayed(STEAMID, 5)).toEqual([
      { appid: 1, name: "One", playtime2Weeks: 30, playtimeForever: 0 },
    ]);
  });
});

describe("store API", () => {
  const detailsBody = (appid: number) => ({
    [String(appid)]: {
      success: true,
      data: {
        name: "Factorio",
        type: "game",
        is_free: false,
        short_description: "A game about factories.",
        developers: ["Wube"],
        publishers: ["Wube"],
        genres: [{ id: "28", description: "Simulation" }],
        categories: [{ id: 2, description: "Single-player" }],
        release_date: { coming_soon: false, date: "14 Aug, 2020" },
        metacritic: { score: 90 },
        platforms: { windows: true, mac: true, linux: true },
        price_overview: { final_formatted: "$35.00", discount_percent: 0 },
        controller_support: "full",
      },
    },
  });

  it("maps the store payload onto a flat shape", async () => {
    stubFetch((url) => (url.includes("appdetails") ? { body: detailsBody(427520) } : null));
    const { getStoreDetails } = await import("../../src/web/store.js");

    const details = await getStoreDetails(427520);
    expect(details).toMatchObject({
      success: true,
      name: "Factorio",
      genres: ["Simulation"],
      categories: ["Single-player"],
      developers: ["Wube"],
      releaseDate: "14 Aug, 2020",
      metacritic: 90,
      priceFormatted: "$35.00",
      controllerSupport: "full",
    });
    expect(details.platforms).toEqual({ windows: true, mac: true, linux: true });
  });

  it("requests one appid at a time, since batching returns no detail", async () => {
    const http = stubFetch((url) =>
      url.includes("appdetails") ? { body: detailsBody(427520) } : null,
    );
    const { getStoreDetails } = await import("../../src/web/store.js");
    await getStoreDetails(427520);
    expect(http.calls[0]!.url).toContain("appids=427520");
    expect(http.calls[0]!.url).not.toContain(",");
  });

  it("caches a successful lookup", async () => {
    const http = stubFetch(() => ({ body: detailsBody(427520) }));
    const { getStoreDetails } = await import("../../src/web/store.js");
    await getStoreDetails(427520);
    await getStoreDetails(427520);
    expect(http.countMatching("appdetails")).toBe(1);
  });

  it("caches a failed lookup so dead appids do not burn the rate limit", async () => {
    const http = stubFetch(() => ({ body: { "1": { success: false } } }));
    const { getStoreDetails } = await import("../../src/web/store.js");

    expect(await getStoreDetails(1)).toMatchObject({ success: false });
    expect(await getStoreDetails(1)).toMatchObject({ success: false });
    expect(http.countMatching("appdetails")).toBe(1);
  });

  it("treats a transport failure as an unavailable app rather than throwing", async () => {
    stubFetch(() => ({ throws: true }));
    const { getStoreDetails } = await import("../../src/web/store.js");
    await expect(getStoreDetails(1)).resolves.toMatchObject({ success: false });
  });

  it("summarises reviews and computes a positive percentage", async () => {
    stubFetch((url) =>
      url.includes("appreviews")
        ? {
            body: {
              query_summary: {
                review_score: 8,
                review_score_desc: "Very Positive",
                total_positive: 90,
                total_negative: 10,
                total_reviews: 100,
              },
            },
          }
        : null,
    );
    const { getReviewSummary } = await import("../../src/web/store.js");
    expect(await getReviewSummary(646570)).toMatchObject({
      reviewScoreDesc: "Very Positive",
      positivePercent: 90,
      totalReviews: 100,
    });
  });

  it("asks only for the summary, not review bodies", async () => {
    const http = stubFetch(() => ({ body: { query_summary: { total_reviews: 0 } } }));
    const { getReviewSummary } = await import("../../src/web/store.js");
    await getReviewSummary(1);
    expect(http.calls[0]!.url).toContain("num_per_page=0");
  });

  it("returns null when there is no review summary", async () => {
    stubFetch(() => ({ body: {} }));
    const { getReviewSummary } = await import("../../src/web/store.js");
    expect(await getReviewSummary(1)).toBeNull();
  });

  it("avoids dividing by zero for an unreviewed app", async () => {
    stubFetch(() => ({
      body: { query_summary: { total_positive: 0, total_negative: 0, total_reviews: 0 } },
    }));
    const { getReviewSummary } = await import("../../src/web/store.js");
    expect((await getReviewSummary(1))!.positivePercent).toBe(0);
  });
});

describe("store browse (name resolution)", () => {
  it("resolves many appids in a single request", async () => {
    const http = stubFetch(() => ({
      body: {
        response: {
          store_items: [
            { appid: 1, name: "One" },
            { appid: 2, name: "Two" },
          ],
        },
      },
    }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");

    const names = await resolveAppNames([1, 2]);
    expect(names.get(1)).toBe("One");
    expect(names.get(2)).toBe("Two");
    // One batched request, not one per app.
    expect(http.calls).toHaveLength(1);
  });

  it("caches names and only fetches the unknown ones", async () => {
    // Echo back only the ids actually requested, as the real endpoint does.
    const http = stubFetch((url) => {
      const requested = [...decodeURIComponent(url).matchAll(/"appid":(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      return {
        body: {
          response: { store_items: requested.map((appid) => ({ appid, name: `Name${appid}` })) },
        },
      };
    });
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");

    await resolveAppNames([1]);
    await resolveAppNames([1, 2]);
    expect(http.calls).toHaveLength(2);
    // The second request asks only about appid 2.
    expect(http.calls[1]!.url).toContain("%22appid%22%3A2");
    expect(http.calls[1]!.url).not.toContain("%22appid%22%3A1");
  });

  it("makes no request when everything is cached", async () => {
    const http = stubFetch(() => ({
      body: { response: { store_items: [{ appid: 1, name: "One" }] } },
    }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");
    await resolveAppNames([1]);
    await resolveAppNames([1]);
    expect(http.calls).toHaveLength(1);
  });

  it("chunks large requests", async () => {
    const http = stubFetch(() => ({ body: { response: { store_items: [] } } }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");
    await resolveAppNames(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(http.calls.length).toBe(3); // 50 + 50 + 20
  });

  it("returns an empty map rather than throwing when the request fails", async () => {
    stubFetch(() => ({ throws: true }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");
    expect((await resolveAppNames([1])).size).toBe(0);
  });

  it("skips items with no usable name", async () => {
    stubFetch(() => ({
      body: {
        response: { store_items: [{ appid: 1 }, { appid: 2, name: "" }, { appid: 3, name: "Ok" }] },
      },
    }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");
    const names = await resolveAppNames([1, 2, 3]);
    expect([...names.keys()]).toEqual([3]);
  });

  it("de-duplicates repeated appids", async () => {
    const http = stubFetch(() => ({
      body: { response: { store_items: [{ appid: 1, name: "One" }] } },
    }));
    const { resolveAppNames } = await import("../../src/web/storebrowse.js");
    await resolveAppNames([1, 1, 1]);
    expect(http.calls[0]!.url.match(/%22appid%22/g)).toHaveLength(1);
  });
});
