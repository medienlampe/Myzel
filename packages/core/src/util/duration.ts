/**
 * Longest delay Node's timers accept. Anything larger (about 24.8 days) makes
 * setInterval fire every millisecond and AbortSignal.timeout abort at once.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Parse "30s" | "15m" | "6h" | "1d" into milliseconds, capped at what a timer
 * can hold. Returns null for unset, invalid or zero values.
 */
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  const ms = Math.round(value * factor);
  return ms > 0 ? Math.min(ms, MAX_TIMER_MS) : null;
}
