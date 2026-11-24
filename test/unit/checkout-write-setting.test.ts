import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { allowWrites, loadCheckoutWriteSetting } from "../../src/config.js";
import { tempDir } from "../helpers/fixtures.js";

afterEach(() => vi.unstubAllEnvs());

it("loads only the checkout write opt-in and respects explicit client overrides", () => {
  const { dir, cleanup } = tempDir("steam-write-setting-");
  try {
    const file = pathToFileURL(join(dir, ".env"));
    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", undefined);
    vi.stubEnv("STEAM_API_KEY", undefined);
    loadCheckoutWriteSetting(file);
    expect(allowWrites()).toBe(false);

    writeFileSync(file, 'STEAM_MCP_ALLOW_WRITES="1"\nSTEAM_API_KEY=fixture\n');
    loadCheckoutWriteSetting(file);
    expect(allowWrites()).toBe(true);
    expect(process.env.STEAM_API_KEY).toBeUndefined();

    vi.stubEnv("STEAM_MCP_ALLOW_WRITES", "0");
    loadCheckoutWriteSetting(file);
    expect(allowWrites()).toBe(false);
  } finally {
    cleanup();
  }
});
