import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import {
  KnowledgeBase,
  parseDuration,
  resolveFallbackConfig,
  resolveModelConfig,
} from "@understory/core";
import { mcpRouter } from "./mcp/http.js";
import { browseRouter } from "./api/browse.js";
import { chatRouter } from "./api/chat.js";
import { bearerAuth } from "./auth.js";
import { corsDelegate, isLoopbackHost, netGuard, parseList } from "./net-guard.js";
import { rateLimit } from "./rate-limit.js";
import { startDreamer } from "./dreamer.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});

startDreamer(kb);

const app = express();

// Validate LLM config at startup — fail fast with a clear error.
try {
  const primaryConfig = resolveModelConfig();
  console.log(
    `[understory] model: ${primaryConfig.format}:${primaryConfig.model || "auto"} @ ${primaryConfig.baseURL}`
  );
  const fallbackConfig = resolveFallbackConfig();
  if (fallbackConfig) {
    console.log(
      `[understory] fallback: ${fallbackConfig.format}:${fallbackConfig.model || "auto"} @ ${fallbackConfig.baseURL}`
    );
  }
} catch (err) {
  console.error(`[understory] LLM configuration error: ${(err as Error).message}`);
  console.error("[understory] Set LLM_API_BASE_URL + LLM_API_KEY, or configure legacy env vars.");
  process.exit(1);
}

// Bind to loopback unless a public interface is explicitly requested. The
// memory is personal data and auth is optional, so "reachable from the LAN"
// must be a decision, not a default.
const host = process.env.HOST ?? "127.0.0.1";
const authToken = process.env.AUTH_TOKEN;

const guardConfig = {
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),
  allowedHosts: parseList(process.env.ALLOWED_HOSTS),
  checkHost: isLoopbackHost(host),
};

// Same-origin plus an explicit allowlist — never a blanket reflection of the
// request origin, which would let any page in the user's browser read the
// memory off an unauthenticated instance.
app.use(cors(corsDelegate(guardConfig)));
app.use(express.json({ limit: "4mb" }));

// Origin/Host validation for the two routers that touch the memory. Runs
// before auth so a hostile origin is refused whether or not a token is set.
app.use(["/mcp", "/api"], netGuard(guardConfig));

// Optional bearer auth (issue #1): protects the memory (/mcp + /api) when
// AUTH_TOKEN is set. Static web UI stays open and prompts for the token.
if (authToken) {
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
  app.use(["/mcp", "/api/chat"], rateLimit(rateLimitOptions));
  console.log(
    `[understory] rate limit: ${rateLimitOptions.limit} requests / ${Math.round(rateLimitOptions.windowMs / 1000)}s per client on /mcp and /api/chat`
  );
} else {
  console.log("[understory] rate limit: disabled (RATE_LIMIT=0)");
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

const port = Number(process.env.PORT ?? 3800);
app.listen(port, host, () => {
  console.log(
    `[understory] origin guard: same-origin` +
      (guardConfig.allowedOrigins.length ? ` + ${guardConfig.allowedOrigins.join(", ")}` : "") +
      (guardConfig.checkHost ? "; Host header restricted to loopback" : "")
  );
  if (!isLoopbackHost(host) && !authToken) {
    console.warn(
      "[understory] WARNING: bound to a non-loopback interface with AUTH_TOKEN unset — " +
        "anyone who can reach this port can read and rewrite the memory. Set AUTH_TOKEN."
    );
  }
  console.log(`understory serving bundle ${bundleRoot} on ${host}:${port} (web + /api + /mcp)`);
});
