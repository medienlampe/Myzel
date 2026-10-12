import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { runMutation, runQuery, streamChat } from "../src/agent/agent.js";
import { clearQueryCache, runQueryCached } from "../src/agent/query-cache.js";
import { clearHotMemory, recordHotWrite } from "../src/agent/hot-memory.js";
import { TraceStore } from "../src/agent/trace.js";
import { fakeLlmEnv, startFakeLlm, type FakeLlm } from "./support/fake-llm.js";

let llm: FakeLlm;
let root: string;
let kb: KnowledgeBase;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-agent-"));
  kb = new KnowledgeBase(root);
  await kb.writeConcept(
    "/apis/billing.md",
    { type: "API", title: "Billing API", description: "Charges customers" },
    "# Usage\n\nPOST /charges",
    "Added billing."
  );
  for (const [k, v] of Object.entries(fakeLlmEnv(llm))) vi.stubEnv(k, v);
  vi.stubEnv("LLM_FALLBACK_API_BASE_URL", "");
  clearQueryCache();
  clearHotMemory();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const traces = () => new TraceStore(root).list();
// Tool messages the agent sent back in the last request, as text.
const lastToolOutputs = () => JSON.stringify(llm.requests.at(-1)?.messages ?? []);

describe("runQuery", () => {
  it("searches, answers, and records the path with token usage", async () => {
    llm.script([
      { toolCalls: [{ name: "search_knowledge", args: { query: "billing" } }] },
      { text: "Billing charges customers via POST /charges." },
    ]);
    const result = await runQuery(kb, "How does billing work?");
    expect(result.answer).toContain("POST /charges");
    expect(result.steps).toBe(2);
    expect(lastToolOutputs()).toContain("/apis/billing.md");

    const [trace] = await traces();
    expect(trace).toMatchObject({ kind: "query", outcome: "success" });
    expect(trace.steps.map((s) => s.tool)).toEqual(["search_knowledge"]);
    expect(trace.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("shows the bundle layout when a keyword search finds nothing", async () => {
    llm.script([
      { toolCalls: [{ name: "search_knowledge", args: { query: "zzz-nothing" } }] },
      { text: "Not found." },
    ]);
    await runQuery(kb, "Anything about zzz?");
    expect(lastToolOutputs()).toContain("No keyword matches");
  });

  it("reports a provider failure as its status only, and records a failed trace", async () => {
    llm.script([{ status: 401, error: "Incorrect API key provided: sk-secret" }]);
    await expect(runQuery(kb, "q")).rejects.toThrow("the model provider returned HTTP 401");
    const [trace] = await traces();
    expect(trace.outcome).toBe("failed");
    expect(JSON.stringify(trace)).not.toContain("sk-secret");
  });
});

describe("runMutation", () => {
  it("writes a concept and reports the files changed", async () => {
    llm.script([
      {
        toolCalls: [
          {
            name: "write_concept",
            args: {
              path: "/people/dana.md",
              frontmatter: { type: "Person", title: "Dana" },
              body: "On call this week.",
              log_summary: "Added [Dana](/people/dana.md).",
            },
          },
        ],
      },
      { text: "Recorded Dana." },
    ]);
    const outcome = await runMutation(kb, "Dana is on call");
    expect(outcome).toMatchObject({ ok: true, result: { filesChanged: ["/people/dana.md"] } });
    expect((await kb.readConcept("/people/dana.md")).body).toContain("On call");
  });

  it("patches, reads, lists, lints and deletes through the tools", async () => {
    llm.script([
      {
        toolCalls: [
          {
            name: "patch_concept",
            args: {
              path: "/apis/billing.md",
              frontmatter: { owner: "payments", description: null },
              replace_section: { heading: "Usage", content: "POST /v2/charges" },
              log_summary: "Updated billing.",
            },
          },
          { name: "read_concept", args: { path: "/apis/billing.md" } },
          { name: "list_directory", args: {} },
          { name: "lint_knowledge", args: {} },
        ],
      },
      {
        toolCalls: [
          {
            name: "delete_concept",
            args: { path: "/apis/billing.md", log_summary: "Removed billing." },
          },
        ],
      },
      { text: "Done." },
    ]);
    const outcome = await runMutation(kb, "Restructure billing");
    expect(outcome.ok).toBe(true);
    const sent = JSON.stringify(llm.requests[1].messages);
    expect(sent).toContain("POST /v2/charges"); // read_concept saw the patch
    expect(sent).toContain("payments");
    await expect(kb.readConcept("/apis/billing.md")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns tool errors to the model instead of failing the run", async () => {
    llm.script([
      { toolCalls: [{ name: "read_concept", args: { path: "/.git/config" } }] },
      { text: "Could not read it." },
    ]);
    const outcome = await runMutation(kb, "read the git config");
    expect(outcome.ok).toBe(true);
    expect(lastToolOutputs()).toContain("Hidden paths");
  });

  it("truncates very long concept bodies handed to the model", async () => {
    await kb.writeConcept("/big.md", { type: "T" }, "x".repeat(30_000), "Added big.");
    llm.script([
      { toolCalls: [{ name: "read_concept", args: { path: "/big.md" } }] },
      { text: "Read it." },
    ]);
    await runMutation(kb, "read big");
    expect(lastToolOutputs()).toContain("truncated: 10001 more characters");
  });

  it("fails a run that writes nothing and says nothing", async () => {
    llm.script([{ text: "" }]);
    expect(await runMutation(kb, "do something")).toMatchObject({
      ok: false,
      status: "failed",
      error: expect.stringContaining("empty response"),
    });
  });

  it("accepts a run that writes nothing but explains why", async () => {
    llm.script([{ text: "Already known — nothing to change." }]);
    expect(await runMutation(kb, "Billing charges customers")).toMatchObject({ ok: true });
  });

  it("reports files written before a failure as a partial mutation", async () => {
    llm.script([
      {
        toolCalls: [
          {
            name: "write_concept",
            args: {
              path: "/half.md",
              frontmatter: { type: "T" },
              body: "first",
              log_summary: "Added half.",
            },
          },
        ],
      },
      { status: 400, error: "bad request" },
    ]);
    const outcome = await runMutation(kb, "write two things");
    expect(outcome).toMatchObject({ ok: false, status: "partial", filesChanged: ["/half.md"] });
  });

  it("reports a failure before any write as failed", async () => {
    llm.script([{ status: 400 }]);
    expect(await runMutation(kb, "x")).toMatchObject({ ok: false, status: "failed" });
  });
});

describe("streamChat", () => {
  const user = (text: string) => [
    { role: "user" as const, content: [{ type: "text" as const, text }] },
  ];

  it("streams an answer and records the turn when it touched the bundle", async () => {
    llm.script([
      { toolCalls: [{ name: "search_knowledge", args: { query: "billing" } }] },
      { text: "Billing uses POST /charges." },
    ]);
    const { result } = await streamChat(kb, user("billing?"));
    expect(await result.text).toContain("POST /charges");
    await vi.waitFor(async () => expect(await traces()).toHaveLength(1));
    expect((await traces())[0]).toMatchObject({ kind: "chat", outcome: "success" });
  });

  it("records nothing for a turn that never touched the bundle", async () => {
    llm.script([{ text: "Hello!" }]);
    const { result } = await streamChat(kb, user("hi"));
    expect(await result.text).toBe("Hello!");
    expect(await traces()).toEqual([]);
  });

  it("logs a failing turn on the server and records it after a tool step", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    llm.script([{ toolCalls: [{ name: "list_directory", args: {} }] }, { status: 400 }]);
    const { result } = await streamChat(kb, user("hi"));
    await result.consumeStream();
    expect(log).toHaveBeenCalledWith("[myzel] chat run failed:", expect.anything());
    await vi.waitFor(async () => expect((await traces())[0]?.outcome).toBe("failed"));
    log.mockRestore();
  });
});

describe("model chain", () => {
  it("falls back to the second model on a retryable failure", async () => {
    const backup = await startFakeLlm([{ text: "from the backup" }]);
    try {
      vi.stubEnv("LLM_FALLBACK_API_BASE_URL", backup.url);
      vi.stubEnv("LLM_FALLBACK_API_KEY", "k");
      vi.stubEnv("LLM_FALLBACK_MODEL", "backup-model");
      llm.script([{ status: 503 }]);
      const result = await runQuery(kb, "q");
      expect(result.answer).toBe("from the backup");
      expect((await traces())[0].modelChain).toEqual([
        expect.stringContaining("fake-model"),
        expect.stringContaining("backup-model"),
      ]);
    } finally {
      await backup.close();
    }
  });

  it("keeps the fallback out of runs LLM_FALLBACK_ALLOW_FOR does not list", async () => {
    const backup = await startFakeLlm([{ text: "from the backup" }]);
    try {
      vi.stubEnv("LLM_FALLBACK_API_BASE_URL", backup.url);
      vi.stubEnv("LLM_FALLBACK_API_KEY", "k");
      vi.stubEnv("LLM_FALLBACK_MODEL", "backup-model");
      vi.stubEnv("LLM_FALLBACK_ALLOW_FOR", "query");
      llm.script([{ status: 503 }]);
      expect(await runMutation(kb, "x")).toMatchObject({ ok: false });
      expect(backup.requests).toHaveLength(0);
    } finally {
      await backup.close();
    }
  });

  it("sends a per-call model override", async () => {
    llm.script([{ text: "ok" }]);
    await runQuery(kb, "q", { model: "other-model" });
    expect(llm.requests.at(-1)?.model).toBe("other-model");
  });

  it("discovers the model when LLM_MODEL is empty", async () => {
    vi.stubEnv("LLM_MODEL", "");
    llm.models([{ id: "idle" }, { id: "loaded-one", status: { value: "loaded" } }]);
    llm.script([{ text: "ok" }]);
    await runQuery(kb, "q");
    expect(llm.requests.at(-1)?.model).toBe("loaded-one");
  });

  it("stops a run that exceeds LLM_TIMEOUT", async () => {
    vi.stubEnv("LLM_TIMEOUT", "300ms");
    llm.script([{ hang: true }]);
    await expect(runQuery(kb, "q")).rejects.toThrow(/timed out|cancelled/);
  });
});

describe("query layers with a real model call", () => {
  it("answers from hot memory with one tool-free call", async () => {
    recordHotWrite(root, "/apis/billing.md");
    llm.script([{ text: "Billing charges customers (from /apis/billing.md)." }]);
    const result = await runQueryCached(kb, "what does billing do?");
    expect(result.source).toBe("hot");
    expect(llm.requests.at(-1)?.tools).toBeUndefined();
  });
});
