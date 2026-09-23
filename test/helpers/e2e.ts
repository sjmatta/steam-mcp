import { describe } from "vitest";

/**
 * Integration tests drive the user's real Steam client, so they are opt-in.
 * Run them with:
 *
 *   STEAM_MCP_E2E=1 npm run test:e2e
 *
 * Write tests additionally require STEAM_MCP_E2E_WRITES=1, because they create
 * and delete real collections (always throwaway ones, always cleaned up).
 */
export const e2e = process.env.STEAM_MCP_E2E === "1" ? describe : describe.skip;

export const e2eWrites =
  process.env.STEAM_MCP_E2E === "1" && process.env.STEAM_MCP_E2E_WRITES === "1"
    ? describe
    : describe.skip;

/** Throwaway collection name, unique per run so it can never hit a real one. */
export function scratchName(suffix = ""): string {
  return `zz-steam-mcp-test-${Date.now()}${suffix}`;
}

export const SCRATCH_PREFIX = "zz-steam-mcp-test-";

/**
 * Brings Steam to a usable state so tests do not depend on how the machine was
 * left. If the client is already up with a working debugger this is a no-op;
 * otherwise it launches Steam and waits for the library UI to boot.
 */
export async function ensureSteamReady(): Promise<void> {
  const { cdp } = await import("../../src/cdp/client.js");
  const { probeStores } = await import("../../src/cdp/programs/read.js");
  const { probePort } = await import("../../src/cdp/discover.js");
  const { isSteamRunning, launchSteam, sleep } = await import("../../src/steam-process.js");
  const { preferredDebugPort } = await import("../../src/config.js");

  const healthy = async (): Promise<boolean> => {
    try {
      const probe = await cdp.evalInPage(probeStores, undefined, "e2e-probe");
      return probe.collectionStore && probe.appStore && probe.appCount > 0;
    } catch {
      return false;
    }
  };

  if (await healthy()) return;

  const port = preferredDebugPort();
  if ((await probePort(port)).state === "occupied_by_other") {
    throw new Error(
      `Port ${port} is held by another process, so Steam cannot open its debugger. ` +
        `Free it or set STEAM_DEBUG_PORT.`,
    );
  }

  if (!(await isSteamRunning())) await launchSteam(port);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await healthy()) return;
  }
  throw new Error("Steam did not become ready within 120s.");
}
