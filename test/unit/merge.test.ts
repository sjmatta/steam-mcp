import { describe, expect, it } from "vitest";
import {
  applyFlags,
  mergeOfflineSources,
  placeholderName,
  snapshotToGames,
  PLACEHOLDER_NAME_RE,
} from "../../src/merge.js";
import type { LibrarySnapshot } from "../../src/cdp/programs/types.js";
import type { InstalledApp } from "../../src/local/appmanifests.js";
import type { LocalPlaytime } from "../../src/local/localconfig.js";
import type { OwnedGame } from "../../src/web/webapi.js";

const COLS = [
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

function snapshot(over: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    cols: COLS,
    rows: [
      [427520, "Factorio", "factorio", 1, 0, 1, 0, 1, 0, 2e9, 1784500000, 9028, 0, 96, 90, 3],
      [620, "Portal 2", "portal 2", 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 98, 95, 3],
    ],
    installed: [427520],
    tagNames: { "9": "Strategy", "492": "Indie" },
    appTags: { "427520": [9, 492, 12345] },
    total: 2,
    ...over,
  };
}

function installed(over: Partial<InstalledApp> & { appid: number }): InstalledApp {
  return {
    name: `App ${over.appid}`,
    installDir: "",
    sizeOnDisk: 0,
    lastUpdated: 0,
    lastPlayed: 0,
    stateFlags: 4,
    fullyInstalled: true,
    buildId: "",
    libraryPath: "",
    ...over,
  };
}

function playtime(appid: number, minutes: number, lastPlayed = 0): LocalPlaytime {
  return { appid, playtimeMinutes: minutes, playtime2Weeks: 0, lastPlayed };
}

function owned(over: Partial<OwnedGame> & { appid: number }): OwnedGame {
  return {
    name: `Owned ${over.appid}`,
    playtimeForever: 0,
    playtime2Weeks: 0,
    lastPlayed: 0,
    reviewPercentage: 0,
    sortAs: `Owned ${over.appid}`,
    ...over,
  };
}

describe("snapshotToGames", () => {
  it("maps columnar rows onto the game model", () => {
    const [factorio] = snapshotToGames(snapshot());
    expect(factorio).toMatchObject({
      appid: 427520,
      name: "Factorio",
      sortAs: "factorio",
      kind: 1,
      playtimeMinutes: 9028,
      sizeOnDisk: 2e9,
      reviewPercentage: 96,
      deckCompat: 3,
    });
  });

  it("derives installed from the local-install set, not a per-app flag", () => {
    const games = snapshotToGames(snapshot());
    expect(games.find((g) => g.appid === 427520)!.installed).toBe(true);
    expect(games.find((g) => g.appid === 620)!.installed).toBe(false);
  });

  it("resolves tag ids through the shared dictionary and drops unknown ids", () => {
    const [factorio] = snapshotToGames(snapshot());
    // 12345 has no entry in tagNames and must not appear as undefined.
    expect(factorio!.tags).toEqual(["Strategy", "Indie"]);
  });

  it("reads columns by name so a reordered snapshot still maps correctly", () => {
    const reordered = snapshot({
      cols: ["name", "appid"],
      rows: [["Reordered", 42]],
      appTags: {},
    });
    const [g] = snapshotToGames(reordered);
    expect(g).toMatchObject({ appid: 42, name: "Reordered" });
  });

  it("falls back to a placeholder when the name column is absent", () => {
    const noName = snapshot({ cols: ["appid"], rows: [[77]], appTags: {} });
    expect(snapshotToGames(noName)[0]!.name).toBe("App 77");
  });

  it("defaults owned to true and other numeric fields to zero", () => {
    const sparse = snapshot({ cols: ["appid"], rows: [[5]], appTags: {} });
    const [g] = snapshotToGames(sparse);
    expect(g!.owned).toBe(true);
    expect(g!.playtimeMinutes).toBe(0);
    expect(g!.hidden).toBe(false);
  });

  it("leaves favorite false; it comes from collection membership", () => {
    expect(snapshotToGames(snapshot()).every((g) => !g.favorite)).toBe(true);
  });
});

describe("mergeOfflineSources", () => {
  it("uses the Web API for the owned set and its playtime", () => {
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1, name: "One", playtimeForever: 500, lastPlayed: 111 })],
      installedApps: [],
      playtime: new Map(),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      appid: 1,
      name: "One",
      playtimeMinutes: 500,
      lastPlayed: 111,
    });
  });

  it("lets local manifests win for install state and size", () => {
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1 })],
      installedApps: [installed({ appid: 1, sizeOnDisk: 12345 })],
      playtime: new Map(),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games[0]).toMatchObject({ installed: true, sizeOnDisk: 12345 });
  });

  it("adds installed games the Web API did not report", () => {
    const games = mergeOfflineSources({
      ownedGames: [],
      installedApps: [installed({ appid: 7, name: "Local Only" })],
      playtime: new Map(),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ appid: 7, name: "Local Only", installed: true });
  });

  it("uses local playtime only to fill gaps, never to overwrite the Web API", () => {
    // Local playtime is per-machine; the Web API total spans every device.
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1, playtimeForever: 900, lastPlayed: 50 })],
      installedApps: [],
      playtime: new Map([[1, playtime(1, 10, 20)]]),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games[0]).toMatchObject({ playtimeMinutes: 900, lastPlayed: 50 });
  });

  it("fills a zero playtime from local records", () => {
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1, playtimeForever: 0, lastPlayed: 0 })],
      installedApps: [],
      playtime: new Map([[1, playtime(1, 10, 20)]]),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games[0]).toMatchObject({ playtimeMinutes: 10, lastPlayed: 20 });
  });

  it("invents a placeholder entry for a played game no other source knows", () => {
    const games = mergeOfflineSources({
      installedApps: [],
      playtime: new Map([[42, playtime(42, 30, 99)]]),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games[0]!.name).toBe("App 42");
    expect(PLACEHOLDER_NAME_RE.test(games[0]!.name)).toBe(true);
  });

  it("ignores a local record with neither playtime nor a last-played date", () => {
    const games = mergeOfflineSources({
      installedApps: [],
      playtime: new Map([[42, playtime(42, 0, 0)]]),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games).toEqual([]);
  });

  it("applies hidden and favorite membership", () => {
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1 }), owned({ appid: 2 })],
      installedApps: [],
      playtime: new Map(),
      hiddenIds: [1],
      favoriteIds: [2],
    });
    expect(games.find((g) => g.appid === 1)!.hidden).toBe(true);
    expect(games.find((g) => g.appid === 2)!.favorite).toBe(true);
  });

  it("does not duplicate a game present in every source", () => {
    const games = mergeOfflineSources({
      ownedGames: [owned({ appid: 1 })],
      installedApps: [installed({ appid: 1 })],
      playtime: new Map([[1, playtime(1, 5)]]),
      hiddenIds: [],
      favoriteIds: [],
    });
    expect(games).toHaveLength(1);
  });
});

describe("applyFlags", () => {
  it("sets favorite from membership and clears it otherwise", () => {
    const games = snapshotToGames(snapshot());
    applyFlags(games, [427520], []);
    expect(games.find((g) => g.appid === 427520)!.favorite).toBe(true);
    expect(games.find((g) => g.appid === 620)!.favorite).toBe(false);
  });

  it("treats hidden as additive so a snapshot flag is never cleared", () => {
    // 620 is already hidden in the snapshot; membership that omits it must not
    // un-hide it.
    const games = snapshotToGames(snapshot());
    applyFlags(games, [], []);
    expect(games.find((g) => g.appid === 620)!.hidden).toBe(true);
  });

  it("hides a game named only by membership", () => {
    const games = snapshotToGames(snapshot());
    applyFlags(games, [], [427520]);
    expect(games.find((g) => g.appid === 427520)!.hidden).toBe(true);
  });
});

describe("placeholderName", () => {
  it("round-trips with the detection pattern", () => {
    expect(PLACEHOLDER_NAME_RE.test(placeholderName(123))).toBe(true);
    expect(PLACEHOLDER_NAME_RE.test("Application 123")).toBe(false);
    expect(PLACEHOLDER_NAME_RE.test("App Store Hero")).toBe(false);
  });
});
