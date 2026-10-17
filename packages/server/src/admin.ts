import express, { type Router } from "express";
import { bearerAuth, DEFAULT_FAILURE_LIMIT, type FailureLimit } from "./auth.js";
import { SettingsError, type SettingsStore } from "./settings.js";

export interface AdminRouter extends Router {
  /** Stops the failure counter's background sweep (tests). */
  stopThrottle(): void;
}

/**
 * Server administration over HTTP, guarded by ADMIN_TOKEN — a credential
 * separate from every profile key and from AUTH_TOKEN. It serves the settings
 * the UI may change; it cannot read or write any memory, and a memory's key
 * cannot reach /admin. Profiles are managed with the profiles CLI only
 * (`docker compose exec myzel node server/dist/profiles-cli.js …`): Myzel serves you and your team, so remote
 * provisioning would be attack surface with no one to use it.
 */
export function adminRouter(
  adminToken: string,
  failures: FailureLimit = DEFAULT_FAILURE_LIMIT,
  settings?: SettingsStore
): AdminRouter {
  const router = express.Router() as AdminRouter;
  // Same check and failure throttle as AUTH_TOKEN, with its own budget.
  const guard = bearerAuth(adminToken, failures, {
    mode: "admin",
    message: "unauthorized: set Authorization: Bearer <ADMIN_TOKEN>",
  });
  router.stopThrottle = () => guard.stop();
  router.use(guard);

  if (settings) {
    router.get("/settings", (_req, res) => {
      res.json({ writable: settings.writable, settings: settings.describe() });
    });
    router.put("/settings", async (req, res) => {
      const changes: unknown = req.body?.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        res.status(400).json({ error: "expected { changes: { KEY: value | null } }" });
        return;
      }
      try {
        const result = await settings.update(changes as Record<string, unknown>);
        // Names only: values may be secrets.
        const changed = [...result.applied, ...result.restart];
        if (changed.length) console.log(`[myzel] settings changed: ${changed.join(", ")}`);
        res.json({ ...result, settings: settings.describe() });
      } catch (err) {
        if (!(err instanceof SettingsError)) throw err;
        res.status(err.status).json({ error: err.message });
      }
    });
  }

  return router;
}
