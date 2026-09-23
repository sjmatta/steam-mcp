import { readFileSync, statSync } from "node:fs";
import { defaultPaths, type SteamPaths } from "../paths.js";
import { parseVdf, vdfGetObject, vdfGetString, type VdfObject } from "./vdf.js";

export interface LocalPlaytime {
  appid: number;
  /** Lifetime minutes. Steam stores this as `Playtime`, not `playtime_forever`. */
  playtimeMinutes: number;
  /** Minutes in the last two weeks; present for only a handful of apps. */
  playtime2Weeks: number;
  /** Epoch seconds; 0 means never played. */
  lastPlayed: number;
}

export interface LocalConfigData {
  playtime: Map<number, LocalPlaytime>;
  /** Store tag id -> localized name, from LocalizedTagNames2_english. */
  tagNames: Map<number, string>;
  /** Appids the user marked private. */
  privateApps: number[];
  mtimeMs: number;
}

const EMPTY: LocalConfigData = {
  playtime: new Map(),
  tagNames: new Map(),
  privateApps: [],
  mtimeMs: 0,
};

function num(obj: VdfObject, key: string): number {
  const v = vdfGetString(obj, key);
  if (v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses localconfig.vdf.
 *
 * Note there are two distinct `apps` keys in this file under different parents:
 * `UserLocalConfigStore/Software/Valve/Steam/apps` (the 493 playtime records) and
 * `UserLocalConfigStore/WebStorage/apps` (launch options only). We anchor on the
 * full path, so the WebStorage one can never be picked up by accident.
 */
export function readLocalConfig(
  accountId: string,
  paths: SteamPaths = defaultPaths(),
): LocalConfigData {
  const file = paths.localconfig(accountId);

  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { ...EMPTY, playtime: new Map(), tagNames: new Map() };
  }

  const root = parseVdf(raw);

  const playtime = new Map<number, LocalPlaytime>();
  const apps = vdfGetObject(root, "UserLocalConfigStore", "Software", "Valve", "Steam", "apps");
  if (apps) {
    for (const [key, value] of Object.entries(apps)) {
      const appid = Number(key);
      if (!Number.isInteger(appid) || typeof value !== "object") continue;
      const entry = value;
      playtime.set(appid, {
        appid,
        playtimeMinutes: num(entry, "Playtime"),
        playtime2Weeks: num(entry, "Playtime2wks"),
        lastPlayed: num(entry, "LastPlayed"),
      });
    }
  }

  const webStorage = vdfGetObject(root, "UserLocalConfigStore", "WebStorage");

  const tagNames = new Map<number, string>();
  const tagBlob = webStorage ? vdfGetString(webStorage, "LocalizedTagNames2_english") : undefined;
  if (tagBlob) {
    try {
      const parsed = JSON.parse(tagBlob) as { tags?: Array<{ tagid?: number; name?: string }> };
      for (const tag of parsed.tags ?? []) {
        if (typeof tag.tagid === "number" && typeof tag.name === "string") {
          tagNames.set(tag.tagid, tag.name);
        }
      }
    } catch {
      // Malformed blob: tags simply stay unresolved.
    }
  }

  const privateApps: number[] = [];
  if (webStorage) {
    // Key is PrivateApps_<accountId>.
    for (const [key, value] of Object.entries(webStorage)) {
      if (!key.startsWith("PrivateApps_") || typeof value !== "string") continue;
      try {
        const ids = JSON.parse(value) as unknown;
        if (Array.isArray(ids)) {
          for (const id of ids) if (typeof id === "number") privateApps.push(id);
        }
      } catch {
        // ignore
      }
    }
  }

  return { playtime, tagNames, privateApps, mtimeMs };
}
