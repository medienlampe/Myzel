import { useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { apiUrl, authHeaders } from "../api";
import type { AppConfig } from "../api";

/**
 * The conversation lives outside the panel: moving or closing a panel remounts
 * it, and a chat owned by the panel would lose its history and abort a running
 * agent (useChat stops the chats it creates when it unmounts).
 */
export function createChat(onRunEnd: () => void): Chat<UIMessage> {
  return new Chat({
    transport: new DefaultChatTransport({ api: apiUrl("/api/chat"), headers: () => authHeaders() }),
    // Fires when a run ends — finished, failed or aborted — even while the
    // chat panel is closed. The agent may have written files: refresh views.
    onFinish: () => onRunEnd(),
  });
}

const WRITE_TOOLS = new Set(["write_concept", "patch_concept", "delete_concept"]);

/**
 * Chat with the same agent the MCP server runs. Tool calls render inline —
 * watching which tools fire on which files is how we test the agent.
 */
export function ChatPanel({
  chat,
  config,
  onOpenConcept,
}: {
  chat: Chat<UIMessage>;
  config: AppConfig | null;
  onOpenConcept: (path: string) => void;
}) {
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  // The transport is fixed when the chat is created, so per-request values
  // (the model choice) travel with each sendMessage call.
  const { messages, sendMessage, status, error } = useChat({ chat });
  const busy = status === "submitted" || status === "streaming";
  // A run that times out or is cancelled ends with an "abort", not an error:
  // without this the chat would just stop, with no answer and no explanation.
  const last = messages[messages.length - 1];
  const unanswered =
    !busy &&
    !error &&
    last !== undefined &&
    (last.role === "user" || !last.parts.some((p) => p.type === "text"));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Test the knowledge agent here — ask a question, or tell it something worth remembering.
            Tool calls show inline so you can watch it work.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
            {m.parts.map((part, i) => {
              if (part.type === "text") {
                return (
                  <div
                    key={i}
                    className={`markdown inline-block max-w-[95%] rounded-xl px-3 py-2 text-left text-sm ${
                      m.role === "user" ? "bg-cyan-900/50" : "bg-zinc-900 border border-zinc-800"
                    }`}
                  >
                    <MarkdownRenderer>{part.text}</MarkdownRenderer>
                  </div>
                );
              }
              if (part.type.startsWith("tool-")) {
                const toolName = part.type.slice(5);
                const p = part as unknown as {
                  state: string;
                  input?: Record<string, unknown>;
                  output?: unknown;
                };
                const filePath =
                  typeof p.input?.path === "string" ? (p.input.path as string) : undefined;
                return (
                  <div
                    key={i}
                    className={`my-1 flex items-center gap-2 rounded-lg border px-2 py-1 font-mono text-xs ${
                      WRITE_TOOLS.has(toolName)
                        ? "border-amber-800/60 bg-amber-950/30 text-amber-300"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400"
                    }`}
                  >
                    <span>{p.state === "output-available" ? "✓" : "…"}</span>
                    <span className="font-semibold">{toolName}</span>
                    {filePath && (
                      <button
                        onClick={() => onOpenConcept(filePath)}
                        className="truncate text-cyan-400 hover:underline"
                      >
                        {filePath}
                      </button>
                    )}
                    {!filePath && typeof p.input?.query === "string" && (
                      <span className="truncate text-zinc-500">"{String(p.input.query)}"</span>
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
        <div aria-live="polite" className="text-xs text-zinc-500">
          {busy && <span className="animate-pulse">agent working…</span>}
        </div>
        {error && !busy && (
          <p role="alert" className="text-xs text-red-400">
            {error.message || "The request failed."}
          </p>
        )}
        {unanswered && (
          <p role="alert" className="text-xs text-amber-400">
            No answer — the run was stopped, timed out (LLM_TIMEOUT) or used up its step budget
            (LLM_MAX_STEPS).
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          sendMessage({ text: input }, { body: { model: model || undefined } });
          setInput("");
        }}
        className="border-t border-zinc-800 p-3"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask or teach the knowledge base…"
            aria-label="Message the agent"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-hidden focus:border-cyan-600"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-lg bg-cyan-700 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        {config && (
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
            <span>model</span>
            {config.modelOverride ? (
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={config.model}
                aria-label="Model override"
                className="w-40 rounded-sm border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-300 outline-hidden focus:border-cyan-600"
              />
            ) : (
              <span
                title="The server decides the model. Set ALLOWED_MODELS to pick one here."
                className="text-zinc-400"
              >
                {config.model || "auto"}
              </span>
            )}
            {config.fallbackConfigured && (
              <span
                title="Fallback model configured"
                className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400"
              />
            )}
          </div>
        )}
      </form>
    </div>
  );
}
