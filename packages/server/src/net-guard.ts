import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

/**
 * Network-level guards for /mcp and /api.
 *
 * The threat these close: understory holds a personal memory and, by default,
 * needs no credentials. Without an Origin check, any web page the user happens
 * to visit can POST to http://localhost:3800/api/chat or /mcp from their
 * browser — reading and rewriting the whole memory. The MCP specification
 * requires local servers to validate Origin for exactly this reason.
 *
 * Policy:
 * - Same-origin requests always pass (Origin authority === Host header).
 * - Extra origins/hosts come from ALLOWED_ORIGINS / ALLOWED_HOSTS; "*" opts out.
 * - Requests without an Origin header (curl, MCP stdio, native clients) pass the
 *   origin check — browsers always send Origin on cross-origin and on POST, and
 *   a non-browser client is not subject to the confused-deputy problem.
 * - Host validation only runs on a loopback bind (see checkHost below).
 */
export interface NetGuardConfig {
  /** Origins allowed beyond same-origin. "*" disables the origin check. */
  allowedOrigins: string[];
  /** Host header hostnames allowed beyond loopback. "*" disables the host check. */
  allowedHosts: string[];
  /**
   * Whether to validate the Host header. DNS rebinding only threatens a
   * loopback-bound server (the attacker re-points their own hostname at
   * 127.0.0.1 and the browser then treats us as same-origin). On a deliberate
   * public bind we cannot know the legitimate hostnames, so the guard steps
   * aside there and AUTH_TOKEN carries the weight instead.
   */
  checkHost: boolean;
}

/** Split a comma-separated env var into trimmed, lowercased entries. */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Hostname of an authority, port stripped. Keeps IPv6 brackets: "[::1]:3800" → "[::1]". */
function hostname(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  if (colon === -1) return value;
  // A bare IPv6 literal ("::1") has several colons and no port; only a single
  // colon separates a hostname from its port.
  if (value.indexOf(":", colon + 1) !== -1) return value;
  return value.slice(0, colon);
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/;

/** Is this authority (or bind address) a loopback one? */
export function isLoopbackHost(authority: string): boolean {
  return LOOPBACK.test(hostname(authority));
}

export function isAllowedHost(hostHeader: string, allowed: string[]): boolean {
  if (allowed.includes("*")) return true;
  if (!hostHeader) return false;
  if (isLoopbackHost(hostHeader)) return true;
  const authority = hostHeader.trim().toLowerCase();
  return allowed.includes(authority) || allowed.includes(hostname(authority));
}

export function isAllowedOrigin(origin: string, hostHeader: string, allowed: string[]): boolean {
  if (allowed.includes("*")) return true;
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (allowed.includes(normalized)) return true;
  // Same-origin: the Origin's authority matches the one the request was sent to.
  // "null" (sandboxed iframe, file://) never parses to a matching authority.
  try {
    return new URL(normalized).host === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** Express middleware enforcing the policy above. Mount on /mcp and /api. */
export function netGuard(config: NetGuardConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = String(req.headers.host ?? "");
    if (config.checkHost && !isAllowedHost(host, config.allowedHosts)) {
      res.status(403).json({
        error:
          `forbidden: unexpected Host header "${host}" (DNS-rebinding guard). ` +
          `Reach the server on localhost, or add the hostname to ALLOWED_HOSTS.`,
      });
      return;
    }
    const origin = req.headers.origin;
    if (
      typeof origin === "string" &&
      origin &&
      !isAllowedOrigin(origin, host, config.allowedOrigins)
    ) {
      res.status(403).json({
        error: `forbidden: origin "${origin}" is not allowed. Add it to ALLOWED_ORIGINS.`,
      });
      return;
    }
    next();
  };
}

const CORS_BASE: CorsOptions = {
  exposedHeaders: ["Mcp-Session-Id"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Authorization",
    "Mcp-Session-Id",
    "Mcp-Protocol-Version",
    "Last-Event-ID",
  ],
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
};

/**
 * CORS delegate mirroring the same allowlist, so a disallowed origin also fails
 * its preflight instead of merely being rejected after the fact.
 */
export function corsDelegate(config: NetGuardConfig) {
  return (req: Request, callback: (err: Error | null, options: CorsOptions) => void): void => {
    const origin = req.headers.origin;
    const host = String(req.headers.host ?? "");
    const allow =
      typeof origin === "string" &&
      origin !== "" &&
      isAllowedOrigin(origin, host, config.allowedOrigins);
    callback(null, { ...CORS_BASE, origin: allow ? origin : false });
  };
}
