#!/usr/bin/env bash
# Dev launcher: serves the built server against a bundle (default: the repo's
# sample-bundle). Model settings come from the environment (LLM_API_*, see
# .env.example). Convenience: if LLM_API_KEY is unset and an OpenRouter secrets
# file exists, the key is read from it and OpenRouter is used.
#
#   OPENROUTER_SECRETS_FILE  JSON file holding the key (default ~/Claude/.secrets/openrouter.json)
#   BUNDLE_ROOT, PORT        as for the server
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

SECRETS_FILE="${OPENROUTER_SECRETS_FILE:-$HOME/Claude/.secrets/openrouter.json}"
if [ -z "${LLM_API_KEY:-}" ] && [ -f "$SECRETS_FILE" ]; then
  # The path is passed as an argument, never spliced into the script source.
  LLM_API_KEY="$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(d.OPENROUTER_API_KEY ?? d.api_key ?? Object.values(d)[0] ?? ""));
  ' "$SECRETS_FILE")"
  export LLM_API_KEY
  export LLM_API_BASE_URL="${LLM_API_BASE_URL:-https://openrouter.ai/api/v1}"
  export LLM_API_FORMAT="${LLM_API_FORMAT:-openai}"
  export LLM_MODEL="${LLM_MODEL:-anthropic/claude-sonnet-5}"
fi

export BUNDLE_ROOT="${BUNDLE_ROOT:-$REPO/sample-bundle}"
export PORT="${PORT:-3800}"
exec node "$REPO/packages/server/dist/index.js"
