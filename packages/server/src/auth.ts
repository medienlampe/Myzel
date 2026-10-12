import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientKey, FixedWindows, refuse, secondsLeft } from "./rate-limit.js";

/**
 * Optional bearer-token auth for /mcp and /api (issue #1).
 * AUTH_TOKEN unset → no auth (localhost/homelab default).
 * AUTH_TOKEN set   → requests must carry `Authorization: Bearer <token>`.
 * The static web UI stays open; it prompts for the token and sends it on
 * its API calls. The stdio MCP transport is unaffected (local process).
 */
export interface FailureLimit {
  /** Failed attempts per client before it is refused for the rest of the window. */
  limit: number;
  windowMs: number;
}

export interface BearerAuth {
  (req: Request, res: Response, next: NextFunction): void;
  /** Stops the failure counter's background sweep (tests). */
  stop(): void;
}

export function bearerAuth(
  token: string,
  failures: FailureLimit = { limit: 20, windowMs: 15 * 60_000 }
): BearerAuth {
  const expected = sha256(token);
  // Only failures count, and they are counted in the same synchronous step
  // that detects them: a burst of parallel guesses cannot overshoot the
  // budget, and valid requests — however long they run — never use it up.
  const attempts = new FixedWindows(failures.windowMs);
  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    const window = attempts.current(clientKey(req));
    if (window.count >= failures.limit) {
      refuse(
        res,
        { ...failures, hint: "Too many failed authentication attempts." },
        secondsLeft(window)
      );
      return;
    }
    // The scheme name is case-insensitive (RFC 7235); the token is not.
    const match = /^bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const provided = match?.[1] ?? "";
    // Hash both sides so timingSafeEqual gets equal-length buffers.
    if (provided && timingSafeEqual(sha256(provided), expected)) {
      next();
      return;
    }
    window.count++;
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="myzel"')
      .json({ error: "unauthorized: set Authorization: Bearer <AUTH_TOKEN>" });
  }) as BearerAuth;
  middleware.stop = () => attempts.stop();
  return middleware;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
