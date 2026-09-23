import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCache, RateLimiter } from "../../src/cache.js";
import { tempDir } from "../helpers/fixtures.js";

const dirs: Array<() => void> = [];
afterEach(() => {
  while (dirs.length) dirs.pop()!();
});

function freshCache(now: () => number = Date.now) {
  const { dir, cleanup } = tempDir();
  dirs.push(cleanup);
  return { cache: createCache(dir, now), dir };
}

describe("cache", () => {
  it("round-trips a value", () => {
    const { cache } = freshCache();
    cache.set("library", { games: 3 });
    expect(cache.get<{ games: number }>("library", 60_000)).toEqual({ games: 3 });
  });

  it("scopes values by key within a namespace", () => {
    const { cache } = freshCache();
    cache.set("app-names", "Factorio", "427520");
    cache.set("app-names", "Portal", "620");
    expect(cache.get("app-names", 60_000, "427520")).toBe("Factorio");
    expect(cache.get("app-names", 60_000, "620")).toBe("Portal");
  });

  it("returns null for a missing entry", () => {
    const { cache } = freshCache();
    expect(cache.get("nothing", 60_000)).toBeNull();
    expect(cache.age("nothing")).toBeNull();
  });

  it("expires an entry once the TTL has passed", () => {
    let now = 1_000_000;
    const { cache } = freshCache(() => now);
    cache.set("library", "value");
    now += 5_000;
    expect(cache.get("library", 10_000)).toBe("value");
    now += 6_000;
    expect(cache.get("library", 10_000)).toBeNull();
    // The entry is still readable when a longer TTL is acceptable.
    expect(cache.get("library", 60_000)).toBe("value");
  });

  it("reports age from the stored timestamp", () => {
    let now = 1_000_000;
    const { cache } = freshCache(() => now);
    cache.set("library", 1);
    now += 4_200;
    expect(cache.age("library")).toBe(4_200);
  });

  it("survives a corrupt or foreign file instead of throwing", () => {
    const { cache, dir } = freshCache();
    writeFileSync(join(dir, "library.json"), "{not json", "utf8");
    expect(cache.get("library", 60_000)).toBeNull();
    // A valid JSON document that is not an envelope is also rejected.
    writeFileSync(join(dir, "library.json"), '{"value":1}', "utf8");
    expect(cache.get("library", 60_000)).toBeNull();
  });

  it("leaves no temp files behind after a write", () => {
    const { cache, dir } = freshCache();
    cache.set("library", { a: 1 });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("counts json files, ignoring backups at the root", () => {
    const { cache, dir } = freshCache();
    cache.set("library", 1);
    cache.set("app-names", "x", "1");
    cache.set("app-names", "y", "2");
    mkdirSync(join(dir, "backups", "2026-01-01"), { recursive: true });
    writeFileSync(join(dir, "backups", "2026-01-01", "collections.json"), "[]", "utf8");

    expect(cache.count()).toBe(3); // backups excluded
    expect(cache.count("app-names")).toBe(2);
  });

  it("clears a single namespace and leaves others intact", () => {
    const { cache } = freshCache();
    cache.set("library", 1);
    cache.set("app-names", "x", "1");
    expect(cache.clear("app-names")).toBe(1);
    expect(cache.get("app-names", 60_000, "1")).toBeNull();
    expect(cache.get("library", 60_000)).toBe(1);
  });

  it("never deletes backups when clearing everything", () => {
    const { cache, dir } = freshCache();
    cache.set("library", 1);
    const backup = join(dir, "backups", "run-1");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "collections.json"), "[]", "utf8");

    cache.clear();
    expect(cache.get("library", 60_000)).toBeNull();
    expect(existsSync(join(backup, "collections.json"))).toBe(true);
  });

  it("clearing an empty cache is a no-op", () => {
    const { cache } = freshCache();
    expect(cache.clear()).toBe(0);
    expect(cache.clear("missing-namespace")).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("runs tasks one at a time", async () => {
    const limiter = new RateLimiter(0);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([limiter.run(task), limiter.run(task), limiter.run(task)]);
    expect(peak).toBe(1);
  });

  it("preserves submission order", async () => {
    const limiter = new RateLimiter(0);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it("waits the configured gap between calls", async () => {
    // A virtual clock keeps this deterministic and instant.
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      1600,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );

    await limiter.run(async () => "a");
    await limiter.run(async () => "b");
    await limiter.run(async () => "c");

    // First call is immediate; each subsequent call waits the full gap.
    expect(waits).toEqual([1600, 1600]);
  });

  it("does not wait when the gap has already elapsed", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      1000,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await limiter.run(async () => "a");
    now += 5000;
    await limiter.run(async () => "b");
    expect(waits).toEqual([]);
  });

  it("keeps running after a task rejects", async () => {
    const limiter = new RateLimiter(0);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(limiter.run(async () => "still works")).resolves.toBe("still works");
  });

  it("propagates the task's resolved value", async () => {
    const limiter = new RateLimiter(0);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
  });
});
