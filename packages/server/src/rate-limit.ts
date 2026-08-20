import type { NextFunction, Request, Response } from "express";

/**
 * Fixed-window rate limiter, in memory, no dependency.
 *
 * What it protects: every request to /api/chat and /mcp can start an agent run,
 * and an agent run spends tokens. On an instance without AUTH_TOKEN that is a
 * direct cost lever for anyone who can reach the port; even with a token it
 * bounds the damage of a leaked one and of a client stuck in a retry loop.
 *
 * Deliberately coarse: one process, one counter per client, whole windows. It
 * is a brake, not an accounting system.
 */
export interface RateLimitOptions {
  /** Requests allowed per window. 0 disables the limiter entirely. */
  limit: number;
  windowMs: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Above this many tracked clients, drop the expired ones before adding more. */
const SWEEP_THRESHOLD = 10_000;

export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, Window>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.limit <= 0) {
      next();
      return;
    }
    const now = Date.now();
    // req.ip honours "trust proxy" when the app sets it; otherwise it is the
    // socket address, which is what we want for a directly-exposed server.
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";

    if (windows.size > SWEEP_THRESHOLD) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }

    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }
    window.count++;

    const remaining = Math.max(0, options.limit - window.count);
    res.setHeader("RateLimit-Limit", String(options.limit));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((window.resetAt - now) / 1000)));

    if (window.count > options.limit) {
      res.setHeader("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)));
      res.status(429).json({
        error: `rate limit exceeded: ${options.limit} requests per ${Math.round(options.windowMs / 1000)}s. Raise RATE_LIMIT or set it to 0 to disable.`,
      });
      return;
    }
    next();
  };
}
