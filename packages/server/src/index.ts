import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { KnowledgeBase, parseDuration } from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { bearerAuth } from "./auth.js";
import { corsDelegate, isLoopbackHost, netGuard, parseList } from "./net-guard.js";
import { parseTrustProxy, rateLimit } from "./rate-limit.js";
import { LIMITS } from "./limits.js";
import { checkModelConfig } from "./startup.js";
import { startDreamer } from "./dreamer.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

const stopDreamer = startDreamer(kb);

const app = express();
app.disable("x-powered-by");

// Behind a reverse proxy every request arrives from the proxy's address; the
// rate limiter would then put all clients in one bucket. TRUST_PROXY names
// the proxy so req.ip becomes the real client.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  app.set("trust proxy", trustProxy);
  console.log(`[understory] trust proxy: ${String(trustProxy)}`);
  if (trustProxy === true) {
    console.warn(
      "[understory] WARNING: TRUST_PROXY=true trusts any X-Forwarded-For header — clients can " +
        "pick their own rate-limit bucket. Name the proxy instead (e.g. TRUST_PROXY=loopback or 1)."
    );
  }
}

// Baseline headers for the UI and API. Shiki's highlighted code carries inline
// `style` attributes, hence 'unsafe-inline' for styles only; scripts stay
// same-origin. frame-ancestors keeps the UI out of other sites' iframes.
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; connect-src 'self'; object-src 'none'; " +
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

checkModelConfig((line) => console.log(line));

// Bind to loopback unless a public interface is explicitly requested. The
// memory is personal data and auth is optional, so "reachable from the LAN"
// must be a decision, not a default.
const host = process.env.HOST ?? "127.0.0.1";
const authToken = process.env.AUTH_TOKEN;

const guardConfig = {
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),
  allowedHosts: parseList(process.env.ALLOWED_HOSTS),
  hostPolicy: isLoopbackHost(host) ? ("loopback" as const) : ("public" as const),
};

// Liveness for container health checks. Outside /api and /mcp on purpose: it
// needs no token, touches no memory, and reveals nothing but "up".
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Same-origin plus an explicit allowlist — never a blanket reflection of the
// request origin, which would let any page in the user's browser read the
// memory off an unauthenticated instance.
app.use(cors(corsDelegate(guardConfig)));
app.use(express.json({ limit: LIMITS.jsonBody }));

// Origin/Host validation for the two routers that touch the memory. Runs
// before auth so a hostile origin is refused whether or not a token is set.
app.use(["/mcp", "/api"], netGuard(guardConfig));

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
if (authToken) {
  // Failed attempts are braked before the token is even compared, so the
  // token cannot be guessed at line rate. Successful requests don't count.
  app.use(
    ["/mcp", "/api"],
    rateLimit({
      limit: 20,
      windowMs: 15 * 60_000,
      countIf: (res) => res.statusCode === 401,
      hint: "Too many failed authentication attempts.",
    })
  );
  app.use(["/mcp", "/api"], bearerAuth(authToken));
  console.log("[understory] auth: bearer token required for /mcp and /api");
} else {
  console.log("[understory] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)");
}

// Both routers below can start an agent run, which costs tokens — brake them.
// A malformed RATE_LIMIT must not silently disable the brake — only an
// explicit 0 does that.
const rateLimitRaw = Number(process.env.RATE_LIMIT);
const rateLimitOptions = {
  limit: Number.isFinite(rateLimitRaw) && rateLimitRaw >= 0 ? rateLimitRaw : 60,
  windowMs: parseDuration(process.env.RATE_LIMIT_WINDOW) ?? 60_000,
};
if (rateLimitOptions.limit > 0) {
  app.use(
    ["/mcp", "/api/chat"],
    rateLimit({ ...rateLimitOptions, hint: "Raise RATE_LIMIT, or set it to 0 to disable." })
  );
  console.log(
    `[understory] rate limit: ${rateLimitOptions.limit} requests / ${Math.round(rateLimitOptions.windowMs / 1000)}s per client on /mcp and /api/chat`
  );
} else {
  console.log("[understory] rate limit: disabled (RATE_LIMIT=0)");
}

// The browse API never calls a model, but each request reads the whole bundle;
// a looser brake keeps a scripted client from pinning the disk.
const browseLimitRaw = Number(process.env.RATE_LIMIT_BROWSE);
const browseLimit = Number.isFinite(browseLimitRaw) && browseLimitRaw >= 0 ? browseLimitRaw : 600;
if (browseLimit > 0) {
  app.use(
    "/api",
    rateLimit({
      limit: browseLimit,
      windowMs: rateLimitOptions.windowMs,
      hint: "Raise RATE_LIMIT_BROWSE, or set it to 0 to disable.",
    })
  );
}

app.use("/mcp", mcpRouter(kb));
app.use("/api", browseRouter(kb));
app.use("/api", chatRouter(kb));

// Serve the built web UI in production (single container), with SPA fallback.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/(api|mcp)).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

// Last resort: log the error, but never send a stack trace (absolute paths,
// library internals) to the client.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[understory] unhandled request error:", err);
    const status = (err as { status?: unknown }).status;
    res
      .status(typeof status === "number" && status >= 400 && status < 600 ? status : 500)
      .json({ error: "internal error" });
  }
);

const port = Number(process.env.PORT ?? 3800);
const server = app.listen(port, host, () => {
  console.log(
    `[understory] origin guard: same-origin` +
      (guardConfig.allowedOrigins.length ? ` + ${guardConfig.allowedOrigins.join(", ")}` : "") +
      `; Host header restricted to ${
        guardConfig.hostPolicy === "loopback" ? "loopback" : "loopback names and IP addresses"
      }` +
      (guardConfig.allowedHosts.length ? ` + ${guardConfig.allowedHosts.join(", ")}` : "")
  );
  if (!isLoopbackHost(host) && !authToken) {
    console.warn(
      "[understory] WARNING: bound to a non-loopback interface with AUTH_TOKEN unset — " +
        "anyone who can reach this port can read and rewrite the memory. Set AUTH_TOKEN."
    );
  }
  console.log(`understory serving bundle ${bundleRoot} on ${host}:${port} (web + /api + /mcp)`);
});

/**
 * Graceful shutdown: `docker stop` sends SIGTERM, then SIGKILL after 10s. Stop
 * accepting requests and let the mutation queue drain, so a concept is never
 * left written without its index.md, log.md entry or commit.
 */
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[understory] ${signal}: finishing pending writes, then exiting`);
  stopDreamer();
  server.close();
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    console.error("[understory] shutdown timed out with writes pending — exiting anyway");
    process.exit(1);
  }, 8_000);
  deadline.unref();
  kb.idle().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
