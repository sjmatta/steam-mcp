import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { disableLocalSteam, mcpCommand, shellQuote } from "../../scripts/tunnel.mjs";

test("stdio command preserves literal paths with spaces, quotes, and shell substitutions", () => {
  const values = ["a b", "a'b", "$(false)", "`false`", "\\path"];
  for (const value of values) {
    const result = execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(value)}`], {
      encoding: "utf8",
    });
    assert.equal(result, value);
  }
  const checkout = "/tmp/steam's checkout";
  const command = mcpCommand(checkout, "/node path/node");
  const output = execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
    encoding: "utf8",
  });
  assert.deepEqual(output.trim().split("\n"), [
    "/node path/node",
    `--env-file-if-exists=${checkout}/.env`,
    `${checkout}/dist/index.js`,
  ]);
});

test("tunnel migration disables only local Steam registrations and preserves private settings", () => {
  const config =
    '[plugins."other@local"]\nenabled = true\n\n[plugins."steam@steam-local"]\nenabled = true\n\n[mcp_servers.steam]\nenabled = true\n\n[mcp_servers.steam.env]\nSTEAM_API_KEY = "test-only"\n';
  const after = disableLocalSteam(config);
  assert.equal(
    after,
    config
      .replace(
        '[plugins."steam@steam-local"]\nenabled = true',
        '[plugins."steam@steam-local"]\nenabled = false',
      )
      .replace("[mcp_servers.steam]\nenabled = true", "[mcp_servers.steam]\nenabled = false"),
  );
  assert.equal(disableLocalSteam(after), after);
});
