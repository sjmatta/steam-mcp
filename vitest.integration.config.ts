import { defineConfig } from "vitest/config";

/**
 * Integration tests drive the real Steam client over CDP. They are opt-in
 * (STEAM_MCP_E2E=1) and run serially in a single process, because the whole
 * point of the CDP layer is that only one evaluation may be in flight against
 * a target at a time.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    restoreMocks: true,
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
    isolate: false,
  },
});
