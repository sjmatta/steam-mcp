import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests must never touch the real Steam install, the network, or the
    // user's cache. Integration tests opt in explicitly via STEAM_MCP_E2E and
    // live under test/integration.
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text-summary", "html"],
      include: ["src/**/*.ts"],
      // Thin composition layers with no branching logic of their own.
      exclude: ["src/index.ts", "src/cdp/programs/types.ts"],
    },
  },
});
