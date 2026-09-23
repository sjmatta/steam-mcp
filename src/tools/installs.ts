import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cdp } from "../cdp/client.js";
import { openWizard } from "../cdp/programs/write.js";
import { loadLibrary } from "../model.js";
import {
  assertWritesAllowed,
  confirmSchema,
  handler,
  mapPageError,
  ok,
  registerStrictTool,
} from "./shared.js";

const WIZARD_NOTE =
  "Steam has no silent install API. This opens a dialog in the Steam window that must be clicked through by hand; nothing happens until then.";

/** Describes what a wizard call would do, without opening anything. */
async function previewWizard(
  appid: number,
  kind: "install" | "uninstall",
): Promise<Record<string, unknown>> {
  const view = await loadLibrary().catch(() => null);
  const game = view?.games.find((g) => g.appid === appid);
  const installed = game?.installed ?? false;

  const wouldOpen = kind === "install" ? !installed : installed;
  return {
    dry_run: true,
    appid,
    name: game?.name ?? null,
    wizard: kind,
    installed,
    size_gb: game ? Number((game.sizeOnDisk / 1e9).toFixed(2)) : null,
    would_open_wizard: wouldOpen,
    note: wouldOpen
      ? `Would open Steam's ${kind} wizard. ${WIZARD_NOTE}`
      : kind === "install"
        ? "Already installed; no wizard would open."
        : "Not installed; no wizard would open.",
  };
}

export function registerInstallTools(server: McpServer): void {
  registerStrictTool(
    server,
    "steam_install_game",
    {
      title: "Open Steam's install wizard",
      description:
        `Open Steam's install wizard for a game. NOT a silent install: ${WIZARD_NOTE} ` +
        "Returns as soon as the wizard is open; check steam_game_details later to see whether the download actually started.",
      inputSchema: {
        appid: z.number().int().positive(),
        confirm: confirmSchema,
        dry_run: z
          .boolean()
          .default(false)
          .describe("Report what would happen without opening the wizard."),
      },
    },
    handler(async ({ appid, dry_run }: { appid: number; confirm: true; dry_run: boolean }) => {
      if (dry_run) return ok(await previewWizard(appid, "install"));
      assertWritesAllowed();
      try {
        const result = await cdp.evalInPage(
          openWizard,
          { appid, kind: "install" },
          "installWizard",
        );
        return ok({
          appid: result.appid,
          name: result.name,
          wizard: "install",
          opened: result.opened,
          already_installed: result.alreadyInstalled,
          note: result.alreadyInstalled
            ? "Already installed; no wizard was opened."
            : `${WIZARD_NOTE} Switch to Steam to complete it.`,
        });
      } catch (e) {
        return mapPageError(e, { appid });
      }
    }),
  );

  registerStrictTool(
    server,
    "steam_uninstall_game",
    {
      title: "Open Steam's uninstall wizard",
      description:
        `Open Steam's uninstall wizard for a game. NOT silent: ${WIZARD_NOTE} ` +
        "Deleting game files is irreversible and any saves kept inside the game folder go with them; Steam Cloud saves are unaffected. Requires confirm=true.",
      inputSchema: {
        appid: z.number().int().positive(),
        confirm: confirmSchema,
        dry_run: z
          .boolean()
          .default(false)
          .describe("Report what would be removed without opening the wizard."),
      },
    },
    handler(async ({ appid, dry_run }: { appid: number; confirm: true; dry_run: boolean }) => {
      if (dry_run) return ok(await previewWizard(appid, "uninstall"));
      assertWritesAllowed();

      // Report what is at stake before opening the dialog.
      const view = await loadLibrary().catch(() => null);
      const game = view?.games.find((g) => g.appid === appid);

      try {
        const result = await cdp.evalInPage(
          openWizard,
          { appid, kind: "uninstall" },
          "uninstallWizard",
        );
        return ok({
          appid: result.appid,
          name: result.name,
          wizard: "uninstall",
          opened: result.opened,
          installed: result.alreadyInstalled,
          size_gb: game ? Number((game.sizeOnDisk / 1e9).toFixed(2)) : null,
          note: result.opened
            ? `${WIZARD_NOTE} Switch to Steam to confirm the removal.`
            : "That game is not installed; no wizard was opened.",
        });
      } catch (e) {
        return mapPageError(e, { appid });
      }
    }),
  );
}
