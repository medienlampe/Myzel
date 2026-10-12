import { generateText, streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import { publicErrorMessage } from "../providers/errors.js";
import { parseDuration } from "../util/duration.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildReadTools, buildWriteTools, formatTree } from "./tools.js";
import { TraceRecorder, TraceStore } from "./trace.js";
import { resolveAgentModel, type AgentOptions } from "./model.js";

export type { AgentOptions } from "./model.js";

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/**
 * Tool-loop budget. Local models often need more turns than hosted ones to
 * land a mutation, so the ceiling is configurable rather than baked in.
 */
function maxSteps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LLM_MAX_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_STEPS;
}

/**
 * Wall-clock ceiling for one agent run, covering the whole tool loop rather
 * than a single request. Without it an unreachable or stalled endpoint pins a
 * connection (and, over HTTP, a client) open indefinitely.
 */
function runTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseDuration(env.LLM_TIMEOUT) ?? DEFAULT_RUN_TIMEOUT_MS;
}

/** The run ceiling, combined with the caller's own cancellation if any. */
function runSignal(options: AgentOptions): AbortSignal {
  const timeout = AbortSignal.timeout(runTimeoutMs());
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
}

export interface QueryResult {
  answer: string;
  steps: number;
  traceId: string;
}

export interface MutationResult {
  summary: string;
  filesChanged: string[];
  steps: number;
  traceId: string;
}

export type MutationOutcome =
  | { ok: true; result: MutationResult }
  | { ok: false; status: "partial"; filesChanged: string[]; error: string; traceId: string }
  | { ok: false; status: "failed"; error: string };

async function promptContext(kb: KnowledgeBase, mode: "query" | "mutate" | "chat") {
  const [types, tree] = await Promise.all([kb.listTypes(), kb.listTree()]);
  return { existingTypes: types, treeSummary: formatTree(tree), mode };
}

function traceStore(kb: KnowledgeBase): TraceStore {
  return new TraceStore(kb.bundle.root);
}

/**
 * What callers (MCP clients, traces) get to see of a failure: provider errors
 * reduced to their status. The full error is logged here, on the server.
 */
function errorMessage(err: unknown): string {
  console.error("[understory] agent run failed:", err);
  return publicErrorMessage(err);
}

/** Read-only Q&A over the bundle. */
export async function runQuery(
  kb: KnowledgeBase,
  question: string,
  options: AgentOptions = {}
): Promise<QueryResult> {
  const ctx = await promptContext(kb, "query");
  const recorder = new TraceRecorder();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder),
      stopWhen: stepCountIs(maxSteps()),
      abortSignal: runSignal(options),
    });
    const trace = recorder.finalize("query", question, result.text, "success", modelChain);
    await traceStore(kb).save(trace);
    return { answer: result.text, steps: result.steps.length, traceId: trace.id };
  } catch (err) {
    const message = errorMessage(err);
    const trace = recorder.finalize("query", question, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    throw new Error(message, { cause: err });
  }
}

/** Knowledge add/update — full toolset, low temperature. */
export async function runMutation(
  kb: KnowledgeBase,
  instruction: string,
  options: AgentOptions = {}
): Promise<MutationOutcome> {
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps()),
      abortSignal: runSignal(options),
      temperature: 0.2,
    });
    const trace = recorder.finalize("mutation", instruction, result.text, "success", modelChain);
    await traceStore(kb).save(trace);
    return {
      ok: true,
      result: {
        summary: result.text,
        filesChanged: [...filesChanged].sort(),
        steps: result.steps.length,
        traceId: trace.id,
      },
    };
  } catch (err) {
    const files = [...filesChanged].sort();
    const message = errorMessage(err);
    if (files.length > 0) {
      const summary = `Partial mutation: ${files.length} file(s) changed before failure. Error: ${message}`;
      const trace = recorder.finalize("mutation", instruction, summary, "partial", modelChain);
      await traceStore(kb).save(trace);
      return {
        ok: false,
        status: "partial",
        filesChanged: files,
        error: message,
        traceId: trace.id,
      };
    }
    const trace = recorder.finalize("mutation", instruction, message, "failed", modelChain);
    await traceStore(kb).save(trace);
    return { ok: false, status: "failed", error: message };
  }
}

/** Interactive chat — full toolset, streaming. Caller converts to a UI stream response. */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
): Promise<{ result: ReturnType<typeof streamText<ToolSet>>; filesChanged: Set<string> }> {
  const ctx = await promptContext(kb, "chat");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  let modelChain: string[] = [];
  // The user turn that started this run, for the trace record.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const input =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : (lastUser?.content
          ?.map((part) => (part.type === "text" ? part.text : ""))
          .join(" ")
          .trim() ?? "(chat)");

  try {
    const resolved = await resolveAgentModel(options, "chat");
    modelChain = resolved.modelChain;
    const result = streamText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      messages,
      tools: { ...buildReadTools(kb, recorder), ...buildWriteTools(kb, filesChanged, recorder) },
      stopWhen: stepCountIs(maxSteps()),
      abortSignal: runSignal(options),
      onFinish: async ({ text }) => {
        // Persist only turns that actually touched the bundle.
        if (recorder.steps.length > 0) {
          await traceStore(kb).save(recorder.finalize("chat", input, text, "success", modelChain));
        }
      },
    });
    return { result, filesChanged };
  } catch (err) {
    const outcome = filesChanged.size > 0 ? "partial" : "failed";
    await traceStore(kb).save(
      recorder.finalize("chat", input, errorMessage(err), outcome, modelChain)
    );
    throw err;
  }
}
