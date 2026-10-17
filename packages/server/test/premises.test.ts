import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearHotMemory, clearQueryCache, KnowledgeBase, TraceStore } from "@myzel/core";
import { listen } from "./support/serve.js";
import { buildApp, type App } from "../src/app.js";
import { profileMemoryHost, singleMemoryHost, type MemoryHost } from "../src/host.js";
import { browseRouter } from "../src/api/browse.js";
import { ProfileRegistry } from "../src/profiles.js";
import { fakeLlmEnv, startFakeLlm, type FakeLlm } from "../../core/test/support/fake-llm.js";

// Guards for docs/premises.md: each test names the premise it holds in place.

let llm: FakeLlm;
let root: string;
let built: App | undefined;
let closeServer: (() => void) | undefined;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-premises-"));
  for (const [k, v] of Object.entries(fakeLlmEnv(llm))) vi.stubEnv(k, v);
  clearQueryCache();
  clearHotMemory();
});

afterEach(async () => {
  closeServer?.();
  built?.close();
  closeServer = built = undefined;
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const GUARD = { allowedOrigins: [], allowedHosts: [], hostPolicy: "loopback" as const };

async function serve(host: MemoryHost): Promise<string> {
  built = buildApp(host, {
    guard: GUARD,
    rateLimit: { limit: 0, windowMs: 60_000 },
    browseLimit: 0,
  });
  const { base, close } = await listen(built.app);
  closeServer = close;
  return base;
}

/** The paths and methods a router serves, read off Express's own route table. */
function routesOf(router: ReturnType<typeof browseRouter>): { path: string; methods: string[] }[] {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route as unknown as { path: string; methods: Record<string, boolean> };
      return { path: route.path, methods: Object.keys(route.methods) };
    });
}

const mcp = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
  });

describe("premise 6: browsing costs no tokens", () => {
  it("serves every browse route, the session start and memory_status without a model call", async () => {
    const kb = new KnowledgeBase(root);
    await kb.writeConcept("/a.md", { type: "Note", title: "A" }, "[b](b.md)", "Added a.");
    const base = await serve(singleMemoryHost(kb, undefined));
    // Any model call would fail loudly — and be counted.
    llm.script([{ status: 500 }]);

    const routes = routesOf(browseRouter(kb));
    expect(routes.length).toBeGreaterThan(5);
    for (const { path: route } of routes) {
      const res = await fetch(`${base}/api${route}?path=/a.md&q=a&id=x`);
      expect(res.status, route).toBeLessThan(500);
    }
    expect((await fetch(`${base}/api/profile`)).status).toBe(200);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const init = await mcp(base, {
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect((await init.json()).result.instructions).toContain("**A**");
    expect((await mcp(base, { method: "tools/list" })).status).toBe(200);
    const status = await mcp(base, {
      method: "tools/call",
      params: { name: "memory_status", arguments: {} },
    });
    expect(JSON.stringify(await status.json())).toContain("concept");

    expect(llm.requests).toHaveLength(0);
  });
});

describe("non-goal: no web CMS", () => {
  it("serves the browse API read-only — every route is a GET", () => {
    const routes = routesOf(browseRouter(new KnowledgeBase(root)));
    for (const { path: route, methods } of routes) expect(methods, route).toEqual(["get"]);
  });
});

describe("premise 5: profiles are walls", () => {
  it("never lists one profile's traces to another profile's key", async () => {
    const registry = new ProfileRegistry(root);
    const work = await registry.create("work");
    const personal = await registry.create("personal");
    const { kb } = (await registry.resolve(personal.key))!;
    await new TraceStore(kb.bundle.root).save({
      id: "private-question",
      kind: "query",
      input: "my diary",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      steps: [],
      answer: "secret",
      notation: "",
      outcome: "success",
      modelChain: [],
    });
    const base = await serve(profileMemoryHost(registry));
    const traces = (key: string) =>
      fetch(`${base}/api/traces`, { headers: { authorization: `Bearer ${key}` } }).then((r) =>
        r.text()
      );
    expect(await traces(personal.key)).toContain("private-question");
    expect(await traces(work.key)).not.toContain("private-question");
  });
});

describe("premise 7: an independent fork", () => {
  it("names the upstream project only to credit it or migrate old settings", () => {
    let hits: string;
    try {
      hits = execFileSync("git", ["grep", "-n", "-i", "understory", "--", ":!pnpm-lock.yaml"], {
        cwd: path.resolve(__dirname, "../../.."),
        encoding: "utf8",
      });
    } catch {
      // Exit 1: no match at all, which passes. No git binary: nothing to check.
      return;
    }
    const allowed = [
      /thecodacus\/understory/i, // credit and links to upstream
      /upstream understory/i,
      /after understory's/, // the README's history section
      /renamed from understory/, // the storage-key migration
      /understory-(layout|token)/, // migrating the old storage keys
      /LEGACY_\w+_KEY/,
      /premises\.test\.ts/, // this test
    ];
    const stray = hits
      .split("\n")
      .filter(Boolean)
      .filter((line) => !allowed.some((re) => re.test(line)));
    expect(stray).toEqual([]);
  });
});
