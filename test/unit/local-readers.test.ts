import { describe, expect, it } from "vitest";
import {
  libraryFolders,
  parseAppManifest,
  readInstalledApps,
} from "../../src/local/appmanifests.js";
import { readLocalConfig } from "../../src/local/localconfig.js";
import {
  isSystemCollectionId,
  namespaceSidecarFiles,
  readOfflineCollections,
} from "../../src/local/cloudstorage.js";
import {
  listLibraryCacheAppids,
  parseConcatenatedJson,
  readLibraryCacheEntry,
} from "../../src/local/librarycache.js";
import { FIXTURE_ACCOUNT_ID, fixturePaths, missingPaths } from "../helpers/fixtures.js";

const paths = fixturePaths();

describe("appmanifests", () => {
  it("reads every well-formed manifest and skips malformed ones", () => {
    const apps = readInstalledApps(paths);
    expect(apps.map((a) => a.appid)).toEqual([212680, 427520, 3219010]);
    // appmanifest_broken.acf has no appid and must not abort the whole read.
    expect(apps).toHaveLength(3);
  });

  it("extracts the fields the library model depends on", () => {
    const factorio = readInstalledApps(paths).find((a) => a.appid === 427520)!;
    expect(factorio.name).toBe("Factorio");
    expect(factorio.installDir).toBe("Factorio");
    expect(factorio.sizeOnDisk).toBe(2_591_773_184);
    expect(factorio.buildId).toBe("18027179");
  });

  it("treats StateFlags bit 4 as the installed marker", () => {
    const apps = readInstalledApps(paths);
    expect(apps.find((a) => a.appid === 427520)!.fullyInstalled).toBe(true);
    // 1026 has bit 4 clear: downloading, not installed.
    const partial = apps.find((a) => a.appid === 3219010)!;
    expect(partial.stateFlags).toBe(1026);
    expect(partial.fullyInstalled).toBe(false);
  });

  it("unescapes quotes in app names", () => {
    const app = readInstalledApps(paths).find((a) => a.appid === 3219010)!;
    expect(app.name).toBe('Fogpiercer "Deluxe" Edition');
  });

  it("includes extra library roots but survives ones that do not exist", () => {
    const folders = libraryFolders(paths);
    expect(folders).toContain(paths.steamapps);
    expect(folders.some((f) => f.includes("second-library"))).toBe(true);
    expect(() => readInstalledApps(paths)).not.toThrow();
  });

  it("returns an empty list when the Steam directory is absent", () => {
    expect(readInstalledApps(missingPaths())).toEqual([]);
  });

  it("falls back to a placeholder name when the manifest has none", () => {
    const app = parseAppManifest(`"AppState" { "appid" "5" "StateFlags" "4" }`);
    expect(app?.name).toBe("App 5");
  });

  it("rejects a manifest with no AppState or no appid", () => {
    expect(parseAppManifest(`"Nope" { "appid" "5" }`)).toBeNull();
    expect(parseAppManifest(`"AppState" { "name" "x" }`)).toBeNull();
  });
});

describe("localconfig", () => {
  it("reads playtime from Software/Valve/Steam/apps, not WebStorage/apps", () => {
    // Both nodes are named `apps`; only the first holds playtime. A naive
    // search would find WebStorage's launch-option node instead.
    const cfg = readLocalConfig(FIXTURE_ACCOUNT_ID, paths);
    expect([...cfg.playtime.keys()].sort((a, b) => a - b)).toEqual([620, 999, 212680, 427520]);
    expect(cfg.playtime.get(427520)).toMatchObject({
      playtimeMinutes: 9028,
      playtime2Weeks: 120,
      lastPlayed: 1784500000,
    });
  });

  it("defaults missing playtime fields to zero", () => {
    const cfg = readLocalConfig(FIXTURE_ACCOUNT_ID, paths);
    expect(cfg.playtime.get(999)).toMatchObject({
      playtimeMinutes: 0,
      playtime2Weeks: 0,
      lastPlayed: 0,
    });
  });

  it("parses the embedded JSON tag dictionary", () => {
    const cfg = readLocalConfig(FIXTURE_ACCOUNT_ID, paths);
    expect(cfg.tagNames.get(9)).toBe("Strategy");
    expect(cfg.tagNames.get(1716)).toBe("Roguelike");
    expect(cfg.tagNames.size).toBe(4);
  });

  it("parses the private-apps list", () => {
    expect(readLocalConfig(FIXTURE_ACCOUNT_ID, paths).privateApps).toEqual([431960, 1790230]);
  });

  it("returns empty structures when the file is missing", () => {
    const cfg = readLocalConfig(FIXTURE_ACCOUNT_ID, missingPaths());
    expect(cfg.playtime.size).toBe(0);
    expect(cfg.tagNames.size).toBe(0);
  });
});

describe("cloudstorage collections", () => {
  const read = () => readOfflineCollections(FIXTURE_ACCOUNT_ID, paths);

  it("returns only live collections and counts tombstones separately", () => {
    const { collections, tombstoneCount, totalEntries } = read();
    expect(collections.map((c) => c.id).sort()).toEqual([
      "favorite",
      "hidden",
      "uc-8qBpJj1*+Borh",
      "uc-Aj+bldZKtzMv",
      "uc-B2ZzHzFyWFUr",
    ]);
    // Two is_deleted entries plus one whose value is unparseable.
    expect(tombstoneCount).toBe(2);
    expect(totalEntries).toBe(11);
  });

  it("ignores non-collection keys sharing the same file", () => {
    const ids = read().collections.map((c) => c.id);
    expect(ids).not.toContain("sc-version");
    expect(ids.some((id) => id.startsWith("showcases"))).toBe(false);
  });

  it("preserves opaque ids containing + and * byte for byte", () => {
    const ids = read().collections.map((c) => c.id);
    expect(ids).toContain("uc-8qBpJj1*+Borh");
    expect(ids).toContain("uc-Aj+bldZKtzMv");
  });

  it("parses the stringified inner value", () => {
    const fav = read().collections.find((c) => c.id === "favorite")!;
    expect(fav.name).toBe("Favorites");
    expect(fav.added).toEqual([427520, 212680]);
    expect(fav.removed).toEqual([]);
  });

  it("flags filterSpec collections as dynamic", () => {
    const collections = read().collections;
    const dynamic = collections.find((c) => c.id === "uc-B2ZzHzFyWFUr")!;
    expect(dynamic.isDynamic).toBe(true);
    expect(dynamic.filterSpec?.nFormatVersion).toBe(2);
    // `removed` is meaningful even when `added` is empty.
    expect(dynamic.removed).toEqual([212680]);
    expect(collections.find((c) => c.id === "uc-Aj+bldZKtzMv")!.isDynamic).toBe(false);
  });

  it("marks Steam's own collections as system", () => {
    const collections = read().collections;
    expect(collections.find((c) => c.id === "favorite")!.isSystem).toBe(true);
    expect(collections.find((c) => c.id === "hidden")!.isSystem).toBe(true);
    expect(collections.find((c) => c.id === "uc-Aj+bldZKtzMv")!.isSystem).toBe(false);
    expect(isSystemCollectionId("type-games")).toBe(true);
    expect(isSystemCollectionId("uc-whatever")).toBe(false);
  });

  it("skips an entry whose value is not valid JSON without losing the rest", () => {
    expect(read().collections.some((c) => c.id === "uc-Corrupt")).toBe(false);
    expect(read().collections.length).toBe(5);
  });

  it("returns an empty result for a missing file", () => {
    const empty = readOfflineCollections(FIXTURE_ACCOUNT_ID, missingPaths());
    expect(empty.collections).toEqual([]);
    expect(empty.totalEntries).toBe(0);
  });

  it("names the three sidecar files that make up a namespace", () => {
    const files = namespaceSidecarFiles(FIXTURE_ACCOUNT_ID, 1, paths);
    expect(files.map((f) => f.split("/").pop())).toEqual([
      "cloud-storage-namespace-1.json",
      "cloud-storage-namespace-1.modified.json",
      "cloud-storage-namespaces.json",
    ]);
  });
});

describe("parseConcatenatedJson", () => {
  it("parses a single document", () => {
    expect(parseConcatenatedJson('[["a",1]]')).toEqual([[["a", 1]]]);
  });

  it("parses several documents with no separator", () => {
    // This is the format a minority of librarycache files actually use;
    // JSON.parse throws on it.
    expect(() => JSON.parse("[1][2]")).toThrow();
    expect(parseConcatenatedJson("[1][2][3]")).toEqual([[1], [2], [3]]);
  });

  it("tolerates whitespace between documents", () => {
    expect(parseConcatenatedJson('{"a":1}\n\n {"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("is not confused by braces or brackets inside strings", () => {
    expect(parseConcatenatedJson('{"a":"}{[]"}{"b":2}')).toEqual([{ a: "}{[]" }, { b: 2 }]);
  });

  it("is not confused by escaped quotes inside strings", () => {
    expect(parseConcatenatedJson('{"a":"say \\"}\\""}')).toEqual([{ a: 'say "}"' }]);
  });

  it("drops a truncated trailing document but keeps earlier ones", () => {
    expect(parseConcatenatedJson('{"a":1}{"b":')).toEqual([{ a: 1 }]);
  });

  it("returns an empty array for empty or whitespace input", () => {
    expect(parseConcatenatedJson("")).toEqual([]);
    expect(parseConcatenatedJson("   \n ")).toEqual([]);
  });
});

describe("librarycache", () => {
  it("lists only appid-named files", () => {
    const { appids } = listLibraryCacheAppids(FIXTURE_ACCOUNT_ID, paths);
    // achievement_progress.json is present but is not an app.
    expect(appids).toEqual([620, 212680, 427520].sort((a, b) => a - b));
  });

  it("extracts developers and publishers from strName entries", () => {
    const entry = readLibraryCacheEntry(FIXTURE_ACCOUNT_ID, 427520, paths)!;
    expect(entry.associations?.developers).toEqual(["Wube Software LTD."]);
    expect(entry.associations?.publishers).toEqual(["Wube Software LTD."]);
    expect(entry.associations?.franchises).toEqual([]);
  });

  it("extracts the short description and achievement total", () => {
    const entry = readLibraryCacheEntry(FIXTURE_ACCOUNT_ID, 427520, paths)!;
    expect(entry.shortDescription).toMatch(/building factories/);
    expect(entry.achievementsTotal).toBe(38);
  });

  it("reads a file containing concatenated JSON documents", () => {
    const entry = readLibraryCacheEntry(FIXTURE_ACCOUNT_ID, 212680, paths)!;
    expect(entry.achievementsTotal).toBe(5);
    expect(entry.associations?.developers).toEqual(["Subset Games"]);
  });

  it("drops an empty description rather than reporting an empty string", () => {
    const entry = readLibraryCacheEntry(FIXTURE_ACCOUNT_ID, 620, paths)!;
    expect(entry.shortDescription).toBeUndefined();
  });

  it("returns null for a missing file", () => {
    expect(readLibraryCacheEntry(FIXTURE_ACCOUNT_ID, 111111, paths)).toBeNull();
    expect(listLibraryCacheAppids(FIXTURE_ACCOUNT_ID, missingPaths()).appids).toEqual([]);
  });
});
