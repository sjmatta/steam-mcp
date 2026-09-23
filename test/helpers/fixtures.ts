import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSteamPaths, type SteamPaths } from "../../src/paths.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Root of the checked-in fake Steam install. */
export const FIXTURE_ROOT = resolve(here, "..", "fixtures", "steam");

/** The account represented by the fixture tree. */
export const FIXTURE_ACCOUNT_ID = "12345678";

export function fixturePaths(): SteamPaths {
  return makeSteamPaths(FIXTURE_ROOT);
}

/** Paths rooted at a directory that does not exist, for failure paths. */
export function missingPaths(): SteamPaths {
  return makeSteamPaths(join(tmpdir(), `steam-mcp-does-not-exist-${process.pid}`));
}

/** Creates a temp directory and returns it plus a cleanup function. */
export function tempDir(prefix = "steam-mcp-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
