import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import { cdp } from "../cdp/client.js";
import { findSharedJsContext, probePort } from "../cdp/discover.js";
import { probeStores } from "../cdp/programs/read.js";
import { preferredDebugPort } from "../config.js";
import { defaultPaths } from "../paths.js";
import { SteamError, needsConfirmation } from "../errors.js";
import { isSteamRunning, launchSteam, quitSteam, runningGames, sleep } from "../steam-process.js";
import { handler, ok, registerStrictTool } from "./shared.js";

export function registerRestartTool(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_restart",
    {
      title: "Restart Steam with debugging",
      description:
        "Quit Steam and relaunch it with its Chromium debugger enabled, then wait for the library UI to finish loading. " +
        "WARNING: this closes the Steam client. Any running game will be interrupted and unsaved progress may be lost - the tool refuses to run if it detects a game, unless allow_interrupt_game is set. " +
        "Required before any collection write when steam_status reports collections_write unavailable. Typically takes 25-60s.",
      inputSchema: {
        confirm: z
          .literal(true)
          .describe("Must be true. Acknowledges that Steam will be closed and reopened."),
        skip_if_healthy: z
          .boolean()
          .default(true)
          .describe("Do nothing if Steam is already running with a working debugger."),
        allow_interrupt_game: z
          .boolean()
          .default(false)
          .describe("Proceed even if a game appears to be running. This will terminate it."),
        port: z
          .number()
          .int()
          .min(1024)
          .max(65535)
          .optional()
          .describe("Debugger port. Defaults to 8080, Steam's built-in default."),
        dry_run: z
          .boolean()
          .default(false)
          .describe(
            "Report what would happen - including what would be interrupted - without touching Steam.",
          ),
      },
    },
    handler(
      async ({
        skip_if_healthy,
        allow_interrupt_game,
        port,
        dry_run,
      }: {
        confirm: true;
        skip_if_healthy: boolean;
        allow_interrupt_game: boolean;
        port?: number;
        dry_run: boolean;
      }) => {
        const started = Date.now();
        const targetPort = port ?? preferredDebugPort();

        if (dry_run) {
          const games = await runningGames();
          const running = await isSteamRunning();
          const preflight = await probePort(targetPort);
          let healthy = false;
          try {
            const probe = await cdp.evalInPage(probeStores, undefined, "probeStores");
            healthy = probe.collectionStore && probe.appStore;
          } catch {
            // Debugger unreachable; that is what the dry run is reporting.
          }

          const blocked = preflight.state === "occupied_by_other";
          const wouldRestart = !(skip_if_healthy && healthy) && !blocked;
          return ok({
            dry_run: true,
            steam_running: running,
            currently_healthy: healthy,
            target_port: targetPort,
            port_state: preflight.state,
            ...(preflight.occupant
              ? { port_occupant: `${preflight.occupant.command} (pid ${preflight.occupant.pid})` }
              : {}),
            running_games: games.map((g) => g.command),
            would_restart: wouldRestart,
            would_interrupt_games: wouldRestart && games.length > 0,
            blocked_reason: blocked
              ? `Port ${targetPort} is occupied; the restart would be refused before Steam is quit.`
              : skip_if_healthy && healthy
                ? "Steam is already healthy; the restart would be skipped."
                : games.length > 0 && !allow_interrupt_game
                  ? "A game is running; the restart would be refused unless allow_interrupt_game is set."
                  : null,
            note: "Nothing was changed. Re-run without dry_run to proceed.",
          });
        }

        if (skip_if_healthy) {
          try {
            const probe = await cdp.evalInPage(probeStores, undefined, "probeStores");
            if (probe.collectionStore && probe.appStore) {
              return ok({
                restarted: false,
                reason: "already_healthy",
                port: cdp.connection?.port ?? null,
                stores_ready: true,
                app_count: probe.appCount,
                elapsed_ms: Date.now() - started,
              });
            }
          } catch {
            // Not healthy; carry on with the restart.
          }
        }

        // Refuse to kill a live game session. This is the single most
        // destructive thing the server could do by accident.
        const games = await runningGames();
        if (games.length > 0 && !allow_interrupt_game) {
          throw needsConfirmation(
            `A game appears to be running (${games.map((g) => g.command).join(", ")}). Restarting Steam will terminate it.`,
            { running_games: games.map((g) => g.command), parameter: "allow_interrupt_game" },
          );
        }

        // Preflight the port BEFORE quitting: never shut Steam down only to
        // discover it cannot reopen its debugger.
        const preflight = await probePort(targetPort);
        if (preflight.state === "occupied_by_other") {
          throw new SteamError(
            "PORT_OCCUPIED",
            `Port ${targetPort} is held by ${
              preflight.occupant
                ? `${preflight.occupant.command} (pid ${preflight.occupant.pid})`
                : "another process"
            }, so Steam would start without a debugger. Steam was left running.`,
            {
              details: {
                port: targetPort,
                occupant: preflight.occupant,
                evidence: preflight.evidence,
              },
              hint: `Stop or move that process, then retry. Alternatively pass a free port, which launches Steam with "-devtools-port <port>".`,
            },
          );
        }

        // The marker file makes debugging survive Steam's own relaunches
        // (self-updates, launches from the Dock) which carry no argv.
        if (!existsSync(defaultPaths().cefDebugMarker))
          writeFileSync(defaultPaths().cefDebugMarker, "", "utf8");

        cdp.close();

        const wasRunning = await isSteamRunning();
        const quit = wasRunning ? await quitSteam() : { quitMs: 0 };

        const launch = await launchSteam(targetPort);

        // Wait for the debug port.
        const portDeadline = Date.now() + 60_000;
        let portOpen = false;
        while (Date.now() < portDeadline) {
          const probe = await probePort(targetPort);
          if (probe.state === "open") {
            portOpen = true;
            break;
          }
          await sleep(750);
        }
        if (!portOpen) {
          throw new SteamError(
            "DEBUG_PORT_CLOSED",
            `Steam was relaunched but did not open a debugger on port ${targetPort} within 60s.`,
            {
              details: { port: targetPort, launch_args: launch.args },
              hint: "Check that Steam actually started, then retry.",
            },
          );
        }

        // Wait for the SharedJSContext target, then for the stores to boot.
        await findSharedJsContext(targetPort, 6, 1000);

        const bootDeadline = Date.now() + 120_000;
        let appCount = 0;
        let storesReady = false;
        while (Date.now() < bootDeadline) {
          try {
            const probe = await cdp.evalInPage(probeStores, undefined, "probeStores");
            if (probe.collectionStore && probe.appStore && probe.appCount > 0) {
              storesReady = true;
              appCount = probe.appCount;
              break;
            }
          } catch {
            // Target may still be reloading during boot.
          }
          await sleep(1000);
        }

        if (!storesReady) {
          throw new SteamError(
            "STORES_NOT_READY",
            "Steam relaunched with a working debugger, but its library UI did not finish loading in time.",
            {
              details: { port: targetPort, elapsed_ms: Date.now() - started },
              hint: "Steam may be showing a login prompt or an update dialog. Check the Steam window, then call steam_status.",
            },
          );
        }

        return ok({
          restarted: true,
          port: targetPort,
          launch_args: launch.args,
          stores_ready: true,
          app_count: appCount,
          interrupted_games: games.map((g) => g.command),
          timings_ms: { quit: quit.quitMs, total: Date.now() - started },
          capabilities_now: { collections_write: true, install_uninstall: true },
        });
      },
    ),
  );
}
