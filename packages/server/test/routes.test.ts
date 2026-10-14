import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearHotMemory, clearQueryCache, KnowledgeBase, TraceStore } from "@myzel/core";
import { listen } from "./support/serve.js";
import { buildApp, type App, type AppOptions } from "../src/app.js";
import { singleMemoryHost } from "../src/host.js";
import { startDreamer } from "../src/dreamer.js";
import { checkModelConfig, requireGitReady } from "../src/startup.js";
import { fakeLlmEnv, startFakeLlm, type FakeLlm } from "../../core/test/support/fake-llm.js";

let llm: FakeLlm;
let root: string;
let kb: KnowledgeBase;
let built: App | undefined;
let closeServer: (() => void) | undefined;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-routes-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept(
    "/apis/billing.md",
    { type: "API", title: "Billing API", description: "Charges customers", tags: ["money"] },
    "See [Customers](/tables/customers.md).",
    "Added [billing](/apis/billing.md)."
  );
  for (const [k, v] of Object.entries(fakeLlmEnv(llm))) vi.stubEnv(k, v);
  clearQueryCache();
  clearHotMemory();
});

afterEach(async () => {
  closeServer?.();
  built?.close();
  closeServer = built = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

const GUARD = { allowedOrigins: [], allowedHosts: [], hostPolicy: "loopback" as const };

async function serve(options: Partial<AppOptions> = {}, memory = kb): Promise<string> {
  built = buildApp(singleMemoryHost(memory, undefined), {
    guard: GUARD,
    rateLimit: { limit: 0, windowMs: 60_000 },
    browseLimit: 0,
    ...options,
  });
  const { base, close } = await listen(built.app);
  closeServer = close;
  return base;
}

const json = (url: string) =>
  fetch(url).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("browse API", () => {
  it("serves the tree, a concept, search, log, validation, graph, types and config", async () => {
    const base = await serve();
    expect(JSON.stringify((await json(`${base}/api/tree`)).body)).toContain("billing.md");
    expect((await json(`${base}/api/concept?path=/apis/billing.md`)).body.frontmatter.title).toBe(
      "Billing API"
    );
    expect((await json(`${base}/api/search?q=charges`)).body[0].path).toBe("/apis/billing.md");
    expect((await json(`${base}/api/search?q=&type=API&tags=money`)).body).toHaveLength(1);
    expect((await json(`${base}/api/log`)).body[0].action).toBe("Creation");
    expect((await json(`${base}/api/validate`)).body.conformant).toBe(true);
    const graph = (await json(`${base}/api/graph`)).body;
    expect(graph.nodes.map((n: { path: string }) => n.path)).toEqual(["/apis/billing.md"]);
    expect((await json(`${base}/api/types`)).body).toEqual(["API"]);
    expect((await json(`${base}/api/config`)).body).toMatchObject({
      model: "fake-model",
      modelOverride: false,
      readOnly: false,
    });
  });

  it("maps bundle errors to 404 and 400", async () => {
    const base = await serve();
    expect((await json(`${base}/api/concept?path=/nope.md`)).status).toBe(404);
    expect((await json(`${base}/api/concept?path=/.git/config`)).status).toBe(400);
    expect((await json(`${base}/api/concept`)).status).toBe(400);
  });

  it("lists traces and serves one, without the full steps in the list", async () => {
    llm.script([{ text: "Billing charges customers." }]);
    await import("@myzel/core").then(({ runQuery }) => runQuery(kb, "billing?"));
    const base = await serve();
    const list = (await json(`${base}/api/traces`)).body;
    expect(list[0]).toMatchObject({ kind: "query", stepCount: 0, usage: { inputTokens: 100 } });
    expect(list[0].steps).toBeUndefined();
    expect((await json(`${base}/api/trace?id=${list[0].id}`)).body.answer).toContain("Billing");
    expect((await json(`${base}/api/trace?id=nope`)).status).toBe(404);
  });
});

describe("MCP tools (stateless HTTP)", () => {
  const call = async (base: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await res.json();
    return { text: body.result?.content?.[0]?.text as string, isError: body.result?.isError };
  };

  it("memory_query answers through the agent, then from the cache", async () => {
    const base = await serve();
    llm.script([{ text: "Billing charges customers." }]);
    expect((await call(base, "memory_query", { question: "billing?" })).text).toContain("charges");
    expect((await call(base, "memory_query", { question: "billing?" })).text).toContain(
      "(cached answer)"
    );
  });

  it("memory_add records knowledge and reports the files changed", async () => {
    const base = await serve();
    llm.script([
      {
        toolCalls: [
          {
            name: "write_concept",
            args: {
              path: "/people/dana.md",
              frontmatter: { type: "Person" },
              body: "On call.",
              log_summary: "Added Dana.",
            },
          },
        ],
      },
      { text: "Recorded." },
    ]);
    const { text } = await call(base, "memory_add", {
      content: "Dana is on call",
      suggested_path: "/people/dana.md",
    });
    expect(text).toContain("/people/dana.md");
    expect(JSON.stringify(llm.requests[0].messages)).toContain(
      "place new content at /people/dana.md"
    );
  });

  it("memory_update reports partial and failed mutations", async () => {
    const base = await serve();
    llm.script([
      {
        toolCalls: [
          {
            name: "write_concept",
            args: { path: "/x.md", frontmatter: { type: "T" }, body: "x", log_summary: "Added x." },
          },
        ],
      },
      { status: 400 },
    ]);
    expect((await call(base, "memory_update", { instruction: "change things" })).text).toContain(
      "Partial mutation"
    );
    llm.script([{ status: 400 }]);
    const failed = await call(base, "memory_update", { instruction: "change things" });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Mutation failed");
  });

  it("memory_status reports conformance and graph health without a model call", async () => {
    const base = await serve();
    llm.script([{ status: 500 }]);
    const status = JSON.parse((await call(base, "memory_status")).text);
    expect(status).toMatchObject({ conformant: true, graph: { orphans: 1, brokenLinks: 1 } });
    expect(llm.requests).toHaveLength(0);
  });

  it("memory_maintain repairs through the agent, or does nothing when healthy", async () => {
    const base = await serve();
    llm.script([{ text: "Wired the orphan in." }]);
    const repaired = (await call(base, "memory_maintain")).text;
    expect(repaired).toContain("Graph health");
    expect(JSON.stringify(llm.requests[0].messages)).toContain("BROKEN LINKS");

    const healthy = new KnowledgeBase(path.join(root, "healthy"));
    await fs.mkdir(healthy.bundle.root);
    closeServer?.();
    built?.close();
    const base2 = await serve({}, healthy);
    expect((await call(base2, "memory_maintain")).text).toContain("Memory is healthy");
  });
});

describe("chat over HTTP", () => {
  it("streams the agent's answer as a UI message stream", async () => {
    const base = await serve();
    llm.script([{ text: "Hello from the agent." }]);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello from the agent.");
  });

  it("reports why a run could not start instead of a bare internal error", async () => {
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("LLM_API_BASE_URL", "http://127.0.0.1:1/v1");
    const base = await serve();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/LLM_MODEL is not set and could not be discovered/);
  });

  it("reports a model failure during the run with its public reason", async () => {
    const base = await serve();
    llm.script([{ status: 500, error: "secret upstream detail" }]);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    const body = await res.text();
    expect(body).toContain("the model provider returned HTTP 500");
    expect(body).not.toContain("secret upstream detail");
    expect(body).not.toContain("An error occurred.");
  });

  it("hands attached text to the model and refuses what it cannot take", async () => {
    const base = await serve();
    const post = (parts: object[]) =>
      fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ id: "1", role: "user", parts }] }),
      });
    const data = (text: string) =>
      `data:text/markdown;base64,${Buffer.from(text).toString("base64")}`;

    llm.script([{ text: "Got the runbook." }]);
    const ok = await post([
      { type: "file", mediaType: "text/markdown", filename: "runbook.md", url: data("Restart X.") },
      { type: "text", text: "remember this" },
    ]);
    expect(await ok.text()).toContain("Got the runbook.");
    expect(JSON.stringify(llm.requests[0].messages)).toContain(
      '<attachment name=\\"runbook.md\\">\\nRestart X.\\n</attachment>'
    );

    const image = await post([
      { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA" },
    ]);
    expect(image.status).toBe(415);
    expect((await image.json()).error).toMatch(/only text files/);

    const big = await post([
      { type: "file", mediaType: "text/plain", url: data("x".repeat(100_001)) },
    ]);
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/attachments too large/);
  });

  it("aborts the agent run when the client goes away (the chat's Stop)", async () => {
    const base = await serve();
    llm.script([{ hang: true }]);
    const stop = new AbortController();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
      signal: stop.signal,
    });
    const reading = res.text().catch(() => "aborted");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    stop.abort();
    expect(await reading).toBe("aborted");
    await llm.hangUp(); // the provider request was cancelled, not left running
  });

  it("rejects messages the SDK cannot convert", async () => {
    const base = await serve();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", parts: "not a list" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts an allowed model override", async () => {
    vi.stubEnv("ALLOWED_MODELS", "other-model");
    const base = await serve();
    llm.script([{ text: "ok" }]);
    await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }],
          model: "other-model",
        }),
      })
    ).text();
    expect(llm.requests[0].model).toBe("other-model");
  });
});

describe("app wiring", () => {
  it("serves the web UI at / only, and health without auth", async () => {
    const web = path.join(root, "web");
    await fs.mkdir(web);
    await fs.writeFile(path.join(web, "index.html"), "<!doctype html><title>Myzel</title>");
    const base = await serve({ webDist: web });
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>Myzel</title>");
    expect((await fetch(`${base}/elsewhere/`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok" });
  });

  it("sends security headers", async () => {
    const res = await fetch(`${await serve()}/healthz`);
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("answers unexpected errors with a generic 500, never a stack trace", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = new KnowledgeBase(path.join(root, "does-not-exist"));
    const res = await fetch(`${await serve({}, missing)}/api/tree`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
    log.mockRestore();
  });

  it("rate-limits agent routes and browse routes separately", async () => {
    const base = await serve({ rateLimit: { limit: 1, windowMs: 60_000 }, browseLimit: 2 });
    const post = () =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    expect((await post()).status).not.toBe(429);
    expect((await post()).status).toBe(429);
    expect((await fetch(`${base}/api/types`)).status).toBe(200);
    expect((await fetch(`${base}/api/types`)).status).toBe(200);
    expect((await fetch(`${base}/api/types`)).status).toBe(429);
  });

  it("honours trust proxy for the client address", async () => {
    const base = await serve({ trustProxy: 1, rateLimit: { limit: 1, windowMs: 60_000 } });
    const post = (ip: string) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: "{}",
      });
    expect((await post("10.0.0.1")).status).not.toBe(429);
    expect((await post("10.0.0.2")).status).not.toBe(429); // a different client
  });
});

describe("demo mode (read-only memory)", () => {
  const demoBase = () => serve({}, new KnowledgeBase(root, { readOnly: true }));
  const rpc = (base: string, method: string, params: unknown = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((r) => r.json());

  it("offers only the read-only MCP tools and says so in the instructions", async () => {
    const base = await demoBase();
    const tools = (await rpc(base, "tools/list")).result.tools as { name: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["memory_query", "memory_status"]);
    const init = await rpc(base, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result.instructions).toContain("read-only");
    expect(init.result.instructions).not.toContain("memory_add");
  });

  it("tells the UI, and chats without handing the model write tools", async () => {
    const base = await demoBase();
    expect((await json(`${base}/api/config`)).body).toMatchObject({ readOnly: true });
    llm.script([{ text: "Billing charges customers." }]);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "billing?" }] }],
      }),
    });
    expect(await res.text()).toContain("Billing charges customers.");
    const sent = JSON.stringify(llm.requests.at(-1)?.tools);
    expect(sent).toContain("read_concept");
    expect(sent).not.toContain("write_concept");
  });
});

describe("dreamer", () => {
  it("is off without DREAM_INTERVAL and warns about an invalid one", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    startDreamer(async () => [])();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dreaming: disabled"));
    vi.stubEnv("DREAM_INTERVAL", "often");
    startDreamer(async () => [])();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("invalid DREAM_INTERVAL"));
    log.mockRestore();
    err.mockRestore();
  });

  it("dreams every memory in turn after the interval, never at startup", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.stubEnv("DREAM_INTERVAL", "1m"); // clamped to the 5-minute minimum
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    llm.script([{ text: "Linked the orphan." }]);
    const other = new KnowledgeBase(path.join(root, "other"));
    await fs.mkdir(other.bundle.root);
    const stop = startDreamer(async () => [
      { kb, label: "work" },
      { kb: other, label: null },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("clamped to 5m minimum"));
    expect(llm.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("dream complete [work]"))
    );
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("dream skipped"))
    );
    stop();
    log.mockRestore();
  });
});

describe("startup checks", () => {
  it("logs the model, with credentials in the URL redacted", () => {
    vi.stubEnv("LLM_API_BASE_URL", "https://user:sk-secret@gw.example/v1");
    const lines: string[] = [];
    checkModelConfig((l) => lines.push(l));
    expect(lines.join("\n")).toContain("https://***@gw.example/v1");
    expect(lines.join("\n")).not.toContain("sk-secret");
  });

  it("exits with a clear error when no model is configured", () => {
    for (const k of ["LLM_API_BASE_URL", "LLM_API_KEY"]) vi.stubEnv(k, "");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => checkModelConfig(() => {})).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });

  it("names the memory when git autocommit cannot work", async () => {
    const repo = new KnowledgeBase(root, { gitAutocommit: true });
    await requireGitReady(repo, "the bundle"); // initializes a fresh repository
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["config", "core.fsmonitor", "x"], { cwd: root });
    await expect(requireGitReady(repo, 'profile "work"')).rejects.toThrow(
      /autocommit cannot work for profile "work"/
    );
  });
});

describe("traces after an MCP query", () => {
  it("are stored per bundle", async () => {
    llm.script([{ text: "ok" }]);
    const { runQuery } = await import("@myzel/core");
    await runQuery(kb, "q");
    expect(await new TraceStore(root).list()).toHaveLength(1);
  });
});
