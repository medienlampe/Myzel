import { isIPv6 } from "node:net";
import type { NextFunction, Request, Response } from "express";

/**
 * Fixed-window rate limiter, in memory, no dependency.
 *
 * What it protects: every request to /api/chat and /mcp can start an agent run,
 * and an agent run spends tokens. On an instance without AUTH_TOKEN that is a
 * direct cost lever for anyone who can reach the port; even with a token it
 * bounds the damage of a leaked one and of a client stuck in a retry loop. The
 * same machinery brakes the browse API (whole-bundle reads) and, through
 * FailureThrottle (auth.ts), failed attempts with AUTH_TOKEN, profile keys and
 * ADMIN_TOKEN.
 *
 * Deliberately coarse: one process, one counter per client, whole windows. It
 * is a brake, not an accounting system.
 */
export interface RateLimitOptions {
  /** Requests allowed per window. 0 disables the limiter entirely. */
  limit: number;
  windowMs: number;
  /** Shown in the 429 body: how to adjust this particular limit. */
  hint?: string;
  /** The bucket a request counts against; default: the client address (clientKey). */
  key?: (req: Request, res: Response) => string;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /** Stops the background sweep (tests, shutdown). */
  stop(): void;
}

/**
 * The bucket a request counts against. IPv6 clients usually control a whole
 * /64, so counting single addresses would let one client rotate through
 * billions of buckets; IPv4-mapped addresses are folded back to IPv4.
 */
export function clientKey(req: Request): string {
  // req.ip honours "trust proxy" (TRUST_PROXY); otherwise it is the socket
  // address, which is what we want for a directly-exposed server.
  const ip = (req.ip ?? req.socket.remoteAddress ?? "unknown").toLowerCase();
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  if (!isIPv6(ip)) return ip;
  return expandIPv6(ip).slice(0, 4).join(":") + "::/64";
}

function expandIPv6(ip: string): string[] {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((group) => group.padStart(4, "0"));
}

/**
 * Per-client counters in fixed windows. Expired windows are dropped on a timer
 * rather than scanned per request, so a flood of distinct clients costs memory
 * for one window, not CPU per call.
 */
export class FixedWindows {
  private readonly windows = new Map<string, Window>();
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly windowMs: number) {
    this.sweep = setInterval(
      () => {
        const now = Date.now();
        for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
      },
      Math.max(windowMs, 1_000)
    );
    this.sweep.unref();
  }

  /** The client's current window (a fresh one if it expired). */
  current(key: string): Window {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    return window;
  }

  stop(): void {
    clearInterval(this.sweep);
  }
}

/** Seconds until the window resets, for Retry-After / RateLimit-Reset. */
export function secondsLeft(window: Window): string {
  return String(Math.max(0, Math.ceil((window.resetAt - Date.now()) / 1000)));
}

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const windows = new FixedWindows(options.windowMs);

  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    if (options.limit <= 0) {
      next();
      return;
    }
    const window = windows.current(options.key ? options.key(req, res) : clientKey(req));
    window.count++;
    const reset = secondsLeft(window);
    res.setHeader("RateLimit-Limit", String(options.limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, options.limit - window.count)));
    res.setHeader("RateLimit-Reset", reset);
    if (window.count > options.limit) {
      refuse(res, options, reset);
      return;
    }
    next();
  }) as RateLimiter;
  middleware.stop = () => windows.stop();
  return middleware;
}

export function refuse(
  res: Response,
  options: Pick<RateLimitOptions, "limit" | "windowMs" | "hint">,
  resetSeconds: string
): void {
  res.setHeader("Retry-After", resetSeconds);
  res.status(429).json({
    error:
      `rate limit exceeded: ${options.limit} requests per ${Math.round(options.windowMs / 1000)}s.` +
      (options.hint ? ` ${options.hint}` : ""),
  });
}

/**
 * Parses TRUST_PROXY into Express's "trust proxy" setting. Unset means the
 * socket address is the client — correct when nothing sits in front. Behind a
 * reverse proxy, name it (hop count, or addresses/subnets such as
 * "loopback" or "10.0.0.0/8"); "true" trusts any X-Forwarded-For and lets
 * clients pick their own rate-limit bucket, so it is accepted but discouraged.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value || value === "false") return undefined;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
