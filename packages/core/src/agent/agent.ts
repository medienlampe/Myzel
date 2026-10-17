import { generateText, streamText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { KnowledgeBase } from "../okf/index.js";
import { publicErrorMessage } from "../providers/errors.js";
import { parseDuration } from "../util/duration.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  agentActor,
  buildReadTools,
  buildWriteTools,
  formatTree,
  type SeenVersions,
} from "./tools.js";
import { sumUsage, TraceRecorder, TraceStore } from "./trace.js";
import { resolveAgentModel, type AgentOptions } from "./model.js";

export type { AgentOptions } from "./model.js";

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

/**
 * Tool-loop budget. Local models often need more turns than hosted ones to
 * land a mutation, so the ceiling is configurable rather than baked in.
 */
function maxSteps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LLM_MAX_STEPS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_STEPS;
}

/**
 * A run that used every step and whose last step still asked for tools was cut
 * off by the budget: it did not finish, whatever it wrote on the way. A run
 * that answered on its last allowed step did finish. Ported from upstream
 * understory (thecodacus/understory#47), where such runs were recorded as
 * successes with an empty answer.
 */
function hitStepLimit(
  result: { steps: ReadonlyArray<unknown>; finishReason: string },
  budget: number
): boolean {
  return result.steps.length >= budget && result.finishReason === "tool-calls";
}

/**
 * Wall-clock ceiling for one agent run, covering the whole tool loop rather
 * than a single request. Without it an unreachable or stalled endpoint pins a
 * connection (and, over HTTP, a client) open indefinitely. The default is
 * generous on purpose: healthy runs on local hardware were reported to take
 * around seven minutes for a single memory_add.
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
  /** True when the run used every step without reaching an answer; `answer` then says so. */
  stepLimited?: boolean;
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
  console.error("[myzel] agent run failed:", err);
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
  const budget = maxSteps();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "query");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: question,
      tools: buildReadTools(kb, recorder),
      stopWhen: stepCountIs(budget),
      abortSignal: runSignal(options),
    });
    if (hitStepLimit(result, budget)) {
      const answer = `The search used all ${budget} steps without reaching an answer. Raise LLM_MAX_STEPS to let it look further.`;
      const trace = recorder.finalize(
        "query",
        question,
        answer,
        "step-limit",
        modelChain,
        sumUsage(result.steps)
      );
      await traceStore(kb).save(trace);
      return { answer, steps: result.steps.length, traceId: trace.id, stepLimited: true };
    }
    const trace = recorder.finalize(
      "query",
      question,
      result.text,
      "success",
      modelChain,
      sumUsage(result.steps)
    );
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
  // Refused before the model is called: a read-only memory would refuse every
  // write anyway, and the run would only spend tokens finding that out.
  if (kb.readOnly) {
    return { ok: false, status: "failed", error: "this memory is read-only" };
  }
  const ctx = await promptContext(kb, "mutate");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const seen: SeenVersions = new Map();
  const budget = maxSteps();
  let modelChain: string[] = [];
  try {
    const resolved = await resolveAgentModel(options, "mutate");
    modelChain = resolved.modelChain;
    const result = await generateText({
      model: resolved.model,
      system: buildSystemPrompt(ctx),
      prompt: instruction,
      tools: {
        ...buildReadTools(kb, recorder, seen),
        ...buildWriteTools(kb, filesChanged, recorder, agentActor(resolved.modelId), seen),
      },
      stopWhen: stepCountIs(budget),
      abortSignal: runSignal(options),
      temperature: 0.2,
    });
    const usage = sumUsage(result.steps);
    if (hitStepLimit(result, budget)) {
      const files = [...filesChanged].sort();
      const message =
        `the run used all ${budget} steps and was stopped before it finished` +
        (files.length > 0 ? "; the files it changed may be incomplete" : " or changed any file") +
        ". Raise LLM_MAX_STEPS to give it more room.";
      const trace = recorder.finalize(
        "mutation",
        instruction,
        message,
        "step-limit",
        modelChain,
        usage
      );
      await traceStore(kb).save(trace);
      return files.length > 0
        ? { ok: false, status: "partial", filesChanged: files, error: message, traceId: trace.id }
        : { ok: false, status: "failed", error: message };
    }
    // Writing nothing while explaining why (already known, nothing to link) is
    // a normal outcome; writing nothing AND saying nothing is a stalled model.
    if (filesChanged.size === 0 && result.text.trim() === "") {
      const message = "the model returned an empty response without changing any files";
      await traceStore(kb).save(
        recorder.finalize("mutation", instruction, message, "failed", modelChain, usage)
      );
      return { ok: false, status: "failed", error: message };
    }
    const trace = recorder.finalize(
      "mutation",
      instruction,
      result.text,
      "success",
      modelChain,
      usage
    );
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

/**
 * Interactive chat — full toolset, streaming. Caller converts to a UI stream response.
 * On a read-only memory the model gets the read tools and the query prompt only.
 */
export async function streamChat(
  kb: KnowledgeBase,
  messages: ModelMessage[],
  options: AgentOptions = {}
): Promise<{ result: ReturnType<typeof streamText<ToolSet>>; filesChanged: Set<string> }> {
  const ctx = await promptContext(kb, kb.readOnly ? "query" : "chat");
  const recorder = new TraceRecorder();
  const filesChanged = new Set<string>();
  const seen: SeenVersions = new Map();
  const budget = maxSteps();
  let modelChain: string[] = [];
  let failed = false;
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
      tools: kb.readOnly
        ? buildReadTools(kb, recorder)
        : {
            ...buildReadTools(kb, recorder, seen),
            ...buildWriteTools(kb, filesChanged, recorder, agentActor(resolved.modelId), seen),
          },
      stopWhen: stepCountIs(budget),
      abortSignal: runSignal(options),
      onEnd: async ({ text, steps, finishReason }) => {
        // Persist only turns that actually touched the bundle — and not a
        // second time when onError has already recorded the run as failed.
        if (recorder.steps.length > 0 && !failed) {
          const outcome = hitStepLimit({ steps, finishReason }, budget) ? "step-limit" : "success";
          await traceStore(kb).save(
            recorder.finalize("chat", input, text, outcome, modelChain, sumUsage(steps))
          );
        }
      },
      // A run that errors or is aborted mid-way
      // (client gone, timeout) may already have written files — record that too.
      onError: async ({ error }) => {
        failed = true;
        // A custom onError replaces the SDK's console logging; keep the server log.
        console.error("[myzel] chat run failed:", error);
        if (recorder.steps.length === 0) return; // same rule as onEnd
        const outcome = filesChanged.size > 0 ? "partial" : "failed";
        await traceStore(kb).save(
          recorder.finalize("chat", input, publicErrorMessage(error), outcome, modelChain)
        );
      },
      onAbort: async () => {
        if (recorder.steps.length === 0) return;
        const outcome = filesChanged.size > 0 ? "partial" : "failed";
        await traceStore(kb).save(recorder.finalize("chat", input, "aborted", outcome, modelChain));
      },
    });
    return { result, filesChanged };
  } catch (err) {
    if (recorder.steps.length > 0) {
      const outcome = filesChanged.size > 0 ? "partial" : "failed";
      await traceStore(kb).save(
        recorder.finalize("chat", input, errorMessage(err), outcome, modelChain)
      );
    }
    throw err;
  }
}
