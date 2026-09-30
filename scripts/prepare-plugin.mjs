#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variables = [
  "STEAM_MCP_ALLOW_WRITES",
  "STEAM_DEBUG_PORT",
  "STEAM_API_KEY",
  "STEAM_ACCOUNT_ID",
  "STEAM_MCP_CACHE_DIR",
];

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Keep runtime credentials in the ignored checkout .env, outside the plugin. */
export function configurePlugin(checkout, readRegistration) {
  const path = join(checkout, ".env");
  if (existsSync(path)) return false;
  let env = {};
  try {
    env = readRegistration().transport?.env ?? {};
  } catch {
    // A new checkout need not have a standalone MCP registration.
  }
  const lines = ["# Private Steam plugin settings. Never included in the plugin package."];
  for (const key of variables) {
    const value = env[key];
    if (typeof value !== "string") continue;
    // Node's dotenv parser preserves values within quotes, without interpreting
    // shell substitutions. Refuse values it cannot quote safely.
    if (/[\r\n]/.test(value) || (value.includes('"') && value.includes("'"))) {
      throw new Error(`Cannot safely import ${key}; configure it manually in .env.`);
    }
    const quote = value.includes('"') ? "'" : '"';
    lines.push(`${key}=${quote}${value}${quote}`);
  }
  if (!Object.hasOwn(env, "STEAM_MCP_ALLOW_WRITES")) lines.push("STEAM_MCP_ALLOW_WRITES=0");
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return true;
}

/** Generate host-specific paths; only the manifest and logo enter the package. */
export function buildPlugin(checkout, nodePath = process.execPath) {
  const server = join(checkout, "dist", "index.js");
  if (!existsSync(server)) throw new Error("Build the server before packaging the plugin.");
  const output = join(checkout, ".plugin-build");
  const plugin = join(output, "plugins", "steam");
  const manifest = JSON.parse(
    readFileSync(join(checkout, "plugins", "steam", ".codex-plugin", "plugin.json"), "utf8"),
  );
  manifest.version = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version;
  writeJson(join(plugin, ".codex-plugin", "plugin.json"), manifest);
  mkdirSync(join(plugin, "assets"), { recursive: true });
  copyFileSync(join(checkout, "assets", "logo.png"), join(plugin, "assets", "logo.png"));
  writeJson(join(plugin, ".mcp.json"), {
    mcpServers: {
      steam: {
        command: nodePath,
        args: [`--env-file-if-exists=${join(checkout, ".env")}`, server],
        cwd: checkout,
        // Runtime settings come from the private .env or inherited environment.
        // No secrets or write opt-in are stored in the distributed manifest.
        env: {},
        enabled: true,
        default_tools_approval_mode: "writes",
      },
    },
  });
  writeJson(join(output, ".agents", "plugins", "marketplace.json"), {
    name: "steam-local",
    interface: { displayName: "Steam Local" },
    plugins: [
      {
        name: "steam",
        source: { source: "local", path: "./plugins/steam" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--configure") {
    const created = configurePlugin(root, () =>
      JSON.parse(
        execFileSync(process.env.CODEX_BIN || "codex", ["mcp", "get", "steam", "--json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    );
    console.error(
      created ? "Created private .env; values were not logged." : "Preserved existing .env.",
    );
  } else {
    console.error(`Desktop plugin prepared at ${buildPlugin(root)}`);
  }
}
