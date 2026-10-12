import { afterEach, describe, expect, it } from "vitest";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { clientKey, parseTrustProxy, rateLimit, type RateLimiter } from "../src/rate-limit.js";

let server: Server | undefined;
let limiter: RateLimiter | undefined;

afterEach(() => {
  server?.close();
  limiter?.stop();
  server = limiter = undefined;
});

async function serve(build: (app: express.Express) => void): Promise<string> {
  const app = express();
  build(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const statuses = async (url: string, n: number, init?: RequestInit) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fetch(url, init)).status);
  return out;
};

describe("rateLimit", () => {
  it("refuses requests beyond the limit with 429 and Retry-After", async () => {
    limiter = rateLimit({ limit: 2, windowMs: 60_000 });
    const base = await serve((app) => app.get("/", limiter!, (_req, res) => res.send("ok")));
    expect(await statuses(base, 3)).toEqual([200, 200, 429]);
    const res = await fetch(base);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("with countIf, counts only matching responses — throttling failed logins", async () => {
    limiter = rateLimit({ limit: 2, windowMs: 60_000, countIf: (res) => res.statusCode === 401 });
    const base = await serve((app) =>
      app.get("/", limiter!, (req, res) => {
        res.status(req.headers.authorization === "good" ? 200 : 401).end();
      })
    );
    // Successful requests never use up the budget…
    expect(await statuses(base, 5, { headers: { authorization: "good" } })).toEqual([
      200, 200, 200, 200, 200,
    ]);
    // …failures do, and once spent even a correct token waits out the window.
    expect(await statuses(base, 3)).toEqual([401, 401, 429]);
    expect(await statuses(base, 1, { headers: { authorization: "good" } })).toEqual([429]);
  });

  it("does nothing at limit 0", async () => {
    limiter = rateLimit({ limit: 0, windowMs: 60_000 });
    const base = await serve((app) => app.get("/", limiter!, (_req, res) => res.send("ok")));
    expect(await statuses(base, 3)).toEqual([200, 200, 200]);
  });
});

describe("clientKey", () => {
  const key = (ip: string) => clientKey({ ip, socket: {} } as unknown as Request);

  it("groups IPv6 clients by /64", () => {
    expect(key("2001:db8:1:2::1")).toBe(key("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
  });

  it("folds IPv4-mapped addresses back to IPv4 and keeps IPv4 as is", () => {
    expect(key("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(key("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("parseTrustProxy", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["false", undefined],
    ["true", true],
    ["1", 1],
    ["loopback, 10.0.0.0/8", "loopback, 10.0.0.0/8"],
  ])("%s → %s", (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });
});
