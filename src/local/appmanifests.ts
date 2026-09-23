import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, type SteamPaths } from "../paths.js";
import { parseVdf, vdfGetObject, vdfGetString } from "./vdf.js";

/** Bit 4 of StateFlags means "fully installed". */
const STATE_FULLY_INSTALLED = 4;

export interface InstalledApp {
  appid: number;
  name: string;
  installDir: string;
  /** Bytes. Authoritative — libraryfolders.vdf carries a slightly stale copy. */
  sizeOnDisk: number;
  lastUpdated: number;
  /** Epoch seconds. Unreliable in .acf (often 0); localconfig.vdf is the real source. */
  lastPlayed: number;
  stateFlags: number;
  fullyInstalled: boolean;
  buildId: string;
  libraryPath: string;
}

/**
 * Steam can spread games over several drives. Each root has its own
 * steamapps/ directory with its own appmanifest files.
 */
export function libraryFolders(paths: SteamPaths = defaultPaths()): string[] {
  const roots = new Set<string>([paths.steamapps]);
  try {
    const parsed = parseVdf(readFileSync(paths.libraryfolders, "utf8"));
    const folders = vdfGetObject(parsed, "libraryfolders");
    if (folders) {
      for (const key of Object.keys(folders)) {
        const path = vdfGetString(folders, key, "path");
        if (path) roots.add(join(path, "steamapps"));
      }
    }
  } catch {
    // Missing or malformed libraryfolders.vdf just means "only the default root".
  }
  return [...roots];
}

/** Parses one appmanifest_*.acf. Returns null if it is unreadable or malformed. */
export function parseAppManifest(text: string, libraryPath = ""): InstalledApp | null {
  const state = vdfGetObject(parseVdf(text), "AppState");
  if (!state) return null;

  const appid = Number(vdfGetString(state, "appid") ?? NaN);
  if (!Number.isInteger(appid)) return null;

  const stateFlags = Number(vdfGetString(state, "StateFlags") ?? 0) || 0;

  return {
    appid,
    name: vdfGetString(state, "name") ?? `App ${appid}`,
    installDir: vdfGetString(state, "installdir") ?? "",
    sizeOnDisk: Number(vdfGetString(state, "SizeOnDisk") ?? 0) || 0,
    lastUpdated: Number(vdfGetString(state, "LastUpdated") ?? 0) || 0,
    lastPlayed: Number(vdfGetString(state, "LastPlayed") ?? 0) || 0,
    stateFlags,
    fullyInstalled: (stateFlags & STATE_FULLY_INSTALLED) !== 0,
    buildId: vdfGetString(state, "buildid") ?? "",
    libraryPath,
  };
}

/** Reads every appmanifest_*.acf across all library folders. */
export function readInstalledApps(paths: SteamPaths = defaultPaths()): InstalledApp[] {
  const apps: InstalledApp[] = [];
  const seen = new Set<number>();

  for (const dir of libraryFolders(paths)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith("appmanifest_") || !entry.endsWith(".acf")) continue;
      let text: string;
      try {
        text = readFileSync(join(dir, entry), "utf8");
      } catch {
        continue;
      }
      const app = parseAppManifest(text, dir);
      if (app && !seen.has(app.appid)) {
        seen.add(app.appid);
        apps.push(app);
      }
    }
  }

  apps.sort((a, b) => a.appid - b.appid);
  return apps;
}
