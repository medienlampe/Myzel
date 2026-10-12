import { isIP } from "node:net";
import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

/**
 * Network-level guards for /mcp and /api.
 *
 * The threat these close: Myzel holds a personal memory and, by default,
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
 * - The Host header is always validated (DNS-rebinding guard, see hostPolicy).
 */
export interface NetGuardConfig {
  /** Origins allowed beyond same-origin. "*" disables the origin check. */
  allowedOrigins: string[];
  /** Host header hostnames allowed beyond loopback. "*" disables the host check. */
  allowedHosts: string[];
  /**
   * Which Host headers pass besides ALLOWED_HOSTS. DNS rebinding works by
   * re-pointing an attacker-controlled *hostname* at our address (127.0.0.1,
   * or a LAN IP when bound publicly), after which the browser treats the
   * attacker's page as same-origin. An IP-literal Host cannot be rebound, so:
   * - "loopback": only loopback names (the server is bound to loopback);
   * - "public":   loopback names and any IP literal, so the server stays
   *               reachable by address on a deliberate public bind, while
   *               every other hostname must be listed in ALLOWED_HOSTS.
   */
  hostPolicy: "loopback" | "public";
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

/** Is this authority an IP literal (v4, or v6 with or without brackets)? */
function isIpLiteralHost(authority: string): boolean {
  return isIP(hostname(authority).replace(/^\[(.*)\]$/, "$1")) !== 0;
}

/** Is this authority (or bind address) a loopback one? */
export function isLoopbackHost(authority: string): boolean {
  return LOOPBACK.test(hostname(authority));
}

export function isAllowedHost(
  hostHeader: string,
  allowed: string[],
  policy: NetGuardConfig["hostPolicy"] = "loopback"
): boolean {
  if (allowed.includes("*")) return true;
  if (!hostHeader) return false;
  if (isLoopbackHost(hostHeader)) return true;
  if (policy === "public" && isIpLiteralHost(hostHeader)) return true;
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
    if (!isAllowedHost(host, config.allowedHosts, config.hostPolicy)) {
      res.status(403).json({
        error:
          `forbidden: unexpected Host header "${host}" (DNS-rebinding guard). ` +
          `Reach the server by IP address or localhost, or add the hostname to ALLOWED_HOSTS.`,
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
