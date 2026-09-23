import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cacheDirPath } from "./config.js";

/**
 * Small on-disk cache. Everything lives under a single directory; we never
 * write inside the Steam install.
 *
 * Writes are temp-file-plus-rename so a crash mid-write cannot leave a
 * half-written JSON document that poisons every later read.
 */

export interface Envelope<T> {
  fetchedAt: number;
  value: T;
}

export interface Cache {
  readonly dir: string;
  read<T>(namespace: string, key?: string): Envelope<T> | null;
  get<T>(namespace: string, ttlMs: number, key?: string): T | null;
  set<T>(namespace: string, value: T, key?: string): void;
  age(namespace: string, key?: string): number | null;
  count(namespace?: string): number;
  clear(namespace?: string): number;
}

/** Never removed by a cache clear: these are recovery artifacts, not cache. */
const PROTECTED_ENTRIES = new Set(["backups"]);

// The clock is resolved lazily (not `= Date.now`) so a caller - or a test -
// can replace the global clock after the cache is constructed.
export function createCache(dir: string, now: () => number = () => Date.now()): Cache {
  const pathFor = (namespace: string, key?: string): string =>
    key === undefined ? join(dir, `${namespace}.json`) : join(dir, namespace, `${key}.json`);

  const walkCount = (target: string, isRoot: boolean): number => {
    let count = 0;
    try {
      if (!existsSync(target)) return 0;
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (isRoot && PROTECTED_ENTRIES.has(entry.name)) continue;
        const full = join(target, entry.name);
        if (entry.isDirectory()) count += walkCount(full, false);
        else if (entry.name.endsWith(".json")) count++;
      }
    } catch {
      return count;
    }
    return count;
  };

  return {
    dir,

    read<T>(namespace: string, key?: string): Envelope<T> | null {
      try {
        const parsed = JSON.parse(readFileSync(pathFor(namespace, key), "utf8")) as Envelope<T>;
        // A truncated or foreign file can parse but not be an envelope.
        if (!parsed || typeof parsed.fetchedAt !== "number") return null;
        return parsed;
      } catch {
        return null;
      }
    },

    get<T>(namespace: string, ttlMs: number, key?: string): T | null {
      const env = this.read<T>(namespace, key);
      if (!env) return null;
      if (now() - env.fetchedAt > ttlMs) return null;
      return env.value;
    },

    set<T>(namespace: string, value: T, key?: string): void {
      const file = pathFor(namespace, key);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ fetchedAt: now(), value } satisfies Envelope<T>), "utf8");
      renameSync(tmp, file);
    },

    age(namespace: string, key?: string): number | null {
      const env = this.read<unknown>(namespace, key);
      return env ? now() - env.fetchedAt : null;
    },

    count(namespace?: string): number {
      return walkCount(namespace ? join(dir, namespace) : dir, !namespace);
    },

    clear(namespace?: string): number {
      const removed = this.count(namespace);
      try {
        if (namespace) {
          rmSync(join(dir, namespace), { recursive: true, force: true });
        } else if (existsSync(dir)) {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (PROTECTED_ENTRIES.has(entry.name)) continue;
            rmSync(join(dir, entry.name), { recursive: true, force: true });
          }
        }
      } catch {
        // Nothing cached, or not removable; treat as a no-op.
      }
      return removed;
    },
  };
}

let instance: Cache | null = null;
let instanceDir: string | null = null;

/** Process-wide cache, rebuilt if STEAM_MCP_CACHE_DIR changes. */
export function cache(): Cache {
  const dir = cacheDirPath();
  if (!instance || instanceDir !== dir) {
    instance = createCache(dir);
    instanceDir = dir;
  }
  return instance;
}

/**
 * Serialises calls and enforces a minimum gap between them.
 *
 * The Steam store API tolerates roughly 200 requests per 5 minutes per IP, so
 * a shared limiter is the difference between "enrichment is slow" and "our IP
 * is blocked for five minutes".
 */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  // Negative infinity, not 0: the first call must never wait. With a real clock
  // 0 happens to work because Date.now() is enormous, but it makes the gap
  // depend on the clock's epoch, which is wrong and untestable.
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain
      .catch(() => undefined)
      .then(async () => {
        const remaining = this.minGapMs - (this.now() - this.lastAt);
        if (remaining > 0) await this.wait(remaining);
        try {
          return await task();
        } finally {
          this.lastAt = this.now();
        }
      });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
