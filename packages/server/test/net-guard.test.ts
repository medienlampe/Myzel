import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  corsDelegate,
  isAllowedHost,
  isAllowedOrigin,
  isLoopbackHost,
  netGuard,
  parseList,
  type NetGuardConfig,
} from "../src/net-guard.js";

const LOOPBACK_CONFIG: NetGuardConfig = {
  allowedOrigins: [],
  allowedHosts: [],
  hostPolicy: "loopback",
};
const PUBLIC_CONFIG: NetGuardConfig = {
  allowedOrigins: [],
  allowedHosts: [],
  hostPolicy: "public",
};

function call(
  middleware: ReturnType<typeof netGuard>,
  headers: { host?: string; origin?: string }
) {
  const req = { headers } as Request;
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();
  middleware(req, res, next);
  return { next, status, json };
}

describe("parseList", () => {
  it("splits, trims, lowercases and drops trailing slashes and blanks", () => {
    expect(parseList(" https://A.example/ , ,https://b.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("isLoopbackHost", () => {
  it("recognizes loopback authorities with and without ports", () => {
    for (const host of [
      "localhost",
      "localhost:3800",
      "127.0.0.1:3800",
      "127.5.5.5",
      "[::1]:3800",
      "::1",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("does not mistake public hosts or lookalikes for loopback", () => {
    for (const host of [
      "0.0.0.0",
      "example.com",
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "192.168.1.10",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("isAllowedOrigin", () => {
  it("accepts same-origin requests", () => {
    expect(isAllowedOrigin("http://localhost:3800", "localhost:3800", [])).toBe(true);
    // Vite dev proxy keeps the original Host, so dev stays same-origin.
    expect(isAllowedOrigin("http://localhost:5180", "localhost:5180", [])).toBe(true);
  });

  it("rejects a foreign origin — the drive-by CSRF/exfiltration case", () => {
    expect(isAllowedOrigin("https://evil.example", "localhost:3800", [])).toBe(false);
    // Rebinding: the browser believes it is same-origin with evil.example.
    expect(isAllowedOrigin("http://evil.example", "evil.example", [])).toBe(true);
    // …which is why the Host check exists; see isAllowedHost below.
  });

  it("honours the allowlist and the wildcard, and rejects opaque origins", () => {
    expect(isAllowedOrigin("https://app.example", "localhost:3800", ["https://app.example"])).toBe(
      true
    );
    expect(isAllowedOrigin("https://app.example/", "localhost:3800", ["https://app.example"])).toBe(
      true
    );
    expect(isAllowedOrigin("https://any.example", "localhost:3800", ["*"])).toBe(true);
    expect(isAllowedOrigin("null", "localhost:3800", [])).toBe(false);
  });
});

describe("isAllowedHost", () => {
  it("passes loopback, rejects a rebound attacker hostname", () => {
    expect(isAllowedHost("localhost:3800", [])).toBe(true);
    expect(isAllowedHost("evil.example", [])).toBe(false);
    expect(isAllowedHost("", [])).toBe(false);
  });

  it("honours the allowlist and the wildcard", () => {
    expect(isAllowedHost("nas.local:3800", ["nas.local"])).toBe(true);
    expect(isAllowedHost("nas.local:3800", ["nas.local:3800"])).toBe(true);
    expect(isAllowedHost("anything.example", ["*"])).toBe(true);
  });
});

describe("netGuard", () => {
  const guard = netGuard(LOOPBACK_CONFIG);

  it("lets same-origin browser requests through", () => {
    const { next, status } = call(guard, {
      host: "localhost:3800",
      origin: "http://localhost:3800",
    });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("lets origin-less clients through (curl, MCP stdio, native apps)", () => {
    const { next, status } = call(guard, { host: "localhost:3800" });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("blocks a foreign origin with 403", () => {
    const { next, status } = call(guard, {
      host: "localhost:3800",
      origin: "https://evil.example",
    });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("blocks a rebound Host header with 403", () => {
    const { next, status } = call(guard, { host: "evil.example", origin: "http://evil.example" });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("accepts IP-literal hosts on a public bind — an address cannot be rebound", () => {
    for (const host of ["192.168.1.10:3800", "10.0.0.5", "[fe80::1]:3800", "localhost:3800"]) {
      const { next, status } = call(netGuard(PUBLIC_CONFIG), { host });
      expect(next, host).toHaveBeenCalledOnce();
      expect(status, host).not.toHaveBeenCalled();
    }
  });

  it("blocks DNS rebinding on a public bind: an unlisted hostname with a matching origin", () => {
    // evil.example re-pointed at the server's LAN address: Origin and Host
    // agree, so only the Host check can tell this apart from the real UI.
    const { next, status } = call(netGuard(PUBLIC_CONFIG), {
      host: "evil.example:3800",
      origin: "http://evil.example:3800",
    });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("accepts hostnames listed in ALLOWED_HOSTS on a public bind", () => {
    const guard = netGuard({ ...PUBLIC_CONFIG, allowedHosts: ["nas.local"] });
    const { next } = call(guard, { host: "nas.local:3800", origin: "http://nas.local:3800" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("still rejects IP-literal hosts on a loopback bind", () => {
    const { next, status } = call(guard, { host: "192.168.1.10:3800" });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("still enforces the origin check on a public bind", () => {
    const { next, status } = call(netGuard(PUBLIC_CONFIG), {
      host: "192.168.1.10:3800",
      origin: "https://evil.example",
    });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("passes an explicitly allowlisted origin", () => {
    const guardWithAllowlist = netGuard({
      allowedOrigins: ["https://app.example"],
      allowedHosts: [],
      hostPolicy: "loopback",
    });
    const { next } = call(guardWithAllowlist, {
      host: "localhost:3800",
      origin: "https://app.example",
    });
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("corsDelegate", () => {
  const delegate = corsDelegate(LOOPBACK_CONFIG);

  function options(headers: { host?: string; origin?: string }) {
    const cb = vi.fn();
    delegate({ headers } as Request, cb);
    return cb.mock.calls[0][1];
  }

  it("reflects a same-origin request and exposes Mcp-Session-Id", () => {
    const opts = options({ host: "localhost:3800", origin: "http://localhost:3800" });
    expect(opts.origin).toBe("http://localhost:3800");
    expect(opts.exposedHeaders).toContain("Mcp-Session-Id");
  });

  it("refuses to reflect a foreign origin, so its preflight fails", () => {
    expect(options({ host: "localhost:3800", origin: "https://evil.example" }).origin).toBe(false);
  });

  it("emits no allow-origin when the request carries none", () => {
    expect(options({ host: "localhost:3800" }).origin).toBe(false);
  });
});
