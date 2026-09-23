import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers/fixtures.js";

const scanner = fileURLToPath(new URL("../../scripts/check-secrets.mjs", import.meta.url));

describe("secret scan", () => {
  it("checks tracked and staged content without printing a credential", () => {
    const { dir, cleanup } = tempDir("steam-mcp-secret-scan-");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(`${dir}/safe.txt`, "No credentials here.\n");
      execFileSync("git", ["add", "safe.txt"], { cwd: dir });

      const run = (mode: string) =>
        spawnSync(process.execPath, [scanner, mode], { cwd: dir, encoding: "utf8" });
      expect(run("--all").status).toBe(0);
      expect(run("--staged").status).toBe(0);

      const fakeKey = "A".repeat(32);
      writeFileSync(`${dir}/safe.txt`, `STEAM_API_KEY=${fakeKey}\n`);
      execFileSync("git", ["add", "safe.txt"], { cwd: dir });
      const result = run("--staged");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("safe.txt:1");
      expect(result.stderr).not.toContain(fakeKey);

      writeFileSync(`${dir}/safe.txt`, "No credentials here.\n");
      expect(run("--all").status).toBe(0);
      expect(run("--staged").status).toBe(1);

      writeFileSync(`${dir}/logo.png`, Buffer.alloc(1_100_000));
      execFileSync("git", ["add", "logo.png"], { cwd: dir });
      expect(run("--all").status).toBe(0);
      expect(run("--staged").status).toBe(1);
    } finally {
      cleanup();
    }
  });
});
