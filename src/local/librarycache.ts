import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultPaths, type SteamPaths } from "../paths.js";

/**
 * Reader for userdata/<id>/config/librarycache/<appid>.json.
 *
 * These give us developer/publisher/franchise and store blurbs for free and
 * offline, which is much cheaper than the rate-limited store API.
 *
 * Two format quirks: each file is an [key, record] pair array like the cloud
 * storage files, and a minority of them contain several JSON documents
 * concatenated with no separator — so a plain JSON.parse throws on them.
 */

export interface AppAssociations {
  developers: string[];
  publishers: string[];
  franchises: string[];
}

export interface LibraryCacheEntry {
  appid: number;
  associations?: AppAssociations;
  shortDescription?: string;
  achievementsTotal?: number;
}

/**
 * Parses one or more JSON documents concatenated in a single string.
 * JSON.parse cannot do this, so we walk the string with a scanning parse.
 */
export function parseConcatenatedJson(text: string): unknown[] {
  const docs: unknown[] = [];
  let index = 0;

  while (index < text.length) {
    // Skip whitespace between documents.
    while (index < text.length && /\s/.test(text[index]!)) index++;
    if (index >= text.length) break;

    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === "[" || c === "{") {
        depth++;
      } else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) break; // truncated trailing document

    try {
      docs.push(JSON.parse(text.slice(start, end)));
    } catch {
      // Skip an unparseable document rather than losing the whole file.
    }
    index = end;
  }

  return docs;
}

function collectRecords(docs: unknown[]): Map<string, unknown> {
  const records = new Map<string, unknown>();
  for (const doc of docs) {
    if (!Array.isArray(doc)) continue;
    for (const pair of doc) {
      if (Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === "string") {
        records.set(pair[0], pair[1]);
      }
    }
  }
  return records;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      // Entries look like { strName: "CD PROJEKT RED", strURL: "..." }.
      const record = item as { strName?: unknown; name?: unknown };
      const name = record.strName ?? record.name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

export function readLibraryCacheEntry(
  accountId: string,
  appid: number,
  paths: SteamPaths = defaultPaths(),
): LibraryCacheEntry | null {
  const file = join(paths.librarycache(accountId), `${appid}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const records = collectRecords(parseConcatenatedJson(raw));
  const entry: LibraryCacheEntry = { appid };

  const assoc = records.get("associations") as
    { data?: Record<string, unknown>; [k: string]: unknown } | undefined;
  if (assoc) {
    const data = assoc.data ?? assoc;
    const associations: AppAssociations = {
      developers: stringList(data["rgDevelopers"] ?? data["developers"]),
      publishers: stringList(data["rgPublishers"] ?? data["publishers"]),
      franchises: stringList(data["rgFranchises"] ?? data["franchises"]),
    };
    if (
      associations.developers.length ||
      associations.publishers.length ||
      associations.franchises.length
    ) {
      entry.associations = associations;
    }
  }

  const desc = records.get("descriptions") as
    { data?: Record<string, unknown>; [k: string]: unknown } | undefined;
  if (desc) {
    const data = desc.data ?? desc;
    const short = data["strSnippet"];
    if (typeof short === "string" && short.length > 0) entry.shortDescription = short;
  }

  const achievements = records.get("achievements") as { data?: { nTotal?: unknown } } | undefined;
  const total = achievements?.data?.nTotal;
  if (typeof total === "number") entry.achievementsTotal = total;

  return entry;
}

/** Appids that have a librarycache file, and the newest mtime among them. */
export function listLibraryCacheAppids(
  accountId: string,
  paths: SteamPaths = defaultPaths(),
): {
  appids: number[];
  mtimeMs: number;
} {
  const dir = paths.librarycache(accountId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { appids: [], mtimeMs: 0 };
  }

  const appids: number[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const appid = Number(entry.slice(0, -5));
    if (Number.isInteger(appid)) appids.push(appid);
  }

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    // ignore
  }

  appids.sort((a, b) => a - b);
  return { appids, mtimeMs };
}
