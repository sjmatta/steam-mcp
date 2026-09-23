#!/usr/bin/env node
/**
 * Starts the built server and speaks MCP to it over stdio.
 *
 * This catches a class of failure nothing else does: the unit suite imports
 * modules directly and never boots the real binary, so a broken registration,
 * a bad import in dist/, or - the one that matters most - anything writing to
 * stdout would all pass every other check and only fail once a client
 * connected. stdout is the JSON-RPC channel; a single stray byte on it
 * corrupts the stream and drops the connection.
 *
 * Deliberately does NOT need Steam: tools/list only reads the registry.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30_000;

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    },
  },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

const child = spawn(process.execPath, [join(root, "dist", "index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  // No STEAM_MCP_ALLOW_WRITES: starting must not depend on it.
  env: { ...process.env, STEAM_ROOT: "/nonexistent" },
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`server did not answer within ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);

function fail(message) {
  clearTimeout(timer);
  console.error(`smoke-stdio: ${message}`);
  if (stdout) console.error(`--- stdout ---\n${stdout}`);
  if (stderr) console.error(`--- stderr ---\n${stderr}`);
  process.exit(1);
}

for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);

// Two replies is the whole conversation; close stdin so the server exits.
const wantReplies = requests.length;
const check = setInterval(() => {
  if (stdout.trim().split("\n").filter(Boolean).length >= wantReplies) {
    clearInterval(check);
    child.stdin.end();
    child.kill();
    finish();
  }
}, 100);

function finish() {
  clearTimeout(timer);
  const lines = stdout.trim().split("\n").filter(Boolean);

  let tools = null;
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON on stdout, which corrupts the protocol stream:\n  ${line.slice(0, 200)}`);
      return;
    }
    if (msg.error) fail(`server returned an error: ${JSON.stringify(msg.error)}`);
    if (msg.result?.tools) tools = msg.result.tools;
  }

  if (!tools) fail("no tools/list reply");
  if (tools.length === 0) fail("server registered zero tools");

  const unnamed = tools.filter((t) => !t.name?.startsWith("steam_"));
  if (unnamed.length > 0) {
    fail(`tools with unexpected names: ${unnamed.map((t) => t.name).join(", ")}`);
  }

  console.log(`smoke-stdio: OK - ${lines.length} clean JSON-RPC lines, ${tools.length} tools.`);
  process.exit(0);
}
