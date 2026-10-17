import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "../src/okf/index.js";
import { runQuery } from "../src/agent/agent.js";
import { clearQueryCache } from "../src/agent/query-cache.js";
import {
  clearHotMemory,
  hotGeneration,
  hotLookup,
  recordHotQuery,
} from "../src/agent/hot-memory.js";
import { buildSystemPrompt } from "../src/agent/system-prompt.js";
import { buildReadTools, buildWriteTools, formatTree } from "../src/agent/tools.js";
import { formatOrphanList } from "../src/agent/untrusted.js";
import { PROMPT_LIMITS } from "../src/agent/limits.js";
import { fakeLlmEnv, startFakeLlm, type FakeLlm } from "./support/fake-llm.js";

// Premise: Myzel runs on cheap models and "low thousands" of concepts. What the
// bundle contributes to a prompt must therefore stay bounded as it grows.

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-limits-"));
  kb = new KnowledgeBase(root);
  for (const [k, v] of Object.entries(fakeLlmEnv(llm))) vi.stubEnv(k, v);
  vi.stubEnv("LLM_FALLBACK_API_BASE_URL", "");
  clearQueryCache();
  clearHotMemory();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * A bundle of `count` orphaned concepts across 40 directories, written
 * straight to disk: going through KnowledgeBase would regenerate the index
 * chain per concept and make the setup the slowest part of the suite.
 */
async function bigBundle(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, `area-${i % 40}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `concept-${i}.md`),
      `---\ntype: Note\ntitle: Concept ${i}\ndescription: ${"A rather long description of the concept. ".repeat(3)}\n---\nBody ${i}\n`
    );
  }
}

type Exec = (input: unknown, options: unknown) => Promise<unknown>;
const exec = (tools: Record<string, unknown>, name: string) =>
  (tools[name] as { execute: Exec }).execute;

describe("bundle content in prompts stays bounded", () => {
  it("lists a small bundle in full", async () => {
    await bigBundle(5);
    const tree = formatTree(await kb.listTree());
    expect(tree).toContain("concept-4.md");
    expect(tree).toContain("A rather long description");
  });

  it("falls back to directories with counts past the budget", async () => {
    await bigBundle(2000);
    const tree = formatTree(await kb.listTree());
    expect(tree.length).toBeLessThanOrEqual(PROMPT_LIMITS.treeChars);
    expect(tree).toContain("2000 concepts");
    expect(tree).toMatch(/area-0\/ {2}\(50\)/);
    expect(tree).not.toContain("concept-1.md");
  });

  it("cuts even the directory outline at the budget", async () => {
    await bigBundle(200);
    const tree = formatTree(await kb.listTree(), 300);
    expect(tree.length).toBeLessThanOrEqual(300);
    expect(tree).toContain("more directories not shown");
  });

  it("keeps the system prompt of a 2000-concept bundle under a fixed ceiling", async () => {
    await bigBundle(2000);
    llm.script([{ text: "Nothing found." }]);
    await runQuery(kb, "anything?");
    const system = JSON.stringify(llm.requests[0].messages).length;
    // Fixed rules (~7 KB) plus the tree budget, with room for JSON escaping.
    expect(system).toBeLessThan(PROMPT_LIMITS.treeChars + 12_000);
  });

  it("names at most 100 types in the system prompt", () => {
    const types = Array.from({ length: 300 }, (_, i) => `Type${i}`);
    const prompt = buildSystemPrompt({ existingTypes: types, treeSummary: "", mode: "query" });
    expect(prompt).toContain("Type99");
    expect(prompt).not.toContain("Type100");
  });

  it("list_directory drills into one directory of a large bundle", async () => {
    await bigBundle(2000);
    const list = exec(buildReadTools(kb), "list_directory");
    const area = (await list({ path: "/area-3" }, {})) as string;
    expect(area).toContain("concept-3.md");
    expect(area).not.toContain("concept-4.md");
    expect(await list({ path: "/nope" }, {})).toContain("No directory");
  });

  it("caps orphan lists in tool output and instructions", async () => {
    await bigBundle(100);
    const lint = (await exec(buildReadTools(kb), "lint_knowledge")({}, {})) as {
      orphans: unknown[];
      orphansOmitted?: number;
    };
    expect(lint.orphans).toHaveLength(PROMPT_LIMITS.listEntries);
    expect(lint.orphansOmitted).toBe(100 - PROMPT_LIMITS.listEntries);

    const orphans = Array.from({ length: 100 }, (_, i) => ({ path: `/o-${i}.md` }));
    const listed = formatOrphanList(orphans).split("\n");
    expect(listed).toHaveLength(PROMPT_LIMITS.listEntries + 1);
    expect(listed.at(-1)).toContain("75 more");
  });

  it("returns a huge frontmatter as a truncated excerpt", async () => {
    await fs.writeFile(
      path.join(root, "fat.md"),
      `---\ntype: Note\nnotes: "${"x".repeat(50_000)}"\n---\nBody\n`
    );
    const read = (await exec(buildReadTools(kb), "read_concept")({ path: "/fat.md" }, {})) as {
      frontmatter?: unknown;
      frontmatter_excerpt?: string;
    };
    expect(read.frontmatter).toBeUndefined();
    expect(read.frontmatter_excerpt!.length).toBeLessThan(PROMPT_LIMITS.readFrontmatterChars + 100);
  });

  it("trims long titles in search hits", async () => {
    await fs.writeFile(
      path.join(root, "long.md"),
      `---\ntype: Note\ntitle: needle ${"y".repeat(5_000)}\n---\nBody\n`
    );
    const hits = (await exec(buildReadTools(kb), "search_knowledge")({ query: "needle" }, {})) as {
      title: string;
    }[];
    expect(hits[0].title.length).toBeLessThanOrEqual(PROMPT_LIMITS.hitFieldChars);
  });

  it("refuses an oversized body from the model", () => {
    // The schema is what the SDK checks before execute runs.
    const schema = (
      buildWriteTools(kb, new Set()).write_concept as unknown as {
        inputSchema: { "~standard": { validate: (v: unknown) => { issues?: unknown[] } } };
      }
    ).inputSchema["~standard"];
    const result = schema.validate({
      path: "/a.md",
      frontmatter: { type: "Note" },
      body: "z".repeat(PROMPT_LIMITS.writeBodyChars + 1),
      log_summary: "Added a.",
    });
    expect(result.issues?.length).toBeGreaterThan(0);
  });

  it("replays hot-memory answers cut to size", async () => {
    recordHotQuery(root, "what?", "w".repeat(10_000), hotGeneration(root));
    const generate = vi.fn(async (_system: string, _prompt: string) => "UNKNOWN");
    await hotLookup(kb, "what again?", {}, generate);
    const prompt = generate.mock.calls[0][1];
    expect(prompt.length).toBeLessThan(PROMPT_LIMITS.hotAnswerChars + 1_000);
  });
});
