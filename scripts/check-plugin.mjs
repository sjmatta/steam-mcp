#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = process.argv[2] || join(root, ".plugin-build", "plugins", "steam", ".mcp.json");
const { steam } = JSON.parse(readFileSync(path, "utf8")).mcpServers;
const client = new Client({ name: "steam-plugin-check", version: "1" });
const transport = new StdioClientTransport({
  command: steam.command,
  args: steam.args,
  cwd: steam.cwd,
  env: {
    ...process.env,
    ...steam.env,
    // Discover and validate tools without contacting the user's Steam client.
    STEAM_ROOT: "/nonexistent",
    STEAM_MCP_ALLOW_WRITES: "0",
  },
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 23);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.ok(tools.some((tool) => tool.name === "steam_status"));
  const result = await client.callTool({
    name: "steam_collection_delete",
    arguments: { id: "plugin-check", confirm: true },
  });
  assert.equal(result.isError, true);
  assert.ok(result.content.some((item) => item.text?.includes("WRITES_DISABLED")));
  console.error(`Plugin MCP handshake passed: ${tools.length} strict tools; writes fail closed.`);
} finally {
  await client.close();
}
