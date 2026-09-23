import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_ROOT, tempDir } from "../helpers/fixtures.js";
import { FakeSteam, defaultFakeSteam } from "../helpers/fake-steam.js";
import { stubFetch } from "../helpers/http.js";

const cleanups: Array<() => void> = [];
let steam: FakeSteam;

beforeEach(() => {
  const { dir, cleanup } = tempDir("steam-mcp-model-");
  cleanups.push(cleanup);
  vi.stubEnv("STEAM_ROOT", FIXTURE_ROOT);
  vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
  vi.stubEnv("STEAM_API_KEY", "");
  steam = defaultFakeSteam();
  steam.install();
  vi.resetModules();
});

afterEach(() => {
  FakeSteam.uninstall();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

/** Makes evalInPage run the page program directly, as the transport would. */
async function withLiveSteam(): Promise<void> {
  const { cdp } = await import("../../src/cdp/client.js");
  vi.spyOn(cdp, "evalInPage").mockImplementation(async (fn: any, arg: any) => fn(arg));
}

/** Makes every CDP call fail, as if Steam were closed. */
async function withSteamClosed(code = "STEAM_NOT_RUNNING"): Promise<void> {
  const { cdp } = await import("../../src/cdp/client.js");
  const { SteamError } = await import("../../src/errors.js");
  vi.spyOn(cdp, "evalInPage").mockImplementation(async () => {
    throw new SteamError(code as never, "Steam is not running.");
  });
}

describe("account detection", () => {
  it("picks the most recently used account with a userdata directory", async () => {
    const { detectAccount } = await import("../../src/config.js");
    const account = detectAccount();
    expect(account).toMatchObject({ accountId: "12345678", accountName: "testuser" });
  });

  it("derives steamid64 from the account id", async () => {
    const { detectAccount, steamId64From, accountIdFrom } = await import("../../src/config.js");
    expect(detectAccount()!.steamId64).toBe("76561197972611406");
    expect(steamId64From("12345678")).toBe("76561197972611406");
    expect(accountIdFrom("76561197972611406")).toBe("12345678");
  });

  it("honours an explicit override", async () => {
    vi.stubEnv("STEAM_ACCOUNT_ID", "999");
    vi.resetModules();
    const { detectAccount } = await import("../../src/config.js");
    expect(detectAccount()).toMatchObject({ accountId: "999" });
  });

  it("returns null when loginusers.vdf is unreadable", async () => {
    vi.stubEnv("STEAM_ROOT", "/nonexistent/steam");
    vi.resetModules();
    const { detectAccount } = await import("../../src/config.js");
    expect(detectAccount()).toBeNull();
  });

  it("raises an actionable error when no account can be found", async () => {
    vi.stubEnv("STEAM_ROOT", "/nonexistent/steam");
    vi.resetModules();
    const { account } = await import("../../src/model.js");
    expect(() => account()).toThrow(/STEAM_ACCOUNT_ID|loginusers/);
  });
});

describe("loadLibrary", () => {
  it("uses the live client when it is available", async () => {
    await withLiveSteam();
    const { loadLibrary } = await import("../../src/model.js");

    const view = await loadLibrary();
    expect(view.source).toBe("live");
    expect(view.degraded).toBe(false);
    expect(view.games.length).toBe(5);
    expect(view.games.find((g) => g.appid === 427520)!.tags).toContain("Strategy");
  });

  it("reuses a fresh cached snapshot rather than re-reading the client", async () => {
    await withLiveSteam();
    const { cdp } = await import("../../src/cdp/client.js");
    const { loadLibrary } = await import("../../src/model.js");

    await loadLibrary();
    const callsAfterFirst = (cdp.evalInPage as any).mock.calls.length;
    await loadLibrary();
    expect((cdp.evalInPage as any).mock.calls.length).toBe(callsAfterFirst);

    await loadLibrary({ force: true });
    expect((cdp.evalInPage as any).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("falls back to local files when Steam is closed", async () => {
    await withSteamClosed();
    const { loadLibrary } = await import("../../src/model.js");

    const view = await loadLibrary();
    expect(view.source).toBe("local");
    expect(view.degraded).toBe(true);
    // Installed games from the fixture manifests plus played games from localconfig.
    expect(view.games.map((g) => g.appid).sort((a, b) => a - b)).toEqual([212680, 427520, 3219010]);
  });

  it("serves a stale live snapshot in preference to a degraded rebuild", async () => {
    await withLiveSteam();
    const { loadLibrary } = await import("../../src/model.js");
    const fresh = await loadLibrary();
    expect(fresh.source).toBe("live");

    // Steam goes away; the cached snapshot is older than the live TTL.
    vi.restoreAllMocks();
    await withSteamClosed();
    // shouldAdvanceTime keeps real async work (promises, I/O) progressing while
    // the clock is moved past the snapshot's freshness window.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000));
    const stale = await loadLibrary();
    vi.useRealTimers();

    expect(stale.source).toBe("live");
    expect(stale.degraded).toBe(true); // flagged, not silently presented as current
  });

  it("uses the Web API for the owned set when a key is configured", async () => {
    vi.stubEnv("STEAM_API_KEY", "TESTKEY");
    vi.resetModules();
    stubFetch((url) =>
      url.includes("GetOwnedGames")
        ? {
            body: {
              response: {
                games: [
                  { appid: 999999, name: "Owned But Not Installed", playtime_forever: 42 },
                  { appid: 427520, name: "Factorio", playtime_forever: 100 },
                ],
              },
            },
          }
        : { throws: true },
    );
    await withSteamClosed();
    const { loadLibrary } = await import("../../src/model.js");

    const view = await loadLibrary();
    expect(view.source).toBe("webapi");
    expect(view.games.find((g) => g.appid === 999999)).toMatchObject({
      name: "Owned But Not Installed",
      playtimeMinutes: 42,
      installed: false,
    });
    // Local manifests still win for install state.
    expect(view.games.find((g) => g.appid === 427520)!.installed).toBe(true);
  });

  it("degrades to local files when the Web API fails", async () => {
    vi.stubEnv("STEAM_API_KEY", "TESTKEY");
    vi.resetModules();
    stubFetch(() => ({ throws: true }));
    await withSteamClosed();
    const { loadLibrary } = await import("../../src/model.js");

    const view = await loadLibrary();
    expect(view.source).toBe("local");
    expect(view.games.length).toBeGreaterThan(0);
  });
});

describe("loadCollections", () => {
  it("reads from the live client and preloads system membership", async () => {
    await withLiveSteam();
    const { loadCollections } = await import("../../src/model.js");

    const view = await loadCollections();
    expect(view.source).toBe("live");
    expect(view.degraded).toBe(false);
    expect(view.collections.some((c) => c.id === "uc-static")).toBe(true);
    expect(view.members).toHaveProperty("favorite");
    expect(view.members).toHaveProperty("hidden");
  });

  it("falls back to the flushed cloud-storage file when Steam is closed", async () => {
    await withSteamClosed();
    const { loadCollections } = await import("../../src/model.js");

    const view = await loadCollections();
    expect(view.source).toBe("local");
    expect(view.degraded).toBe(true);
    expect(view.collections.map((c) => c.id)).toContain("uc-Aj+bldZKtzMv");
  });

  it("marks offline dynamic and system collections as uneditable", async () => {
    await withSteamClosed();
    const { loadCollections } = await import("../../src/model.js");

    const view = await loadCollections();
    expect(view.collections.find((c) => c.id === "uc-B2ZzHzFyWFUr")!.isEditable).toBe(false);
    expect(view.collections.find((c) => c.id === "favorite")!.isEditable).toBe(false);
    expect(view.collections.find((c) => c.id === "uc-Aj+bldZKtzMv")!.isEditable).toBe(true);
  });

  it("exposes membership for every offline collection", async () => {
    await withSteamClosed();
    const { loadCollections } = await import("../../src/model.js");
    const view = await loadCollections();
    expect(view.members["favorite"]).toEqual([427520, 212680]);
  });
});
