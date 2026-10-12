import type { NextFunction, Request, Response } from "express";
import type { KnowledgeBase } from "@myzel/core";
import {
  bearerAuth,
  bearerToken,
  DEFAULT_FAILURE_LIMIT,
  FailureThrottle,
  unauthorized,
  type FailureLimit,
} from "./auth.js";
import { ProfileError, type ProfileRegistry } from "./profiles.js";

/** The memory a request was resolved to. `profile` is null in single-memory mode. */
export interface ResolvedMemory {
  kb: KnowledgeBase;
  profile: string | null;
}

/**
 * Where requests get their memory from. Two implementations: one fixed bundle
 * (BUNDLE_ROOT), or one bundle per API key (PROFILES_ROOT).
 * (Ported from upstream understory.)
 */
export interface MemoryHost {
  readonly mode: "single" | "profiles";
  /** Authenticate the request and attach its memory as res.locals.memory, or answer 401/429. */
  authenticate(req: Request, res: Response, next: NextFunction): void;
  /** Every hosted memory — for dreaming. */
  memories(): Promise<ResolvedMemory[]>;
  /**
   * Wait for the writes of every memory this process opened (shutdown) —
   * without re-reading anything that could fail at that moment.
   */
  drain(): Promise<void>;
  /** Stops background timers (tests). */
  stop(): void;
}

export function memoryOf(res: Response): ResolvedMemory {
  return res.locals.memory as ResolvedMemory;
}

/**
 * One bundle for everyone. AUTH_TOKEN unset → open (localhost default); set →
 * requests must carry `Authorization: Bearer <token>`.
 */
export function singleMemoryHost(
  kb: KnowledgeBase,
  authToken: string | undefined,
  failures: FailureLimit = DEFAULT_FAILURE_LIMIT
): MemoryHost {
  const memory: ResolvedMemory = { kb, profile: null };
  const guard = authToken ? bearerAuth(authToken, failures) : null;
  return {
    mode: "single",
    authenticate(req, res, next) {
      const attach = () => {
        res.locals.memory = memory;
        next();
      };
      if (guard) guard(req, res, attach);
      else attach();
    },
    async memories() {
      return [memory];
    },
    drain() {
      return kb.idle();
    },
    stop() {
      guard?.stop();
    },
  };
}

/**
 * One bundle per profile. The bearer key is the only selector: it both
 * authenticates the caller and decides which memory they reach, so there is
 * no request parameter that could point one profile at another's data.
 */
export function profileMemoryHost(
  registry: ProfileRegistry,
  failures: FailureLimit = DEFAULT_FAILURE_LIMIT
): MemoryHost {
  // Profile keys are 192 random bits — unguessable — but a scripted client
  // trying keys still costs a registry check per request: same brake as above.
  const throttle = new FailureThrottle(failures);
  return {
    mode: "profiles",
    authenticate(req, res, next) {
      const unauthenticated = () =>
        unauthorized(res, "profiles", "unauthorized: set Authorization: Bearer <profile API key>");
      const key = bearerToken(req);
      // No key at all is not a guess: don't count it (page loads before a key
      // is entered would otherwise lock the client out).
      if (!key) {
        unauthenticated();
        return;
      }
      const refund = throttle.attempt(req, res);
      if (!refund) return;
      registry
        .resolve(key)
        .then((resolved) => {
          if (!resolved) {
            unauthenticated();
            return;
          }
          refund();
          res.locals.memory = { kb: resolved.kb, profile: resolved.name } satisfies ResolvedMemory;
          next();
        })
        .catch((err: unknown) => {
          refund(); // the server failed, not the client
          // An unreadable registry authenticates nobody.
          console.error(`[myzel] ${(err as Error).message}`);
          const status = err instanceof ProfileError ? 503 : 500;
          res.status(status).json({ error: "profile registry unavailable" });
        });
    },
    async memories() {
      return (await registry.memories()).map(({ name, kb }) => ({ kb, profile: name }));
    },
    drain() {
      return registry.drain();
    },
    stop() {
      throttle.stop();
    },
  };
}
