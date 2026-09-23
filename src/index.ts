#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStatusTools } from "./tools/status.js";
import { registerRestartTool } from "./tools/restart.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerInstallTools } from "./tools/installs.js";
import { registerCacheTools } from "./tools/cache.js";

// stdout is the MCP protocol channel. A stray console.log would corrupt the
// JSON-RPC stream and break the connection, so route it to stderr up front.
// `no-console` bans these calls everywhere else; this is the one place that
// has to name them, precisely so that ban cannot be violated at runtime by a
// dependency we do not control.
/* eslint-disable no-console */
console.log = console.error;
console.info = console.error;
console.warn = console.error;
/* eslint-enable no-console */

const server = new McpServer(
  { name: "steam", version: "0.1.0" },
  {
    instructions:
      "Tools for the local Steam client: browsing the game library and managing library collections.\n\n" +
      "Start with steam_status if anything seems unavailable; it reports which capabilities work right now and why.\n\n" +
      "Reads work with Steam closed (from Steam's local files and, if STEAM_API_KEY is set, the Steam Web API), " +
      "but every WRITE - creating or editing collections, favoriting, hiding, install/uninstall - needs Steam running " +
      "with its debugger enabled. When a write fails with STEAM_NOT_RUNNING or DEBUG_PORT_CLOSED, call steam_restart " +
      "(it closes and reopens Steam, so warn the user first).\n\n" +
      "Resolve game names to appids with steam_library_search before calling tools that take appids. " +
      "Dynamic (filter-based) collections cannot be edited - Steam recomputes them and silently discards changes.",
  },
);

registerStatusTools(server);
registerRestartTool(server);
registerLibraryTools(server);
registerCollectionTools(server);
registerInstallTools(server);
registerCacheTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("steam-mcp ready");
}

main().catch((err: unknown) => {
  console.error("steam-mcp failed to start:", err);
  process.exit(1);
});
