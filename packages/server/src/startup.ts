import {
  redactUrl,
  resolveFallbackConfig,
  resolveModelConfig,
  type KnowledgeBase,
} from "@myzel/core";

/**
 * With GIT_AUTOCOMMIT, make sure commits can actually happen before serving —
 * otherwise every mutation would report success while history silently stays
 * empty. `log` is stderr for the stdio transport.
 */
export async function checkGitAutocommit(
  kb: KnowledgeBase,
  log: (line: string) => void
): Promise<void> {
  if (process.env.GIT_AUTOCOMMIT !== "true") return;
  try {
    await kb.ensureGitReady();
  } catch (err) {
    console.error(
      `[myzel] GIT_AUTOCOMMIT=true, but autocommit cannot work: ${(err as Error).message}`
    );
    process.exit(1);
  }
  log("[myzel] git autocommit: enabled");
}

/**
 * Validate the LLM configuration at startup and log what will be used — fail
 * fast with a clear error instead of on the first request. `log` is stderr for
 * the stdio transport, whose stdout is the protocol stream.
 */
export function checkModelConfig(log: (line: string) => void): void {
  try {
    const primary = resolveModelConfig();
    log(
      `[myzel] model: ${primary.format}:${primary.model || "auto"} @ ${redactUrl(primary.baseURL)}`
    );
    const fallback = resolveFallbackConfig();
    if (fallback) {
      log(
        `[myzel] fallback: ${fallback.format}:${fallback.model || "auto"} @ ${redactUrl(fallback.baseURL)}`
      );
    }
  } catch (err) {
    console.error(`[myzel] LLM configuration error: ${(err as Error).message}`);
    console.error("[myzel] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
    process.exit(1);
  }
}
