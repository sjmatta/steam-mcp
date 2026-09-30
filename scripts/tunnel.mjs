#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disableStandalone } from "./install-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".tunnel");
const binary = join(dir, "bin", "tunnel-client");
const profiles = join(dir, "profiles");
const keyFile = join(dir, "runtime-api-key");
const alias = "steam-chat";

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function mcpCommand(checkout, node = process.execPath) {
  return [
    node,
    `--env-file-if-exists=${join(checkout, ".env")}`,
    join(checkout, "dist", "index.js"),
  ]
    .map(shellQuote)
    .join(" ");
}

export function disableLocalSteam(config) {
  return disableStandalone(config).replace(
    /(^\[plugins\."steam@steam-local"\][^\S\r\n]*\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
    (_match, header, body) =>
      header +
      (/^enabled\s*=/m.test(body)
        ? body.replace(/^enabled\s*=\s*(?:true|false)/m, "enabled = false")
        : `enabled = false\n${body}`),
  );
}

function run(args, options = {}) {
  return execFileSync(binary, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      HEALTH_LISTEN_ADDR: "127.0.0.1:0",
      MCP_MAX_CONCURRENT_REQUESTS: "1",
      MCP_STDIO_SEND_INITIALIZED_NOTIFICATION: "true",
    },
    ...options,
  });
}

function download() {
  if (process.platform !== "darwin") throw new Error("The Steam tunnel runs on macOS.");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const release = JSON.parse(
    execFileSync(
      "curl",
      ["-fsSL", "https://api.github.com/repos/openai/tunnel-client/releases/latest"],
      { encoding: "utf8" },
    ),
  );
  const name = `tunnel-client-${release.tag_name}-darwin-${arch}.zip`;
  const asset = (file) => {
    const url = release.assets.find((item) => item.name === file)?.browser_download_url;
    if (!url?.startsWith("https://github.com/openai/tunnel-client/releases/download/")) {
      throw new Error(`Official release does not contain ${file}.`);
    }
    return url;
  };
  const temp = mkdtempSync(join(tmpdir(), "steam-tunnel-download-"));
  try {
    const zip = join(temp, name);
    const sums = join(temp, "SHA256SUMS.txt");
    execFileSync("curl", ["-fsSL", asset(name), "-o", zip]);
    execFileSync("curl", ["-fsSL", asset("SHA256SUMS.txt"), "-o", sums]);
    const expected = readFileSync(sums, "utf8")
      .split("\n")
      .find((line) => line.trim().endsWith(name))
      ?.split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
    if (actual !== expected) throw new Error("Official tunnel-client checksum did not match.");
    mkdirSync(dirname(binary), { recursive: true });
    execFileSync("unzip", ["-oq", zip, "-d", dirname(binary)]);
    chmodSync(binary, 0o700);
    chmodSync(join(dirname(binary), "cloudflared"), 0o700);
    console.error(`Installed official ${release.tag_name} client; SHA-256 verified.`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function tunnelId() {
  const path = join(dir, "tunnel-id");
  const value =
    process.env.TUNNEL_ID || (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
  if (!/^tunnel_[a-f0-9]{32}$/.test(value)) {
    throw new Error("Set TUNNEL_ID to the tunnel created in OpenAI Platform (not an API key).");
  }
  return value;
}

function requireKey() {
  if (!existsSync(keyFile) || !readFileSync(keyFile, "utf8").trim()) {
    throw new Error(
      `Save a runtime API key with Tunnels Read + Use to ${keyFile}. Do not put it in task arguments.`,
    );
  }
  chmodSync(keyFile, 0o600);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === "download") {
    download();
  } else if (action === "init") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(binary)) download();
    if (!existsSync(join(root, "dist", "index.js"))) throw new Error("Run task build first.");
    const id = tunnelId();
    writeFileSync(join(dir, "tunnel-id"), `${id}\n`, { mode: 0o600 });
    run([
      "init",
      "--force",
      "--sample",
      "sample_mcp_stdio_local",
      "--profile",
      "steam",
      "--profile-dir",
      profiles,
      "--tunnel-id",
      id,
      "--mcp-command",
      mcpCommand(root),
      "--control-plane-api-key-ref",
      `file:${keyFile}`,
      "--health-listen-addr",
      "127.0.0.1:0",
    ]);
    console.error(`Profile ready. Runtime key must be saved privately to ${keyFile}.`);
  } else if (action === "doctor") {
    requireKey();
    run(["doctor", "--profile", "steam", "--profile-dir", profiles, "--explain"]);
  } else if (action === "start") {
    requireKey();
    const configPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
    if (existsSync(configPath)) {
      const before = readFileSync(configPath, "utf8");
      const after = disableLocalSteam(before);
      if (after !== before) writeFileSync(configPath, after);
    }
    run([
      "runtimes",
      "connect",
      "--alias",
      alias,
      "--profile",
      "steam",
      "--profile-dir",
      profiles,
      "--tunnel-id",
      tunnelId(),
      "--mcp-command",
      mcpCommand(root),
      "--runtime-api-key",
      `file:${keyFile}`,
    ]);
    run(["runtimes", "status", alias, "--json"]);
  } else if (action === "status") {
    run(["runtimes", "status", alias, "--json"]);
  } else if (action === "stop") {
    run(["runtimes", "stop", alias]);
  } else {
    throw new Error("Usage: node scripts/tunnel.mjs download|init|doctor|start|status|stop");
  }
}
