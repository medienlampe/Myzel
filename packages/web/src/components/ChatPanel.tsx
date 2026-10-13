import { useState } from "react";
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { ChatInput, FileIcon } from "./ChatInput";
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
 * The transport puts the raw response body into the error message; the server
 * answers failures with `{ error }`, so show just that text.
 */
export function chatErrorText(error: Error): string {
  try {
    const body: unknown = JSON.parse(error.message);
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // Not JSON — a network error or a plain-text body.
  }
  return error.message || "The request failed.";
}

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
  const [model, setModel] = useState("");
  // The transport is fixed when the chat is created, so per-request values
  // (the model choice) travel with each sendMessage call.
  const { messages, sendMessage, regenerate, stop, status, error } = useChat({ chat });
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
          <p className="p-4 text-sm text-muted">
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
                      m.role === "user" ? "bg-raised text-strong" : "border border-line"
                    }`}
                  >
                    <MarkdownRenderer>{part.text}</MarkdownRenderer>
                  </div>
                );
              }
              if (part.type === "file") {
                return (
                  <div
                    key={i}
                    className="my-1 inline-flex max-w-[95%] items-center gap-1.5 rounded-lg border border-line bg-raised/50 px-2 py-1 text-xs text-fg"
                  >
                    <FileIcon />
                    <span className="truncate">{part.filename ?? "attachment"}</span>
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
                        ? "border-yellow/40 bg-yellow/10 text-yellow"
                        : "border-line bg-raised/50 text-muted"
                    }`}
                  >
                    <span>{p.state === "output-available" ? "✓" : "…"}</span>
                    <span className="font-semibold">{toolName}</span>
                    {filePath && (
                      <button
                        onClick={() => onOpenConcept(filePath)}
                        className="truncate text-blue underline-offset-2 hover:underline"
                      >
                        {filePath}
                      </button>
                    )}
                    {!filePath && typeof p.input?.query === "string" && (
                      <span className="truncate text-muted">"{String(p.input.query)}"</span>
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        ))}
        <div aria-live="polite" className="text-xs text-muted">
          {busy && <span className="animate-pulse">agent working…</span>}
        </div>
        {error && !busy && (
          <p role="alert" className="text-xs text-red">
            {chatErrorText(error)}
          </p>
        )}
        {unanswered && (
          <p role="alert" className="text-xs text-yellow">
            No answer — the run was stopped, timed out (LLM_TIMEOUT) or used up its step budget
            (LLM_MAX_STEPS).
          </p>
        )}
        {(error || unanswered) && !busy && (
          // Resends the last user turn; a partial assistant answer is replaced.
          <button
            onClick={() => void regenerate({ body: { model: model || undefined } })}
            className="btn-ghost border border-line-strong/70"
          >
            Retry
          </button>
        )}
      </div>

      <ChatInput
        busy={busy}
        config={config}
        model={model}
        onModelChange={setModel}
        // Aborting the request closes the connection; the server then aborts the run.
        onStop={() => void stop()}
        onSend={(text, files) => {
          const body = { model: model || undefined };
          if (text.trim()) sendMessage({ text, files }, { body });
          else sendMessage({ files }, { body });
        }}
      />
    </div>
  );
}
