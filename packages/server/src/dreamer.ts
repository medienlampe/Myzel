import { parseDuration, runDream, truncate, type KnowledgeBase } from "@myzel/core";

const MIN_INTERVAL_MS = 5 * 60_000;

/** A memory to consolidate; `label` names it in the logs (the profile, if any). */
export interface DreamTarget {
  kb: KnowledgeBase;
  label: string | null;
}

/**
 * Background dreamer: runs a consolidation pass every DREAM_INTERVAL
 * (e.g. "6h"). Opt-in — unset means no background token spend. The first
 * run happens one interval after boot, never at startup. With several memories
 * hosted (profiles), they are dreamed one after another, never in parallel:
 * a local model serves one run at a time. Returns a stop function for shutdown.
 */
export function startDreamer(targets: () => Promise<DreamTarget[]>): () => void {
  const raw = process.env.DREAM_INTERVAL;
  const interval = parseDuration(raw);
  if (!interval) {
    if (raw) console.error(`[myzel] invalid DREAM_INTERVAL "${raw}" — dreaming disabled`);
    else console.log("[myzel] dreaming: disabled (set DREAM_INTERVAL, e.g. 6h, to enable)");
    return () => {};
  }
  const every = Math.max(interval, MIN_INTERVAL_MS);
  console.log(
    `[myzel] dreaming: every ${raw}${every !== interval ? " (clamped to 5m minimum)" : ""}`
  );

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // never overlap dreams
    busy = true;
    try {
      for (const { kb, label } of await targets()) {
        const tag = label ? ` [${label}]` : "";
        try {
          const report = await runDream(kb);
          if (report.ran) {
            console.log(
              `[myzel] dream complete${tag}: ${report.filesChanged?.length ?? 0} file(s) changed — ${truncate(report.summary ?? "", 200)}`
            );
          } else {
            console.log(`[myzel] dream skipped${tag}: ${report.reason}`);
          }
        } catch (err) {
          console.error(`[myzel] dream failed${tag}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[myzel] dreaming failed: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  }, every);
  timer.unref(); // never keep the process alive just to dream
  return () => clearInterval(timer);
}
