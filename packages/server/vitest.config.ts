import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Spies and mocks never leak between tests, even when one fails midway.
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Process entry points: they read the environment, listen and install
      // signal handlers. Everything they assemble (buildApp, the memory hosts,
      // the registry, the CLI commands in profiles-commands.ts) is covered on its
      // own; the entry points are exercised by `make image-check` and the stdio
      // smoke test.
      exclude: ["src/index.ts", "src/mcp/stdio.ts", "src/profiles-cli.ts"],
      reporter: ["text-summary", "text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
