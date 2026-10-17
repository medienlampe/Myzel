import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../okf/atomic.js";
import { truncate } from "../util/text.js";

/** One tool invocation in an agent run. */
export interface TraceStep {
  seq: number;
  tool: string;
  /** Human-readable argument (query text, concept path…). */
  summary: string;
  /** Concept paths touched/returned by this step. */
  paths: string[];
  /** True for write tools. */
  write?: boolean;
}

/** "step-limit": the run used its whole step budget and was stopped before it finished. */
export type TraceOutcome = "success" | "partial" | "failed" | "step-limit";

export interface QueryTrace {
  id: string;
  kind: "query" | "mutation" | "chat";
  /** The user input that started the run (truncated). */
  input: string;
  startedAt: string;
  durationMs: number;
  steps: TraceStep[];
  /** Final answer/summary (truncated). */
  answer: string;
  /** Compact one-line notation of the traversal. */
  notation: string;
  outcome: TraceOutcome;
  modelChain: string[];
  /** Tokens the run consumed across all its steps, when the provider reports them. */
  usage?: TraceUsage;
}

export interface TraceUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Sum token usage over a run's steps — which pathways are context-heavy is
 * what the graph's query-path panel shows. Undefined when the provider
 * reports nothing. (Ported from upstream understory.)
 */
export function sumUsage(
  parts: ReadonlyArray<{ usage?: { inputTokens?: number; outputTokens?: number } } | undefined>
): TraceUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let reported = false;
  for (const u of parts.map((p) => p?.usage)) {
    if (!u || (u.inputTokens == null && u.outputTokens == null)) continue;
    reported = true;
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
  }
  return reported ? { inputTokens, outputTokens } : undefined;
}

/** Collects steps during one agent run. Thread one instance through the tools. */
export class TraceRecorder {
  readonly steps: TraceStep[] = [];
  private readonly t0 = Date.now();

  record(tool: string, summary: string, paths: string[], write = false): void {
    this.steps.push({ seq: this.steps.length + 1, tool, summary, paths, write });
  }

  finalize(
    kind: QueryTrace["kind"],
    input: string,
    answer: string,
    outcome: TraceOutcome = "success",
    modelChain: string[] = [],
    usage?: TraceUsage
  ): QueryTrace {
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      input: truncate(input, 300),
      startedAt: new Date(this.t0).toISOString(),
      durationMs: Date.now() - this.t0,
      steps: this.steps,
      answer: truncate(answer, 500),
      notation: buildNotation(this.steps, outcome),
      outcome,
      modelChain,
      usage,
    };
  }
}

/** Compact single-line traversal notation, e.g.
 *  `search "rate limit" (2) → read /apis/billing-api.md → ✓` */
export function buildNotation(steps: TraceStep[], outcome: TraceOutcome = "success"): string {
  const parts = steps.map((s) => {
    switch (s.tool) {
      case "search_knowledge":
        return `search "${truncate(s.summary, 30)}" (${s.paths.length})`;
      case "read_concept":
        return `read ${shortPath(s.paths[0] ?? s.summary)}`;
      case "list_directory":
        return "browse layout";
      case "lint_knowledge":
        return "lint graph";
      case "write_concept":
        return `write ${shortPath(s.paths[0] ?? "")}`;
      case "patch_concept":
        return `patch ${shortPath(s.paths[0] ?? "")}`;
      case "delete_concept":
        return `delete ${shortPath(s.paths[0] ?? "")}`;
      default:
        return s.tool;
    }
  });
  return [...parts, outcomeMarker(outcome)].join(" → ");
}

function outcomeMarker(outcome: TraceOutcome): string {
  switch (outcome) {
    case "success":
      return "✓";
    case "partial":
      return "⚠ partial";
    case "failed":
      return "✗";
    case "step-limit":
      return "⚠ step limit";
  }
}

function shortPath(p: string): string {
  return p.split("/").pop() ?? p;
}

const MAX_TRACES = 50;

/**
 * Persists traces as JSON under <bundleRoot>/.traces/ — a dot-directory the
 * OKF walkers ignore, so traces never touch conformance or the graph.
 */
export class TraceStore {
  private readonly dir: string;

  constructor(bundleRoot: string) {
    this.dir = path.join(bundleRoot, ".traces");
  }

  /**
   * .traces must be a real directory inside the bundle. A synced bundle could
   * ship it as a symlink to some host directory — traces (users' prompts) would
   * be written there, and pruning would delete that directory's .json files.
   */
  private async isRealDir(): Promise<boolean> {
    try {
      const st = await fs.lstat(this.dir);
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Trace files: regular *.json files only — a symlink could point anywhere. */
  private async traceFiles(): Promise<string[]> {
    if (!(await this.isRealDir())) return [];
    const entries = await fs.readdir(this.dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name);
  }

  async save(trace: QueryTrace): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (!(await this.isRealDir())) {
        throw new Error(".traces is not a plain directory inside the bundle — not writing traces");
      }
      // Traces hold users' prompts and answers: keep them out of the user's own
      // commits too, not only out of autocommit. "wx" never follows or replaces
      // an existing entry.
      await fs.writeFile(path.join(this.dir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
      await writeFileAtomic(
        path.join(this.dir, `${trace.id}.json`),
        JSON.stringify(trace, null, 2)
      );
      await this.prune();
    } catch (err) {
      // Tracing is telemetry — never fail the run over it.
      console.error(`[myzel] trace save failed: ${(err as Error).message}`);
    }
  }

  async list(): Promise<QueryTrace[]> {
    let files: string[];
    try {
      files = await this.traceFiles();
    } catch {
      return [];
    }
    const traces: QueryTrace[] = [];
    for (const f of files) {
      try {
        traces.push(JSON.parse(await fs.readFile(path.join(this.dir, f), "utf-8")));
      } catch {
        // skip corrupt file
      }
    }
    traces.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return traces;
  }

  async read(id: string): Promise<QueryTrace | null> {
    // ids are generated by us; still, never let one escape the traces dir.
    if (!/^[a-z0-9-]+$/.test(id)) return null;
    if (!(await this.traceFiles()).includes(`${id}.json`)) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), "utf-8"));
    } catch {
      return null;
    }
  }

  private async prune(): Promise<void> {
    const files = await this.traceFiles();
    if (files.length <= MAX_TRACES) return;
    const stats = await Promise.all(
      files.map(async (f) => ({ f, mtime: (await fs.stat(path.join(this.dir, f))).mtimeMs }))
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const { f } of stats.slice(0, stats.length - MAX_TRACES)) {
      await fs.unlink(path.join(this.dir, f)).catch(() => {});
    }
  }
}
