import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sumUsage, TraceRecorder, TraceStore } from "../src/agent/trace.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-trace-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-trace-outside-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const trace = () => new TraceRecorder().finalize("query", "q", "a", "success", []);

describe("TraceStore", () => {
  it("saves, lists and reads traces", async () => {
    const store = new TraceStore(root);
    const t = trace();
    await store.save(t);
    expect((await store.list()).map((x) => x.id)).toEqual([t.id]);
    expect((await store.read(t.id))?.input).toBe("q");
  });

  it("keeps traces out of the user's own git commits", async () => {
    await new TraceStore(root).save(trace());
    expect(await fs.readFile(path.join(root, ".traces", ".gitignore"), "utf-8")).toBe("*\n");
    // A hand-made ignore file is left as it is.
    await fs.writeFile(path.join(root, ".traces", ".gitignore"), "mine\n");
    await new TraceStore(root).save(trace());
    expect(await fs.readFile(path.join(root, ".traces", ".gitignore"), "utf-8")).toBe("mine\n");
  });

  it("neither writes into nor prunes a .traces symlinked out of the bundle", async () => {
    for (let i = 0; i < 55; i++) await fs.writeFile(path.join(outside, `app-${i}.json`), "{}");
    await fs.symlink(outside, path.join(root, ".traces"), "dir");
    const store = new TraceStore(root);
    await store.save(trace());
    expect(await fs.readdir(outside)).toHaveLength(55);
    expect(await store.list()).toEqual([]);
  });
});

describe("sumUsage", () => {
  it("adds up the steps that report usage", () => {
    expect(
      sumUsage([
        { usage: { inputTokens: 1000, outputTokens: 50 } },
        { usage: { inputTokens: 2500, outputTokens: undefined } },
        {},
      ])
    ).toEqual({ inputTokens: 3500, outputTokens: 50 });
  });

  it("is undefined when the provider reports nothing", () => {
    expect(sumUsage([{}, { usage: {} }])).toBeUndefined();
  });
});
