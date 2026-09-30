#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Preserve all other configuration, including Steam's credential section. */
export function disableStandalone(config) {
  return config.replace(
    /(^\[mcp_servers\.(?:steam|"steam")\][^\S\r\n]*\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
    (_match, header, body) => {
      if (/^enabled\s*=/m.test(body)) {
        return header + body.replace(/^enabled\s*=\s*(?:true|false)/m, "enabled = false");
      }
      return `${header}enabled = false\n${body}`;
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const codex = process.env.CODEX_BIN || "codex";
  execFileSync(codex, ["plugin", "marketplace", "add", join(root, ".plugin-build")], {
    stdio: "inherit",
  });
  execFileSync(codex, ["plugin", "add", "steam@steam-local"], { stdio: "inherit" });
  // Each process has its own CDP queue. Use only the plugin registration to
  // avoid two independent servers evaluating against Steam concurrently.
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
  if (existsSync(path)) {
    const before = readFileSync(path, "utf8");
    const after = disableStandalone(before);
    if (after !== before) {
      writeFileSync(path, after);
      console.error("Disabled the duplicate standalone Steam MCP; retained its settings.");
    }
  }
  console.error(
    "Restart ChatGPT Desktop, select Steam Library in local Work or Codex, and call steam_status. " +
      "Chat mode needs a separate registered HTTPS or Secure MCP Tunnel connection.",
  );
}
