import {
  redactUrl,
  resolveFallbackConfig,
  resolveModelConfig,
  type KnowledgeBase,
} from "@myzel/core";

/**
 * With GIT_AUTOCOMMIT, make sure commits can actually happen before a memory
 * serves requests — otherwise every mutation would report success while
 * history silently stays empty. Throws with the reason; `label` names the
 * memory (the bundle, or a profile) in the message.
 */
export async function requireGitReady(kb: KnowledgeBase, label: string): Promise<void> {
  try {
    await kb.ensureGitReady();
  } catch (err) {
    throw new Error(
      `GIT_AUTOCOMMIT=true, but autocommit cannot work for ${label}: ${(err as Error).message}`,
      { cause: err }
    );
  }
}

/**
 * Validate the LLM configuration at startup and log what will be used — fail
 * fast with a clear error instead of on the first request. `log` is stderr for
 * the stdio transport, whose stdout is the protocol stream. With `optional`
 * (DEMO_MODE) a missing model only warns: browsing needs none, and questions
 * then fail with the configuration error.
 */
export function checkModelConfig(
  log: (line: string) => void,
  { optional = false }: { optional?: boolean } = {}
): void {
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
    if (optional) {
      log(`[myzel] no model: ${(err as Error).message} Browsing works; questions will fail.`);
      return;
    }
    console.error(`[myzel] LLM configuration error: ${(err as Error).message}`);
    console.error("[myzel] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
    process.exit(1);
  }
}
