import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every filesystem location the server reads, derived from a single root.
 *
 * This exists so the local readers can be pointed at a fixture tree in tests
 * instead of the user's real Steam install. Production code uses
 * `defaultPaths()`, which resolves the root from STEAM_ROOT or the standard
 * macOS location.
 */
export interface SteamPaths {
  root: string;
  steamapps: string;
  config: string;
  appcache: string;
  loginusers: string;
  libraryfolders: string;
  cefDebugMarker: string;
  userdata(accountId: string): string;
  userConfig(accountId: string): string;
  localconfig(accountId: string): string;
  cloudStorage(accountId: string): string;
  librarycache(accountId: string): string;
}

export function makeSteamPaths(root: string): SteamPaths {
  const config = join(root, "config");
  return {
    root,
    config,
    steamapps: join(root, "steamapps"),
    appcache: join(root, "appcache"),
    loginusers: join(config, "loginusers.vdf"),
    libraryfolders: join(config, "libraryfolders.vdf"),
    cefDebugMarker: join(root, ".cef-enable-remote-debugging"),
    userdata: (accountId) => join(root, "userdata", accountId),
    userConfig: (accountId) => join(root, "userdata", accountId, "config"),
    localconfig: (accountId) => join(root, "userdata", accountId, "config", "localconfig.vdf"),
    cloudStorage: (accountId) => join(root, "userdata", accountId, "config", "cloudstorage"),
    librarycache: (accountId) => join(root, "userdata", accountId, "config", "librarycache"),
  };
}

/** Standard Steam data directory on macOS. */
function defaultSteamRoot(): string {
  return (
    process.env.STEAM_ROOT?.trim() || join(homedir(), "Library", "Application Support", "Steam")
  );
}

let cached: SteamPaths | null = null;
let cachedRoot: string | null = null;

/** Paths for the real install. Recomputed if STEAM_ROOT changes. */
export function defaultPaths(): SteamPaths {
  const root = defaultSteamRoot();
  if (!cached || cachedRoot !== root) {
    cached = makeSteamPaths(root);
    cachedRoot = root;
  }
  return cached;
}
