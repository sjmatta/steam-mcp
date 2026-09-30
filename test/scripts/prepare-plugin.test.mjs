import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildPlugin, configurePlugin } from "../../scripts/prepare-plugin.mjs";
import { disableStandalone } from "../../scripts/install-plugin.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("migration disables only standalone Steam and preserves credentials and other servers", () => {
  const before =
    '[mcp_servers.other]\nenabled = true\n\n[mcp_servers.steam]\nenabled = true\ncommand = "node"\n\n[mcp_servers.steam.env]\nSTEAM_API_KEY = "test-only"\n';
  const after = disableStandalone(before);
  assert.equal(
    after,
    before.replace("[mcp_servers.steam]\nenabled = true", "[mcp_servers.steam]\nenabled = false"),
  );
  assert.equal(disableStandalone(after), after);
  assert.equal(
    disableStandalone('[mcp_servers.steam]\ncommand = "node"\n'),
    '[mcp_servers.steam]\nenabled = false\ncommand = "node"\n',
  );
  assert.equal(
    disableStandalone("[mcp_servers.other]\nenabled = true\n"),
    "[mcp_servers.other]\nenabled = true\n",
  );
});

test("packaging handles spaces, excludes runtime secrets, and can be repeated", (t) => {
  const root = mkdtempSync(join(tmpdir(), "steam plugin "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(repo, "plugins"), join(root, "plugins"), { recursive: true });
  cpSync(join(repo, "assets"), join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0"}');
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "");
  const secret = "test-only-value";
  configurePlugin(root, () => ({ transport: { env: { STEAM_API_KEY: secret } } }));
  assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);
  const first = buildPlugin(root, "/node path/node");
  const path = join(first, "plugins", "steam", ".mcp.json");
  const before = readFileSync(path, "utf8");
  const { steam } = JSON.parse(before).mcpServers;
  assert.deepEqual(steam.args, [
    `--env-file-if-exists=${join(root, ".env")}`,
    join(root, "dist", "index.js"),
  ]);
  assert.equal(steam.command, "/node path/node");
  assert.ok(!before.includes(secret));
  assert.equal(buildPlugin(root, "/node path/node"), first);
  assert.equal(readFileSync(path, "utf8"), before);
  const envBefore = readFileSync(join(root, ".env"), "utf8");
  assert.equal(
    configurePlugin(root, () => {
      throw new Error("must not read existing settings");
    }),
    false,
  );
  assert.equal(readFileSync(join(root, ".env"), "utf8"), envBefore);
});

test("a new registration defaults to read-only and refuses unsafe dotenv values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "steam-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => configurePlugin(root, () => ({ transport: { env: { STEAM_API_KEY: "a\nb" } } })),
    /Cannot safely import/,
  );
  assert.equal(
    configurePlugin(root, () => {
      throw new Error("no registration");
    }),
    true,
  );
  assert.match(readFileSync(join(root, ".env"), "utf8"), /STEAM_MCP_ALLOW_WRITES=0/);
});
