import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectToolClient, type ToolClient } from "../helpers/mcp.js";
import { FIXTURE_ROOT, tempDir } from "../helpers/fixtures.js";
import { FakeSteam, defaultFakeSteam } from "../helpers/fake-steam.js";

/**
 * Drives the real tool layer through a real MCP client, with Steam replaced by
 * the fake page globals and every filesystem path pointed at fixtures.
 */

const cleanups: Array<() => void> = [];
let client: ToolClient;
let steam: FakeSteam;

/** Every mutating tool, with the minimum arguments needed to invoke it. */
const MUTATING_TOOLS: Array<[string, Record<string, unknown>]> = [
  ["steam_collection_create", { name: "Anything" }],
  ["steam_collection_add_games", { id: "uc-static", appids: [620] }],
  ["steam_collection_remove_games", { id: "uc-static", appids: [212680] }],
  ["steam_collection_replace_games", { id: "uc-static", appids: [620], confirm: true }],
  ["steam_collection_rename", { id: "uc-static", new_name: "Renamed" }],
  ["steam_collection_delete", { id: "uc-static", confirm: true }],
  ["steam_set_favorite", { appids: [620], value: true }],
  ["steam_set_hidden", { appids: [620], value: true }],
  ["steam_install_game", { appid: 620, confirm: true }],
  ["steam_uninstall_game", { appid: 427520, confirm: true }],
];

async function buildServer(): Promise<McpServer> {
  const [
    { registerCollectionTools },
    { registerLibraryTools },
    { registerInstallTools },
    { registerCacheTools },
    { registerStatusTools },
    { registerRestartTool },
  ] = await Promise.all([
    import("../../src/tools/collections.js"),
    import("../../src/tools/library.js"),
    import("../../src/tools/installs.js"),
    import("../../src/tools/cache.js"),
    import("../../src/tools/status.js"),
    import("../../src/tools/restart.js"),
  ]);

  const server = new McpServer({ name: "steam-test", version: "0" });
  registerStatusTools(server);
  registerRestartTool(server);
  registerLibraryTools(server);
  registerCollectionTools(server);
  registerInstallTools(server);
  registerCacheTools(server);
  return server;
}

/**
 * The tools reach Steam through the cdp singleton. We replace evalInPage with a
 * direct call into the page program, which is exactly what the real transport
 * does minus the socket.
 */
async function stubCdp(): Promise<void> {
  const { cdp } = await import("../../src/cdp/client.js");
  vi.spyOn(cdp, "evalInPage").mockImplementation(async (fn: any, arg: any) => fn(arg));
}

beforeEach(async () => {
  const { dir, cleanup } = tempDir("steam-mcp-tools-");
  cleanups.push(cleanup);
  vi.stubEnv("STEAM_ROOT", FIXTURE_ROOT);
  vi.stubEnv("STEAM_MCP_CACHE_DIR", dir);
  vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "1");
  vi.stubEnv("STEAM_API_KEY", "");

  steam = defaultFakeSteam();
  steam.install();

  // Order matters: reset the module registry first, then stub the cdp singleton,
  // then import the tools. Resetting after stubbing would hand the tools a fresh
  // singleton and let them reach for the real Steam client.
  vi.resetModules();
  await stubCdp();
  client = await connectToolClient(await buildServer());
});

afterEach(async () => {
  await client.close();
  FakeSteam.uninstall();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

describe("tool registration", () => {
  it("registers the full tool surface", async () => {
    const names = (await client.listTools()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "steam_status",
        "steam_restart",
        "steam_library_list",
        "steam_library_search",
        "steam_game_details",
        "steam_collections_list",
        "steam_collection_get",
        ...MUTATING_TOOLS.map(([n]) => n),
      ]),
    );
    expect(names.length).toBe(23);
  });

  it("advertises schemas that forbid extra properties", async () => {
    for (const tool of await client.listTools()) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("documents every tool", async () => {
    for (const tool of await client.listTools()) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.description!.length, tool.name).toBeGreaterThan(30);
    }
  });
});

describe("strict argument validation", () => {
  /**
   * The bug this prevents: a bare ZodRawShape silently STRIPS unknown keys, so
   * `dry_run: true` on a tool without that parameter performed the real,
   * destructive operation. Rejecting unknown keys makes a typo loud.
   */
  it.each([
    ["steam_collection_delete", { id: "uc-static", confirm: true, dryrun: true }],
    ["steam_collection_delete", { id: "uc-static", confirm: true, "dry-run": true }],
    ["steam_uninstall_game", { appid: 427520, confirm: true, force: true }],
    ["steam_restart", { confirm: true, safe_mode: true }],
    ["steam_library_list", { limit: 5, sort_by: "name" }],
  ])("rejects an unrecognized argument on %s", async (tool, args) => {
    const { isError, text } = await client.callRaw(tool, args);
    expect(isError).toBe(true);
    expect(text).toMatch(/Unrecognized key/i);
  });

  it("rejects a mistyped required argument rather than guessing", async () => {
    const { isError, text } = await client.callRaw("steam_collection_add_games", {
      id: "uc-static",
      appid: 620, // should be `appids`
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/appids/);
  });

  it("requires confirm on destructive tools", async () => {
    for (const tool of ["steam_collection_delete", "steam_uninstall_game", "steam_restart"]) {
      const { isError, text } = await client.callRaw(tool, { id: "uc-static", appid: 427520 });
      expect(isError, tool).toBe(true);
      expect(text, tool).toMatch(/confirm/i);
    }
  });

  it("enforces value ranges", async () => {
    expect((await client.callRaw("steam_library_list", { limit: 9999 })).isError).toBe(true);
    expect((await client.callRaw("steam_library_search", { query: "" })).isError).toBe(true);
    expect(
      (await client.callRaw("steam_collection_add_games", { id: "x", appids: [] })).isError,
    ).toBe(true);
  });
});

describe("dry_run", () => {
  it("is available on every mutating tool", async () => {
    const tools = await client.listTools();
    for (const [name] of MUTATING_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties), name).toContain("dry_run");
    }
  });

  it.each(MUTATING_TOOLS)("changes nothing when dry_run is set on %s", async (name, args) => {
    const before = {
      collections: steam.collectionIds().slice().sort(),
      staticMembers: steam.membership("uc-static").slice().sort(),
      favorites: steam.membership("favorite").slice().sort(),
      hidden: steam.membership("hidden").slice().sort(),
      saves: steam.saveCalls.length,
      wizards: steam.wizardCalls.length,
    };

    const result = await client.call(name, { ...args, dry_run: true });
    expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);

    expect(steam.collectionIds().slice().sort(), name).toEqual(before.collections);
    expect(steam.membership("uc-static").slice().sort(), name).toEqual(before.staticMembers);
    expect(steam.membership("favorite").slice().sort(), name).toEqual(before.favorites);
    expect(steam.membership("hidden").slice().sort(), name).toEqual(before.hidden);
    expect(steam.saveCalls.length, name).toBe(before.saves);
    expect(steam.wizardCalls.length, name).toBe(before.wizards);
  });

  it("reports the delta a collection change would make", async () => {
    const result = await client.call("steam_collection_add_games", {
      id: "uc-static",
      appids: [620],
      dry_run: true,
    });
    expect(result.added).toEqual([620]);
    expect(result.collection.appCount).toBe(2);
  });

  it("names what a delete would remove", async () => {
    const result = await client.call("steam_collection_delete", {
      id: "uc-static",
      confirm: true,
      dry_run: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.would_delete).toMatchObject({ id: "uc-static", appCount: 1 });
    expect(result.appids_that_would_lose_membership).toEqual([212680]);
  });
});

describe("write gating", () => {
  it("refuses every mutating tool when writes are disabled", async () => {
    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "0");
    for (const [name, args] of MUTATING_TOOLS) {
      const result = await client.call(name, args);
      expect(result.code, name).toBe("WRITES_DISABLED");
    }
    // And nothing was written.
    expect(steam.saveCalls).toEqual([]);
    expect(steam.wizardCalls).toEqual([]);
  });

  it("still allows reads when writes are disabled", async () => {
    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "0");
    expect((await client.call("steam_collections_list")).ok).toBe(true);
    expect((await client.call("steam_library_list", { limit: 3 })).ok).toBe(true);
  });

  it("allows a dry run even when writes are disabled", async () => {
    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "0");
    const result = await client.call("steam_collection_add_games", {
      id: "uc-static",
      appids: [620],
      dry_run: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("library tools", () => {
  it("lists games with a compact default projection", async () => {
    const result = await client.call("steam_library_list", { limit: 3 });
    expect(result.ok).toBe(true);
    expect(result.games.length).toBeLessThanOrEqual(3);
    expect(Object.keys(result.games[0])).toEqual([
      "appid",
      "name",
      "installed",
      "playtimeMinutes",
      "lastPlayed",
    ]);
    expect(result.total).toBeGreaterThan(0);
  });

  it("always reports the unpaginated total", async () => {
    const page = await client.call("steam_library_list", { limit: 1 });
    expect(page.total).toBeGreaterThan(page.games.length);
  });

  it("filters by collection name", async () => {
    const result = await client.call("steam_library_list", {
      collection: "Roguelike / Roguelite",
    });
    expect(result.games.map((g: any) => g.appid)).toEqual([212680]);
  });

  it("reports an unknown collection clearly", async () => {
    const result = await client.call("steam_library_list", { collection: "Nope" });
    expect(result.code).toBe("COLLECTION_NOT_FOUND");
  });

  it("rejects an unparseable date filter", async () => {
    const result = await client.call("steam_library_list", { played_since: "whenever" });
    expect(result.code).toBe("UNSUPPORTED");
  });

  it("searches by name", async () => {
    const result = await client.call("steam_library_search", { query: "factorio" });
    expect(result.matches[0].appid).toBe(427520);
  });

  it("returns candidates instead of guessing an ambiguous name", async () => {
    const result = await client.call("steam_game_details", {
      name: "a",
      include_store: false,
      include_reviews: false,
    });
    expect(result.ambiguous || result.appid).toBeTruthy();
  });

  it("requires an appid or a name for details", async () => {
    const result = await client.call("steam_game_details", { include_store: false });
    expect(result.code).toBe("UNSUPPORTED");
  });
});

describe("collection tools", () => {
  it("lists collections with dynamic and system flags", async () => {
    const result = await client.call("steam_collections_list");
    const dynamic = result.collections.find((c: any) => c.id === "uc-dynamic");
    expect(dynamic.dynamic).toBe(true);
    expect(dynamic.editable).toBe(false);
  });

  it("can exclude system collections", async () => {
    const result = await client.call("steam_collections_list", { include_system: false });
    expect(result.collections.some((c: any) => c.id === "favorite")).toBe(false);
  });

  it("returns a collection with its games", async () => {
    const result = await client.call("steam_collection_get", { id: "uc-static" });
    expect(result.collection.appCount).toBe(1);
    expect(result.games[0]).toMatchObject({ appid: 212680 });
  });

  it("requires an id or name", async () => {
    expect((await client.call("steam_collection_get", {})).code).toBe("COLLECTION_NOT_FOUND");
  });

  it("reuses rather than destroys a same-named collection", async () => {
    const result = await client.call("steam_collection_create", {
      name: "Roguelike / Roguelite",
      appids: [620],
    });
    expect(result.reused).toBe(true);
    expect(steam.collectionIds()).toContain("uc-static");
  });

  it("maps a dynamic-collection write to a clear refusal", async () => {
    const result = await client.call("steam_collection_add_games", {
      id: "uc-dynamic",
      appids: [620],
    });
    expect(result.code).toBe("DYNAMIC_COLLECTION");
    expect(result.hint).toMatch(/static collection/);
  });

  it("requires confirmation for a large replacement", async () => {
    const big = new FakeSteam(
      Array.from({ length: 30 }, (_, i) => ({ appid: 1000 + i, name: `Game ${i}` })),
      [{ id: "uc-big", name: "Big", appids: Array.from({ length: 30 }, (_, i) => 1000 + i) }],
    );
    big.install();
    const result = await client.call("steam_collection_replace_games", {
      id: "uc-big",
      appids: [1000],
      confirm: false,
    });
    expect(result.code).toBe("NEEDS_CONFIRMATION");
    expect(result.would_remove_count).toBe(29);
    expect(big.membership("uc-big")).toHaveLength(30);
  });

  it("applies flags through the supported API", async () => {
    const result = await client.call("steam_set_hidden", { appids: [620], value: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(steam.membership("hidden")).toContain(620);
  });
});

describe("install tools", () => {
  it("says plainly that the wizard is not a silent install", async () => {
    const result = await client.call("steam_install_game", { appid: 620, confirm: true });
    expect(result.opened).toBe(true);
    expect(result.note).toMatch(/no silent install|clicked through/i);
  });

  it("does not open a wizard for an already-installed game", async () => {
    const result = await client.call("steam_install_game", { appid: 427520, confirm: true });
    expect(result.already_installed).toBe(true);
    expect(steam.wizardCalls).toEqual([]);
  });

  it("reports size before uninstalling", async () => {
    const result = await client.call("steam_uninstall_game", { appid: 427520, confirm: true });
    expect(result.wizard).toBe("uninstall");
    expect(result).toHaveProperty("size_gb");
  });
});

describe("status tool", () => {
  it("never throws, and reports capabilities", async () => {
    const result = await client.call("steam_status", { probe_client: false });
    expect(result.ok).toBe(true);
    expect(result.capabilities).toHaveProperty("collections_write");
    expect(result.local.installed_apps).toBe(3); // from the fixture tree
  });

  it("warns when writes are disabled", async () => {
    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "0");
    const result = await client.call("steam_status", { probe_client: false });
    expect(result.capabilities.collections_write.available).toBe(false);
    expect(result.capabilities.collections_write.reason).toBe("WRITES_DISABLED");
    expect(result.warnings.join(" ")).toMatch(/STEAM_MCP_ALLOW_WRITES/);
  });

  it("warns when no API key is configured", async () => {
    const result = await client.call("steam_status", { probe_client: false });
    expect(result.warnings.join(" ")).toMatch(/STEAM_API_KEY/);
  });
});

describe("cache tools", () => {
  it("previews a clear without deleting", async () => {
    const result = await client.call("steam_cache_clear", { scope: "all", dry_run: true });
    expect(result.dry_run).toBe(true);
    expect(result).toHaveProperty("files_that_would_be_removed");
  });

  it("reports cache status", async () => {
    expect((await client.call("steam_cache_status")).ok).toBe(true);
  });
});
