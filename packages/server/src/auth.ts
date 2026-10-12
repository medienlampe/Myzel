import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientKey, FixedWindows, refuse, secondsLeft } from "./rate-limit.js";

/**
 * Bearer-token authentication for /mcp, /api and /admin.
 * - Single-memory mode: AUTH_TOKEN unset → open (localhost default); set →
 *   requests must carry `Authorization: Bearer <token>`.
 * - Profile mode and /admin use the same building blocks (see host.ts, admin.ts).
 * The static web UI stays open; it prompts for the token and sends it on its
 * API calls. The stdio MCP transport is unaffected (local process).
 */

/** The token from an `Authorization: Bearer …` header ("" when absent). */
export function bearerToken(req: Request): string {
  // The scheme name is case-insensitive (RFC 7235); the token is not.
  return /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? "";
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison; hashing first gives timingSafeEqual equal-length input. */
export function tokenMatches(provided: string, expected: string): boolean {
  return provided !== "" && timingSafeEqual(sha256(provided), sha256(expected));
}

export interface FailureLimit {
  /** Failed attempts per client before it is refused for the rest of the window. */
  limit: number;
  windowMs: number;
}

export const DEFAULT_FAILURE_LIMIT: FailureLimit = { limit: 20, windowMs: 15 * 60_000 };

/**
 * Brake on credential guessing. An attempt is counted when it arrives —
 * synchronously, together with the "budget spent?" check — and refunded once
 * it turns out to be valid. So a burst of parallel guesses cannot overshoot
 * the budget, even when checking a key is asynchronous, while valid requests
 * (however long they then run) never use it up.
 */
export class FailureThrottle {
  private readonly attempts: FixedWindows;

  constructor(private readonly failures: FailureLimit = DEFAULT_FAILURE_LIMIT) {
    this.attempts = new FixedWindows(failures.windowMs);
  }

  /**
   * Count an attempt for this request's client. Returns the refund to call when
   * the credential is valid — or null after answering 429 because the client's
   * budget is spent (the credential is then not even checked).
   */
  attempt(req: Request, res: Response): (() => void) | null {
    const window = this.attempts.current(clientKey(req));
    if (window.count >= this.failures.limit) {
      refuse(
        res,
        { ...this.failures, hint: "Too many failed authentication attempts." },
        secondsLeft(window)
      );
      return null;
    }
    window.count++;
    return () => {
      window.count--;
    };
  }

  stop(): void {
    this.attempts.stop();
  }
}

/** 401 with the auth mode, so the web UI can ask for the right kind of key. */
export function unauthorized(
  res: Response,
  mode: "single" | "profiles" | "admin",
  message: string
): void {
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer realm="${mode === "admin" ? "myzel-admin" : "myzel"}"`)
    .json({ error: message, mode });
}

export interface BearerAuth {
  (req: Request, res: Response, next: NextFunction): void;
  /** Stops the failure counter's background sweep (tests). */
  stop(): void;
}

/**
 * Single-token auth (AUTH_TOKEN, ADMIN_TOKEN), with the failure throttle in
 * front. A request that presents no token at all is not a guess and is not
 * counted — otherwise a few page loads before the key is entered would lock
 * the client out.
 */
export function bearerAuth(
  token: string,
  failures: FailureLimit = DEFAULT_FAILURE_LIMIT,
  realm: { mode: "single" | "admin"; message: string } = {
    mode: "single",
    message: "unauthorized: set Authorization: Bearer <AUTH_TOKEN>",
  }
): BearerAuth {
  const throttle = new FailureThrottle(failures);
  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    const presented = bearerToken(req);
    if (!presented) {
      unauthorized(res, realm.mode, realm.message);
      return;
    }
    const refund = throttle.attempt(req, res);
    if (!refund) return;
    if (tokenMatches(presented, token)) {
      refund();
      next();
      return;
    }
    unauthorized(res, realm.mode, realm.message);
  }) as BearerAuth;
  middleware.stop = () => throttle.stop();
  return middleware;
}
