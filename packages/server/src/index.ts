import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeBase, parseDuration } from "@myzel/core";
import { buildApp } from "./app.js";
import { adminRouter } from "./admin.js";
import { profileMemoryHost, singleMemoryHost, type MemoryHost } from "./host.js";
import { isLoopbackHost, parseList } from "./net-guard.js";
import { parseTrustProxy } from "./rate-limit.js";
import { envCount } from "./env.js";
import { ProfileRegistry } from "./profiles.js";
import { checkModelConfig, requireGitReady } from "./startup.js";
import { startDreamer } from "./dreamer.js";

/** Below Docker's 10s grace period between SIGTERM and SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 8_000;

// PROFILES_ROOT takes precedence: the Docker image always sets BUNDLE_ROOT.
const bundleRoot = process.env.BUNDLE_ROOT;
const profilesRoot = process.env.PROFILES_ROOT;
if (!profilesRoot && !bundleRoot) {
  console.error("BUNDLE_ROOT (one memory) or PROFILES_ROOT (one memory per profile) is required");
  process.exit(1);
}
const gitAutocommit = process.env.GIT_AUTOCOMMIT === "true";

checkModelConfig((line) => console.log(line));

// Choose how requests find their memory: one bundle, or one per profile key.
let memoryHost: MemoryHost;
let admin: ReturnType<typeof adminRouter> | undefined;
let serving: string;
let authEnabled: boolean;
try {
  if (profilesRoot) {
    const registry = new ProfileRegistry(profilesRoot, { gitAutocommit });
    const existing = await registry.memories();
    if (gitAutocommit) {
      for (const { name, kb } of existing) await requireGitReady(kb, `profile "${name}"`);
    }
    memoryHost = profileMemoryHost(registry);
    serving = `${existing.length} profile(s) from ${registry.root}`;
    authEnabled = true;
    console.log("[myzel] auth: a profile API key is required for /mcp and /api");
    if (process.env.AUTH_TOKEN) {
      console.warn("[myzel] AUTH_TOKEN is ignored in profile mode — each profile has its own key");
    }
    const adminToken = process.env.ADMIN_TOKEN;
    if (adminToken) {
      admin = adminRouter(registry, adminToken, async (name) => {
        if (!gitAutocommit) return;
        const created = (await registry.memories()).find((m) => m.name === name);
        if (created) await requireGitReady(created.kb, `profile "${name}"`);
      });
      console.log("[myzel] admin: profile management enabled at /admin (ADMIN_TOKEN)");
    } else {
      console.log("[myzel] admin: /admin disabled (set ADMIN_TOKEN, or use the profiles CLI)");
    }
  } else {
    const kb = new KnowledgeBase(bundleRoot!, { gitAutocommit });
    if (gitAutocommit) await requireGitReady(kb, "the bundle");
    const authToken = process.env.AUTH_TOKEN;
    memoryHost = singleMemoryHost(kb, authToken);
    serving = `bundle ${bundleRoot}`;
    authEnabled = Boolean(authToken);
    console.log(
      authToken
        ? "[myzel] auth: bearer token required for /mcp and /api"
        : "[myzel] auth: disabled (set AUTH_TOKEN to protect /mcp and /api)"
    );
  }
} catch (err) {
  console.error(`[myzel] ${(err as Error).message}`);
  process.exit(1);
}
if (gitAutocommit) console.log("[myzel] git autocommit: enabled");

const stopDreamer = startDreamer(async () =>
  (await memoryHost.memories()).map(({ kb, profile }) => ({ kb, label: profile }))
);

// Bind to loopback unless a public interface is explicitly requested. The
// memory is personal data and auth is optional, so "reachable from the LAN"
// must be a decision, not a default.
const host = process.env.HOST ?? "127.0.0.1";
const guard = {
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),
  allowedHosts: parseList(process.env.ALLOWED_HOSTS),
  hostPolicy: isLoopbackHost(host) ? ("loopback" as const) : ("public" as const),
};

// Behind a reverse proxy every request arrives from the proxy's address; the
// rate limiter would then put all clients in one bucket. TRUST_PROXY names the
// proxy so req.ip becomes the real client.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  console.log(`[myzel] trust proxy: ${String(trustProxy)}`);
  if (trustProxy === true) {
    console.warn(
      "[myzel] WARNING: TRUST_PROXY=true trusts any X-Forwarded-For header — clients can " +
        "pick their own rate-limit bucket. Name the proxy instead (e.g. TRUST_PROXY=loopback or 1)."
    );
  }
}

// A blank or malformed RATE_LIMIT must not silently disable the brake — only
// an explicit 0 does that (envCount).
const rateLimit = {
  limit: envCount(process.env.RATE_LIMIT, 60),
  windowMs: parseDuration(process.env.RATE_LIMIT_WINDOW) ?? 60_000,
};
console.log(
  rateLimit.limit > 0
    ? `[myzel] rate limit: ${rateLimit.limit} requests / ${Math.round(rateLimit.windowMs / 1000)}s per client on /mcp and /api/chat`
    : "[myzel] rate limit: disabled (RATE_LIMIT=0)"
);

const { app } = buildApp(memoryHost, {
  guard,
  trustProxy,
  rateLimit,
  browseLimit: envCount(process.env.RATE_LIMIT_BROWSE, 600),
  webDist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist"),
  admin,
});

const port = envCount(process.env.PORT, 3800);
const server = app.listen(port, host, () => {
  console.log(
    `[myzel] origin guard: same-origin` +
      (guard.allowedOrigins.length ? ` + ${guard.allowedOrigins.join(", ")}` : "") +
      `; Host header restricted to ${
        guard.hostPolicy === "loopback" ? "loopback" : "loopback names and IP addresses"
      }` +
      (guard.allowedHosts.length ? ` + ${guard.allowedHosts.join(", ")}` : "")
  );
  if (!isLoopbackHost(host) && !authEnabled) {
    console.warn(
      "[myzel] WARNING: bound to a non-loopback interface with AUTH_TOKEN unset — " +
        "anyone who can reach this port can read and rewrite the memory. Set AUTH_TOKEN."
    );
  }
  console.log(`Myzel serving ${serving} on ${host}:${port} (web + /api + /mcp)`);
});

/**
 * Graceful shutdown: `docker stop` sends SIGTERM, then SIGKILL after 10s. Stop
 * accepting requests, let running requests finish (an agent run may still be
 * writing), then let every memory's mutation queue drain, so a concept is never
 * left written without its index.md, log.md entry or commit. A run that
 * outlasts the deadline is cut off: every file it wrote is complete (writes are
 * atomic), but its last mutation may lack the index, log entry or commit.
 */
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[myzel] ${signal}: finishing pending writes, then exiting`);
  stopDreamer();
  const requestsDone = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const deadline = setTimeout(() => {
    console.error("[myzel] shutdown timed out with requests or writes pending — exiting anyway");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  requestsDone
    .then(() => memoryHost.drain())
    .then(
      () => process.exit(0),
      () => process.exit(1)
    );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
