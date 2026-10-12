import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spies and mocks never leak between tests, even when one fails midway.
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The agent smoke CLI only wires argv to runQuery/runMutation and needs a
      // live model; everything it calls is covered on its own.
      exclude: ["src/agent/cli.ts"],
      reporter: ["text-summary", "text", "html"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
