import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted OpenAI-compatible endpoint for tests. Agent runs go through the
 * real provider, fallback and tool-loop code; only the model is fake. Each
 * request to /v1/chat/completions consumes the next scripted step (the last
 * one repeats), in the streaming or non-streaming shape the client asked for.
 */

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type FakeStep =
  | { text?: string; toolCalls?: FakeToolCall[] }
  | { status: number; error?: string }
  /** Never answers — for timeouts and cancellation. */
  | { hang: true };

export interface FakeLlm {
  /** Base URL to use as LLM_API_BASE_URL (ends in /v1). */
  url: string;
  /** Request bodies received since the last script(), in order. */
  requests: Array<Record<string, unknown>>;
  /** Replace the script (and reset the step counter). */
  script(steps: FakeStep[]): void;
  /** Models listed at /v1/models (for discovery); default: none. */
  models(list: Array<{ id: string; status?: { value: string } }>): void;
  /** Runs before the n-th chat request (0-based) is answered — to change the world mid-run. */
  onRequest?: (n: number) => Promise<void> | void;
  /** Resolves when the client gives up on a hanging request (cancellation reached the provider). */
  hangUp(): Promise<void>;
  close(): Promise<void>;
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

export async function startFakeLlm(steps: FakeStep[] = [{ text: "ok" }]): Promise<FakeLlm> {
  let script = steps;
  let next = 0;
  let modelList: Array<{ id: string; status?: { value: string } }> = [];
  const requests: Array<Record<string, unknown>> = [];
  let hungUp: () => void = () => {};
  let hangUp = new Promise<void>((resolve) => (hungUp = resolve));

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => void answer());
    const answer = async () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: modelList }));
        return;
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push(body);
      await fake.onRequest?.(requests.length - 1);
      const step = script[Math.min(next++, script.length - 1)];
      if ("hang" in step) {
        res.on("close", () => hungUp()); // leave the request open
        return;
      }
      if ("status" in step) {
        // retry-after-ms keeps the SDK's own retries (exponential backoff) fast.
        res.writeHead(step.status, { "content-type": "application/json", "retry-after-ms": "1" });
        res.end(JSON.stringify({ error: { message: step.error ?? "fake failure" } }));
        return;
      }
      const toolCalls = (step.toolCalls ?? []).map((call, i) => ({
        id: `call_${next}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
      const base = { id: `cmpl_${next}`, created: 0, model: String(body.model ?? "fake") };

      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: step.text ?? null,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: finish,
              },
            ],
            usage: USAGE,
          })
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const delta = (d: Record<string, unknown>, finishReason: string | null = null) =>
        send({
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: d, finish_reason: finishReason }],
        });
      delta({ role: "assistant", content: "" });
      if (step.text) delta({ content: step.text });
      toolCalls.forEach((call, index) => delta({ tool_calls: [{ index, ...call }] }));
      delta({}, finish);
      send({ ...base, object: "chat.completion.chunk", choices: [], usage: USAGE });
      res.end("data: [DONE]\n\n");
    };
  });

  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeLlm = {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    script(steps) {
      script = steps;
      next = 0;
      requests.length = 0;
      hangUp = new Promise<void>((resolve) => (hungUp = resolve));
    },
    hangUp: () => hangUp,
    models(list) {
      modelList = list;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
}

/** Environment pointing the agent at the fake (merge into process.env with vi.stubEnv). */
export function fakeLlmEnv(fake: FakeLlm): Record<string, string> {
  return {
    LLM_API_BASE_URL: fake.url,
    LLM_API_KEY: "test-key",
    LLM_API_FORMAT: "openai",
    LLM_MODEL: "fake-model",
  };
}
