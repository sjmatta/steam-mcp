import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { defaultPaths, type SteamPaths } from "./paths.js";

/**
 * Runtime configuration.
 *
 * Everything here is read through a function rather than captured in a
 * module-level constant: constants freeze the environment at import time, which
 * makes the values untestable and surprising when a process changes env late.
 */

/** SteamID64 = 32-bit account id + this offset. */
const STEAMID64_BASE = 76561197960265728n;

export interface SteamAccount {
  /** 32-bit account id, i.e. the `userdata/<id>` directory name. */
  accountId: string;
  steamId64: string;
  accountName: string;
  personaName: string;
  /** Login timestamp, used to pick the most recent account when several exist. */
  timestamp: number;
}

export function steamId64From(accountId: string): string {
  return (BigInt(accountId) + STEAMID64_BASE).toString();
}

export function accountIdFrom(steamId64: string): string {
  return (BigInt(steamId64) - STEAMID64_BASE).toString();
}

/**
 * Determines which Steam account to use.
 *
 * loginusers.vdf lists every account that has signed in on this machine; we
 * take the most recently used one that actually has a userdata directory, since
 * that is the only account whose local files we can read.
 */
export function detectAccount(paths: SteamPaths = defaultPaths()): SteamAccount | null {
  const envId = process.env.STEAM_ACCOUNT_ID?.trim();
  if (envId) {
    return {
      accountId: envId,
      steamId64: steamId64From(envId),
      accountName: "",
      personaName: "",
      timestamp: 0,
    };
  }

  let text: string;
  try {
    text = readFileSync(paths.loginusers, "utf8");
  } catch {
    return null;
  }

  const candidates: SteamAccount[] = [];
  const blockRe = /"(\d{17})"\s*\{([\s\S]*?)\n\}/g;
  for (const match of text.matchAll(blockRe)) {
    const steamId64 = match[1]!;
    const body = match[2] ?? "";
    const field = (name: string): string => {
      const m = new RegExp(`"${name}"\\s+"([^"]*)"`, "i").exec(body);
      return m?.[1] ?? "";
    };
    candidates.push({
      accountId: accountIdFrom(steamId64),
      steamId64,
      accountName: field("AccountName"),
      personaName: field("PersonaName"),
      timestamp: Number(field("Timestamp") || 0),
    });
  }

  const withUserdata = candidates.filter((c) => existsSync(paths.userdata(c.accountId)));
  const pool = withUserdata.length > 0 ? withUserdata : candidates;
  pool.sort((a, b) => b.timestamp - a.timestamp);
  return pool[0] ?? null;
}

/**
 * Ports probed for Steam's CEF debugger, in order. Steam defaults to 8080 and
 * accepts `-devtools-port <n>`; STEAM_DEBUG_PORT overrides the list entirely.
 */
export function debugPortCandidates(): number[] {
  const override = process.env.STEAM_DEBUG_PORT;
  if (override) {
    const ports = override
      .split(",")
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    if (ports.length > 0) return ports;
  }
  return [8080, 8081];
}

/** The port `steam_restart` asks Steam to bind. */
export function preferredDebugPort(): number {
  return debugPortCandidates()[0] ?? 8080;
}

export function steamApiKey(): string | null {
  return process.env.STEAM_API_KEY?.trim() || null;
}

/** All mutating tools fail closed unless this is explicitly enabled. */
export function allowWrites(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.STEAM_MCP_ALLOW_WRITES?.trim() ?? "");
}

export function cacheDirPath(): string {
  return process.env.STEAM_MCP_CACHE_DIR?.trim() || join(homedir(), ".cache", "steam-mcp");
}

export function backupDirPath(): string {
  return join(cacheDirPath(), "backups");
}
