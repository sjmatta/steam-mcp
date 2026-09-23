import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SteamError,
  isSteamError,
  needsConfirmation,
  toErrorPayload,
  writesDisabled,
} from "../../src/errors.js";
import { FIXTURE_ROOT, tempDir } from "../helpers/fixtures.js";

describe("SteamError", () => {
  it("carries a code, hint and arbitrary details into its payload", () => {
    const err = new SteamError("DYNAMIC_COLLECTION", "nope", {
      hint: "use a static one",
      details: { id: "uc-x" },
    });
    expect(err.toPayload()).toEqual({
      ok: false,
      code: "DYNAMIC_COLLECTION",
      error: "nope",
      hint: "use a static one",
      id: "uc-x",
    });
  });

  it("omits an absent hint", () => {
    expect(new SteamError("APP_NOT_FOUND", "x").toPayload()).toEqual({
      ok: false,
      code: "APP_NOT_FOUND",
      error: "x",
    });
  });

  it("is identifiable and is a real Error", () => {
    const err = new SteamError("UNSUPPORTED", "x");
    expect(isSteamError(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(isSteamError(new Error("plain"))).toBe(false);
    expect(isSteamError("string")).toBe(false);
  });
});

describe("toErrorPayload", () => {
  it("passes a SteamError through", () => {
    expect(toErrorPayload(new SteamError("RATE_LIMITED", "slow down"))).toMatchObject({
      code: "RATE_LIMITED",
      error: "slow down",
    });
  });

  it("wraps an unknown error so a tool never returns an empty failure", () => {
    expect(toErrorPayload(new Error("boom"))).toEqual({
      ok: false,
      code: "EVAL_FAILED",
      error: "boom",
    });
    expect(toErrorPayload("just a string")).toMatchObject({ error: "just a string" });
  });
});

describe("error constructors", () => {
  it("explains how to enable writes", () => {
    const err = writesDisabled();
    expect(err.code).toBe("WRITES_DISABLED");
    expect(err.message).toContain("STEAM_MCP_ALLOW_WRITES=1");
  });

  it("tells the caller exactly how to confirm", () => {
    const err = needsConfirmation("This deletes 12 games.", { count: 12 });
    expect(err.code).toBe("NEEDS_CONFIRMATION");
    expect(err.message).toContain("confirm: true");
    expect(err.toPayload()).toMatchObject({ count: 12 });
  });
});

describe("mapPageError", () => {
  /**
   * In-page programs throw terse sentinel strings; the tool layer turns them
   * into codes the model can act on.
   */
  const cases: Array<[string, string, RegExp | undefined]> = [
    ["DYNAMIC_COLLECTION", "DYNAMIC_COLLECTION", /static collection/],
    ["NOT_EDITABLE", "NOT_EDITABLE", undefined],
    ["NAME_COLLISION", "NAME_COLLISION", /collection id/],
    ["COLLECTION_NOT_FOUND", "COLLECTION_NOT_FOUND", /steam_collections_list/],
    ["APP_NOT_FOUND", "APP_NOT_FOUND", undefined],
    ["STORES_NOT_READY", "STORES_NOT_READY", /Wait a few seconds/],
    ["UNSUPPORTED", "UNSUPPORTED", undefined],
    ["INVALID_NAME", "UNSUPPORTED", undefined],
  ];

  it.each(cases)("maps %s to code %s", async (thrown, code, hint) => {
    const { mapPageError } = await import("../../src/tools/shared.js");
    try {
      mapPageError(new Error(thrown), { ref: "uc-x" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isSteamError(e)).toBe(true);
      const err = e as SteamError;
      expect(err.code).toBe(code);
      expect(err.details).toMatchObject({ ref: "uc-x" });
      if (hint) expect(err.hint).toMatch(hint);
    }
  });

  it("recognises a sentinel embedded in a longer message", async () => {
    const { mapPageError } = await import("../../src/tools/shared.js");
    expect(() =>
      mapPageError(new Error('Steam threw while running "op": DYNAMIC_COLLECTION')),
    ).toThrow(/dynamic \(filter-based\)/);
  });

  it("rethrows anything it does not recognise, unchanged", async () => {
    const { mapPageError } = await import("../../src/tools/shared.js");
    const original = new Error("something else entirely");
    expect(() => mapPageError(original)).toThrow(original);
  });
});

describe("backupCollections", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("STEAM_ROOT", FIXTURE_ROOT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (cleanups.length) cleanups.pop()!();
  });

  it("copies the three cloud-storage files before a write", async () => {
    const { dir, cleanup } = tempDir("steam-mcp-backup-");
    cleanups.push(cleanup);
    vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
    vi.resetModules();

    const { backupCollections } = await import("../../src/tools/shared.js");
    const path = backupCollections("test");

    expect(path).toBeTruthy();
    const files = readdirSync(path!).sort();
    expect(files).toEqual([
      "cloud-storage-namespace-1.json",
      "cloud-storage-namespace-1.modified.json",
      "cloud-storage-namespaces.json",
    ]);
    expect(existsSync(join(dir, "backups"))).toBe(true);
  });

  it("only backs up once per session unless forced", async () => {
    const { dir, cleanup } = tempDir("steam-mcp-backup2-");
    cleanups.push(cleanup);
    vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
    vi.resetModules();

    const { backupCollections } = await import("../../src/tools/shared.js");
    expect(backupCollections("first")).toBeTruthy();
    expect(backupCollections("second")).toBeNull();
    // Destructive operations force a fresh snapshot regardless.
    expect(backupCollections("delete", true)).toBeTruthy();
  });

  it("returns null when there is nothing to back up", async () => {
    const { dir, cleanup } = tempDir("steam-mcp-backup3-");
    cleanups.push(cleanup);
    vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
    vi.stubEnv("STEAM_ACCOUNT_ID", "0000");
    vi.resetModules();

    const { backupCollections } = await import("../../src/tools/shared.js");
    expect(backupCollections("nothing")).toBeNull();
  });
});
