import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cdp } from "../cdp/client.js";
import { probeStores } from "../cdp/programs/read.js";
import { scanPorts } from "../cdp/discover.js";
import { allowWrites, detectAccount } from "../config.js";
import { defaultPaths } from "../paths.js";
import { existsSync } from "node:fs";
import { isSteamRunning, runningGames } from "../steam-process.js";
import { readInstalledApps } from "../local/appmanifests.js";
import { readLocalConfig } from "../local/localconfig.js";
import { readOfflineCollections } from "../local/cloudstorage.js";
import { hasApiKey } from "../web/webapi.js";
import { cache } from "../cache.js";
import { handler, ok, registerStrictTool } from "./shared.js";

export function registerStatusTools(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_status",
    {
      title: "Steam status",
      description:
        "Report Steam client state, debugger reachability, which data sources are usable, and which capabilities are currently available. Never fails - it reports problems instead of throwing. Call this first whenever a Steam operation is unexpectedly unavailable.",
      inputSchema: {
        probe_client: z
          .boolean()
          .default(true)
          .describe("Attempt a live connection to the Steam client (adds up to ~2s)."),
      },
    },
    handler(async ({ probe_client }: { probe_client: boolean }) => {
      const acct = detectAccount();

      const local: Record<string, unknown> = {
        steam_root: defaultPaths().root,
        debug_marker_present: existsSync(defaultPaths().cefDebugMarker),
      };
      if (acct) {
        local["account_id"] = acct.accountId;
        local["steamid64"] = acct.steamId64;
        local["account_name"] = acct.accountName;
        try {
          local["installed_apps"] = readInstalledApps().length;
          local["playtime_entries"] = readLocalConfig(acct.accountId).playtime.size;
          local["collections_offline"] = readOfflineCollections(acct.accountId).collections.length;
        } catch (e) {
          local["read_error"] = String(e);
        }
      }

      const games = await runningGames();
      const steam: Record<string, unknown> = {
        running: await isSteamRunning(),
        running_games: games.map((g) => g.command),
      };

      const client: Record<string, unknown> = { probed: probe_client };
      let storesReady = false;

      if (probe_client) {
        const scan = await scanPorts();
        client["ports"] = scan.probes.map((p) => ({
          port: p.port,
          state: p.state,
          ...(p.occupant ? { occupant: `${p.occupant.command} (pid ${p.occupant.pid})` } : {}),
        }));
        client["debug_port"] = scan.openPort;

        if (scan.openPort !== null) {
          try {
            const probe = await cdp.evalInPage(probeStores, undefined, "probeStores");
            storesReady = probe.collectionStore && probe.appStore;
            client["stores_ready"] = storesReady;
            client["app_count"] = probe.appCount;
            client["user_collections"] = probe.collectionCount;
            client["target"] = cdp.connection?.target.title;
          } catch (e) {
            client["stores_ready"] = false;
            client["error"] = e instanceof Error ? e.message : String(e);
          }
        } else {
          client["stores_ready"] = false;
        }
      }

      const warnings: string[] = [];
      const occupied = (
        client["ports"] as Array<{ state: string; port: number; occupant?: string }> | undefined
      )?.find((p) => p.state === "occupied_by_other");
      if (occupied) {
        warnings.push(
          `Port ${occupied.port} is held by ${occupied.occupant ?? "another process"}, so Steam cannot open its debugger there. Free that port, or set STEAM_DEBUG_PORT to a free one.`,
        );
      }
      if (!allowWrites()) {
        warnings.push(
          "Write operations are disabled. Set STEAM_MCP_ALLOW_WRITES=1 in the server environment to enable collection edits.",
        );
      }
      if (!hasApiKey()) {
        warnings.push(
          "No STEAM_API_KEY set. The full owned library is only available from the running client; offline reads fall back to locally known games.",
        );
      }

      const writeReason = !allowWrites()
        ? "WRITES_DISABLED"
        : !storesReady
          ? steam["running"]
            ? "DEBUG_PORT_CLOSED"
            : "STEAM_NOT_RUNNING"
          : null;

      return ok({
        steam,
        client,
        local,
        web: { api_key_present: hasApiKey() },
        cache: {
          dir: cache().dir,
          library_age_seconds: (() => {
            const age = cache().age("library");
            return age === null ? null : Math.round(age / 1000);
          })(),
        },
        capabilities: {
          library_read: { available: true, source: storesReady ? "live" : "local/webapi" },
          collections_read: { available: true, source: storesReady ? "live" : "local" },
          collections_write: {
            available: writeReason === null,
            ...(writeReason ? { reason: writeReason, next_tool: "steam_restart" } : {}),
          },
          install_uninstall: {
            available: writeReason === null,
            ...(writeReason ? { reason: writeReason } : {}),
          },
        },
        warnings,
      });
    }),
  );
}
