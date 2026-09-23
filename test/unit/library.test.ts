import { describe, expect, it, vi, afterEach } from "vitest";
import {
  applyFilters,
  paginate,
  parseSince,
  project,
  searchGames,
  sortGames,
  type Filters,
} from "../../src/library.js";
import type { Game } from "../../src/merge.js";

const DAY = 86400;
const NOW = 1_800_000_000;

function game(over: Partial<Game> & { appid: number; name: string }): Game {
  return {
    sortAs: over.name,
    kind: 1,
    installed: false,
    hidden: false,
    favorite: false,
    shortcut: false,
    owned: true,
    borrowed: false,
    sizeOnDisk: 0,
    lastPlayed: 0,
    playtimeMinutes: 0,
    purchasedTime: 0,
    reviewPercentage: 0,
    metacriticScore: 0,
    deckCompat: 0,
    tags: [],
    ...over,
  };
}

const LIBRARY: Game[] = [
  game({
    appid: 1,
    name: "Factorio",
    installed: true,
    playtimeMinutes: 9028,
    tags: ["Strategy"],
    sizeOnDisk: 2e9,
    lastPlayed: NOW - 10 * DAY,
    reviewPercentage: 96,
  }),
  game({
    appid: 2,
    name: "FTL: Faster Than Light",
    installed: true,
    playtimeMinutes: 0,
    tags: ["Roguelike"],
    sizeOnDisk: 5e8,
    reviewPercentage: 94,
  }),
  game({
    appid: 3,
    name: "Portal 2",
    playtimeMinutes: 120,
    tags: ["Puzzle"],
    lastPlayed: NOW - 400 * DAY,
    reviewPercentage: 98,
  }),
  game({ appid: 4, name: "Hidden Gem", hidden: true, playtimeMinutes: 5 }),
  game({ appid: 5, name: "Beloved", favorite: true, playtimeMinutes: 30, kind: 5 }),
];

describe("applyFilters", () => {
  const run = (f: Filters, members?: Set<number>) =>
    applyFilters(LIBRARY, f, members).map((g) => g.appid);

  it("excludes hidden games by default", () => {
    expect(run({})).toEqual([1, 2, 3, 5]);
  });

  it("returns only hidden games when hidden=true", () => {
    expect(run({ hidden: true })).toEqual([4]);
  });

  it("filters by install state", () => {
    expect(run({ installed: true })).toEqual([1, 2]);
    expect(run({ installed: false })).toEqual([3, 5]);
  });

  it("treats played as playtime above zero", () => {
    expect(run({ played: true })).toEqual([1, 3, 5]);
    expect(run({ played: false })).toEqual([2]);
  });

  it("filters by favorite, kind, and tag", () => {
    expect(run({ favorite: true })).toEqual([5]);
    expect(run({ kind: "tool" })).toEqual([5]);
    expect(run({ tag: "roguelike" })).toEqual([2]); // case-insensitive
    expect(run({ tag: "Nonexistent" })).toEqual([]);
  });

  it("filters by playtime and size ranges", () => {
    expect(run({ minPlaytimeMinutes: 100 })).toEqual([1, 3]);
    expect(run({ maxPlaytimeMinutes: 100 })).toEqual([2, 5]);
    expect(run({ minSizeBytes: 1e9 })).toEqual([1]);
    expect(run({ maxSizeBytes: 1e9 })).toEqual([2, 3, 5]);
  });

  it("filters by review score", () => {
    expect(run({ minReviewPercentage: 95 })).toEqual([1, 3]);
  });

  it("filters by played-since", () => {
    expect(run({ playedSinceEpoch: NOW - 30 * DAY })).toEqual([1]);
  });

  it("counts never-played games as 'not played since'", () => {
    // A game with lastPlayed 0 has genuinely not been played since any date.
    expect(run({ playedBeforeEpoch: NOW - 30 * DAY })).toEqual([2, 3, 5]);
  });

  it("intersects with an explicit collection membership set", () => {
    expect(run({}, new Set([1, 3]))).toEqual([1, 3]);
    expect(run({ installed: true }, new Set([1, 3]))).toEqual([1]);
  });

  it("filters by an explicit appid list", () => {
    expect(run({ appids: [2, 5] })).toEqual([2, 5]);
  });

  it("combines filters conjunctively", () => {
    expect(run({ installed: true, played: false })).toEqual([2]);
  });
});

describe("sortGames", () => {
  const ids = (key: Parameters<typeof sortGames>[1], order: "asc" | "desc") =>
    sortGames(LIBRARY, key, order).map((g) => g.appid);

  it("sorts by name using sortAs", () => {
    expect(ids("name", "asc")).toEqual([5, 1, 2, 4, 3]);
    expect(ids("name", "desc")).toEqual([3, 4, 2, 1, 5]);
  });

  it("sorts numerically by playtime, size and review", () => {
    expect(ids("playtime", "desc")).toEqual([1, 3, 5, 4, 2]);
    expect(ids("size", "desc").slice(0, 2)).toEqual([1, 2]);
    expect(ids("review", "desc").slice(0, 3)).toEqual([3, 1, 2]);
  });

  it("breaks ties by name for stability", () => {
    const tied = [
      game({ appid: 10, name: "Zeta", playtimeMinutes: 5 }),
      game({ appid: 11, name: "Alpha", playtimeMinutes: 5 }),
    ];
    expect(sortGames(tied, "playtime", "desc").map((g) => g.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("does not mutate the input array", () => {
    const before = LIBRARY.map((g) => g.appid);
    sortGames(LIBRARY, "playtime", "desc");
    expect(LIBRARY.map((g) => g.appid)).toEqual(before);
  });
});

describe("searchGames", () => {
  const names = (q: string, limit = 5) => searchGames(LIBRARY, q, limit).map((h) => h.game.name);

  it("finds an exact match first", () => {
    expect(names("Portal 2")[0]).toBe("Portal 2");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(names("ftl faster than light")[0]).toBe("FTL: Faster Than Light");
    expect(names("FACTORIO")[0]).toBe("Factorio");
  });

  it("matches a prefix and a substring", () => {
    expect(names("Fact")[0]).toBe("Factorio");
    expect(names("Than Light")[0]).toBe("FTL: Faster Than Light");
  });

  it("matches by appid", () => {
    expect(names("3")[0]).toBe("Portal 2");
  });

  it("ranks an exact match above a longer name containing it", () => {
    const pool = [
      game({ appid: 20, name: "Portal" }),
      game({ appid: 21, name: "Portal 2 Soundtrack Deluxe" }),
    ];
    expect(searchGames(pool, "Portal", 5)[0]?.game.name).toBe("Portal");
  });

  it("respects the limit and returns nothing for an empty query", () => {
    expect(searchGames(LIBRARY, "a", 2)).toHaveLength(2);
    expect(searchGames(LIBRARY, "   ", 5)).toEqual([]);
  });

  it("returns nothing when there is no plausible match", () => {
    expect(names("zzzzqqqq")).toEqual([]);
  });
});

describe("project", () => {
  const g = LIBRARY[0]!;

  it("returns only the requested fields", () => {
    expect(project(g, ["appid", "name"])).toEqual({ appid: 1, name: "Factorio" });
  });

  it("renders kind as a human-readable name", () => {
    expect(project(g, ["kind"])).toEqual({ kind: "game" });
    expect(project(game({ appid: 9, name: "x", kind: 99 }), ["kind"])).toEqual({ kind: "unknown" });
  });

  it("renders dates as ISO days and null when never played", () => {
    expect(project(g, ["lastPlayed"])["lastPlayed"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(project(LIBRARY[1]!, ["lastPlayed"])).toEqual({ lastPlayed: null });
  });

  it("converts size to gigabytes under a clearer key", () => {
    expect(project(g, ["sizeOnDisk"])).toEqual({ sizeGB: 2 });
    expect(project(LIBRARY[2]!, ["sizeOnDisk"])).toEqual({ sizeGB: 0 });
  });
});

describe("parseSince", () => {
  afterEach(() => vi.useRealTimers());

  it("parses ISO dates", () => {
    expect(parseSince("2025-01-01")).toBe(Math.floor(Date.parse("2025-01-01") / 1000));
  });

  it("parses relative durations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    expect(parseSince("30d")).toBe(now - 30 * DAY);
    expect(parseSince("2w")).toBe(now - 14 * DAY);
    expect(parseSince("6m")).toBe(now - 180 * DAY);
    expect(parseSince("1y")).toBe(now - 365 * DAY);
    expect(parseSince(" 7 D ")).toBe(now - 7 * DAY);
  });

  it("returns null for unparseable input", () => {
    expect(parseSince("soon")).toBeNull();
    expect(parseSince("")).toBeNull();
  });
});

describe("paginate", () => {
  it("slices by limit and offset", () => {
    expect(paginate([1, 2, 3, 4, 5], 2, 0)).toEqual([1, 2]);
    expect(paginate([1, 2, 3, 4, 5], 2, 3)).toEqual([4, 5]);
    expect(paginate([1, 2, 3], 10, 0)).toEqual([1, 2, 3]);
    expect(paginate([1, 2, 3], 2, 99)).toEqual([]);
  });
});
