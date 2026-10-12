import { afterEach, describe, expect, it } from "vitest";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { clientKey, parseTrustProxy, rateLimit, type RateLimiter } from "../src/rate-limit.js";
import { bearerAuth, type BearerAuth } from "../src/auth.js";

let server: Server | undefined;
let limiter: RateLimiter | undefined;
let auth: BearerAuth | undefined;

afterEach(() => {
  server?.close();
  limiter?.stop();
  auth?.stop();
  server = limiter = auth = undefined;
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

  it("does nothing at limit 0", async () => {
    limiter = rateLimit({ limit: 0, windowMs: 60_000 });
    const base = await serve((app) => app.get("/", limiter!, (_req, res) => res.send("ok")));
    expect(await statuses(base, 3)).toEqual([200, 200, 200]);
  });
});

describe("bearerAuth failure throttle", () => {
  const good = { headers: { authorization: "Bearer right" } };

  it("refuses a client after too many failures, even with the right token", async () => {
    auth = bearerAuth("right", { limit: 2, windowMs: 60_000 });
    const base = await serve((app) => app.get("/", auth!, (_req, res) => res.send("ok")));
    expect(await statuses(base, 5, good)).toEqual([200, 200, 200, 200, 200]); // never counted
    expect(await statuses(base, 3)).toEqual([401, 401, 429]);
    expect(await statuses(base, 1, good)).toEqual([429]);
  });

  it("caps a burst of parallel wrong guesses", async () => {
    auth = bearerAuth("right", { limit: 3, windowMs: 60_000 });
    const base = await serve((app) => app.get("/", auth!, (_req, res) => res.send("ok")));
    const results = await Promise.all(Array.from({ length: 10 }, () => fetch(base)));
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it("does not lock out valid clients whose requests are still running", async () => {
    auth = bearerAuth("right", { limit: 3, windowMs: 60_000 });
    const pending: Array<() => void> = [];
    const base = await serve((app) =>
      app.get("/", auth!, (_req, res) => {
        pending.push(() => res.send("done")); // held open, like a long agent run
      })
    );
    const slow = Array.from({ length: 5 }, () => fetch(base, good));
    while (pending.length < 5) await new Promise((r) => setTimeout(r, 10));
    const another = fetch(base, good);
    while (pending.length < 6) await new Promise((r) => setTimeout(r, 10));
    pending.forEach((done) => done());
    expect((await Promise.all([...slow, another])).map((r) => r.status)).toEqual(
      Array(6).fill(200)
    );
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
