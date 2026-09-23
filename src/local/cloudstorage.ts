import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, type SteamPaths } from "../paths.js";

/**
 * Read-only reader for Steam's cloud-storage namespace 1, which is where the
 * modern client keeps library collections. The file is an Array.from(Map) dump:
 * a JSON array of [key, entry] pairs.
 *
 * We deliberately never write these files. Removal is expressed by membership in
 * the inner `removed[]` array rather than absence from `added[]`, and entries
 * carry `strMethodId: "union-collections"` — the server unions our copy with its
 * own on sync, so a naive local edit is silently undone. Combined with the
 * two-level version counters (namespace high-water mark vs per-entry revision)
 * and the .modified.json upload queue, a mistake here is a cloud-propagated data
 * loss event. Writes go through the live client instead; see cdp/programs.
 */

/** Namespace 1 holds user collections. */
const COLLECTIONS_NAMESPACE = 1;
const COLLECTION_KEY_PREFIX = "user-collections.";

interface RawEntry {
  key?: string;
  timestamp?: number;
  value?: string;
  version?: string;
  is_deleted?: boolean;
  conflictResolutionMethod?: string;
  strMethodId?: string;
}

/** A filter-based ("dynamic"/smart) collection's recomputation spec. */
export interface FilterSpec {
  nFormatVersion?: number;
  strSearchText?: string;
  filterGroups?: Array<{ rgOptions?: number[]; bAcceptUnion?: boolean }>;
}

export interface OfflineCollection {
  /** Opaque. Contains `+` and `*` for user collections — never normalize it. */
  id: string;
  name: string;
  /** Explicitly added appids. For dynamic collections this is usually empty. */
  added: number[];
  /** Explicitly excluded appids. Meaningful even when `added` is empty. */
  removed: number[];
  /** Present only on dynamic collections. */
  filterSpec?: FilterSpec;
  isDynamic: boolean;
  isSystem: boolean;
  timestamp: number;
  version: string;
}

export interface OfflineCollections {
  collections: OfflineCollection[];
  /** Keys present but tombstoned. Useful for diagnostics only. */
  tombstoneCount: number;
  totalEntries: number;
  mtimeMs: number;
  file: string;
}

/** Collections Steam creates and manages itself. */
const SYSTEM_IDS = new Set([
  "favorite",
  "hidden",
  "uncategorized",
  "local-install",
  "my-games",
  "play-next",
]);

export function isSystemCollectionId(id: string): boolean {
  return SYSTEM_IDS.has(id) || id.startsWith("type-");
}

function namespaceFile(
  accountId: string,
  ns = COLLECTIONS_NAMESPACE,
  paths: SteamPaths = defaultPaths(),
): string {
  return join(paths.cloudStorage(accountId), `cloud-storage-namespace-${ns}.json`);
}

export function namespaceSidecarFiles(
  accountId: string,
  ns = COLLECTIONS_NAMESPACE,
  paths: SteamPaths = defaultPaths(),
): string[] {
  const dir = paths.cloudStorage(accountId);
  return [
    join(dir, `cloud-storage-namespace-${ns}.json`),
    join(dir, `cloud-storage-namespace-${ns}.modified.json`),
    join(dir, "cloud-storage-namespaces.json"),
  ];
}

/**
 * Reads the collections Steam last flushed to disk. This lags the running
 * client, so it is only used when the live client is unavailable.
 */
export function readOfflineCollections(
  accountId: string,
  paths: SteamPaths = defaultPaths(),
): OfflineCollections {
  const file = namespaceFile(accountId, COLLECTIONS_NAMESPACE, paths);
  const empty: OfflineCollections = {
    collections: [],
    tombstoneCount: 0,
    totalEntries: 0,
    mtimeMs: 0,
    file,
  };

  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return empty;
  }

  let pairs: unknown;
  try {
    pairs = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!Array.isArray(pairs)) return empty;

  const collections: OfflineCollection[] = [];
  let tombstoneCount = 0;

  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key: unknown = pair[0];
    const entry = pair[1] as RawEntry;
    if (typeof key !== "string" || !key.startsWith(COLLECTION_KEY_PREFIX)) continue;

    if (entry?.is_deleted || typeof entry?.value !== "string") {
      tombstoneCount++;
      continue;
    }

    let inner: {
      id?: string;
      name?: string;
      added?: unknown;
      removed?: unknown;
      filterSpec?: FilterSpec;
    };
    try {
      inner = JSON.parse(entry.value) as typeof inner;
    } catch {
      continue;
    }

    // Prefer the id inside the value; fall back to the key suffix.
    const id = typeof inner.id === "string" ? inner.id : key.slice(COLLECTION_KEY_PREFIX.length);
    const numbers = (v: unknown): number[] =>
      Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

    const filterSpec = inner.filterSpec;
    collections.push({
      id,
      name: typeof inner.name === "string" ? inner.name : id,
      added: numbers(inner.added),
      removed: numbers(inner.removed),
      ...(filterSpec ? { filterSpec } : {}),
      isDynamic: filterSpec !== undefined,
      isSystem: isSystemCollectionId(id),
      timestamp: entry.timestamp ?? 0,
      version: entry.version ?? "",
    });
  }

  collections.sort((a, b) => a.name.localeCompare(b.name));

  return {
    collections,
    tombstoneCount,
    totalEntries: pairs.length,
    mtimeMs,
    file,
  };
}
