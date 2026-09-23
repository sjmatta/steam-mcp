import { beforeAll, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRestartTool } from "../../src/tools/restart.js";
import { registerStatusTools } from "../../src/tools/status.js";
import { isSteamRunning } from "../../src/steam-process.js";
import { probePort } from "../../src/cdp/discover.js";
import { connectToolClient } from "../helpers/mcp.js";
import { e2e, ensureSteamReady } from "../helpers/e2e.js";

async function client() {
  const server = new McpServer({ name: "steam-e2e", version: "0" });
  registerStatusTools(server);
  registerRestartTool(server);
  return connectToolClient(server);
}

e2e("steam_restart guards", () => {
  // These assert Steam is left running, so it must be running to begin with.
  beforeAll(ensureSteamReady, 180_000);

  it("rejects a call without confirm before doing anything", async () => {
    const c = await client();
    try {
      const { isError, text } = await c.callRaw("steam_restart", {});
      expect(isError).toBe(true);
      expect(text).toMatch(/confirm/i);
      // Steam must be untouched.
      expect(await isSteamRunning()).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("previews without touching Steam", async () => {
    const c = await client();
    try {
      const result = await c.call("steam_restart", { confirm: true, dry_run: true });
      expect(result.dry_run).toBe(true);
      expect(result).toHaveProperty("would_restart");
      expect(await isSteamRunning()).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("does nothing when Steam is already healthy", async () => {
    const c = await client();
    try {
      const result = await c.call("steam_restart", { confirm: true, skip_if_healthy: true });
      expect(result.restarted).toBe(false);
      expect(result.reason).toBe("already_healthy");
    } finally {
      await c.close();
    }
  });

  /**
   * The port must be checked BEFORE quitting Steam: a restart that fails to
   * reopen the debugger must never leave the user with Steam closed.
   */
  it("refuses an occupied port and leaves Steam running", async () => {
    // Find a port that is occupied by something that is not a CDP endpoint.
    const candidates = [8080, 3000, 5000];
    let occupied: number | null = null;
    for (const port of candidates) {
      if ((await probePort(port)).state === "occupied_by_other") {
        occupied = port;
        break;
      }
    }
    if (occupied === null) return; // nothing suitable is listening

    const c = await client();
    try {
      const result = await c.call("steam_restart", {
        confirm: true,
        skip_if_healthy: false,
        port: occupied,
      });
      expect(result.code).toBe("PORT_OCCUPIED");
      expect(result.hint).toMatch(/devtools-port|Stop or move/);
      expect(await isSteamRunning()).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("reports a usable capability set", async () => {
    const c = await client();
    try {
      const status = await c.call("steam_status", { probe_client: true });
      expect(status.ok).toBe(true);
      expect(status.client.stores_ready).toBe(true);
      expect(status.capabilities.collections_read.available).toBe(true);
    } finally {
      await c.close();
    }
  });
});
