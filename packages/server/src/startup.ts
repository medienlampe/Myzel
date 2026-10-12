import { redactUrl, resolveFallbackConfig, resolveModelConfig } from "@understory/core";

/**
 * Validate the LLM configuration at startup and log what will be used — fail
 * fast with a clear error instead of on the first request. `log` is stderr for
 * the stdio transport, whose stdout is the protocol stream.
 */
export function checkModelConfig(log: (line: string) => void): void {
  try {
    const primary = resolveModelConfig();
    log(
      `[understory] model: ${primary.format}:${primary.model || "auto"} @ ${redactUrl(primary.baseURL)}`
    );
    const fallback = resolveFallbackConfig();
    if (fallback) {
      log(
        `[understory] fallback: ${fallback.format}:${fallback.model || "auto"} @ ${redactUrl(fallback.baseURL)}`
      );
    }
  } catch (err) {
    console.error(`[understory] LLM configuration error: ${(err as Error).message}`);
    console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
    process.exit(1);
  }
}
