import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

/**
 * Flat config for the workspace. Deliberately type-unaware (no project service):
 * the type errors are already caught by `pnpm test`, which typechecks every
 * package, so lint stays fast and focused on the things tsc does not say.
 */
export default defineConfig(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "sample-bundle/**",
      "demo-bundle/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Unused args are often part of a signature we must keep (middleware,
      // React props); an underscore marks the intent.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // `({ node, ...props })` drops a prop on purpose; that is not "unused".
          ignoreRestSiblings: true,
        },
      ],
      // `any` is a smell but sometimes the honest type at an SDK boundary.
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off", // the server logs to the console by design
    },
  },
  {
    files: ["packages/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["packages/{core,server}/**/*.{ts,mts}", "packages/web/vite.config.ts", "*.js"],
    languageOptions: { globals: globals.node },
  },
  prettier
);
