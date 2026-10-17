import express, { type Router } from "express";
import { z } from "zod";
import { convertToModelMessages, type UIMessage } from "ai";
import { publicErrorMessage, streamChat, type KnowledgeBase } from "@myzel/core";
import { parseAllowedModels } from "../env.js";
import { LIMITS } from "../limits.js";
import { AttachmentError, inlineAttachments } from "./attachments.js";

/**
 * The client sends AI SDK UIMessages. Their internal shape is the SDK's
 * business, so this schema only asserts the envelope Myzel itself relies
 * on — enough to fail with a 400 instead of a 500, and to keep an unbounded or
 * client-chosen `model` out of the provider call.
 */
const chatBodySchema = z.object({
  // The UI only ever sends user and assistant turns; a client-supplied
  // "system" message would sit next to the real system prompt.
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.looseObject({ type: z.string() })),
      })
    )
    .min(1)
    .max(LIMITS.chatMessages),
  model: z.string().min(1).max(LIMITS.modelId).optional(),
});

/** Characters of text in the newest user turn — capped on its own for a clear error. */
function newestUserTurnLength(messages: Array<{ role: string; parts: unknown[] }>): number {
  const turn = [...messages].reverse().find((m) => m.role === "user");
  return (turn?.parts ?? []).reduce<number>((sum, part) => {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? sum + text.length : sum;
  }, 0);
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  router.post("/chat", async (req, res) => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid chat request: ${parsed.error.issues[0]?.message}` });
      return;
    }
    const { messages, model } = parsed.data;
    if (newestUserTurnLength(messages) > LIMITS.chatTurn) {
      res.status(413).json({ error: `message too long (max ${LIMITS.chatTurn} characters)` });
      return;
    }
    let inlined;
    try {
      inlined = inlineAttachments(messages);
    } catch (err) {
      if (!(err instanceof AttachmentError)) throw err;
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (inlined.newestTurnChars > LIMITS.chatAttachments) {
      res.status(413).json({
        error: `attachments too large (max ${LIMITS.chatAttachments} characters per message)`,
      });
      return;
    }
    // The server is stateless: every request re-sends the whole conversation,
    // tool results and attachments included, and all of it goes to the model.
    if (JSON.stringify(inlined.messages).length > LIMITS.chatConversation) {
      res.status(413).json({ error: "conversation too long — start a new chat" });
      return;
    }

    // Read per request: the setting can change at runtime (the settings page).
    const allowedModels = parseAllowedModels(process.env.ALLOWED_MODELS);
    if (model && !allowedModels.includes("*") && !allowedModels.includes(model)) {
      res.status(400).json({
        error: allowedModels.length
          ? `model "${model}" is not allowed. Permitted: ${allowedModels.join(", ")}.`
          : `client-chosen models are disabled. Set ALLOWED_MODELS to permit specific ids, or "*" for any.`,
      });
      return;
    }

    let modelMessages;
    try {
      modelMessages = await convertToModelMessages(inlined.messages as unknown as UIMessage[]);
    } catch (err) {
      res.status(400).json({ error: `unreadable messages: ${(err as Error).message}` });
      return;
    }

    // A closed tab must stop the agent: otherwise it keeps spending tokens and
    // writing files until the run ceiling, with nobody watching.
    const disconnect = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnect.abort();
    });

    // A run that cannot start (endpoint down, model discovery failing) must
    // reach the UI with its reason — the generic error handler would only say
    // "internal error". streamChat has already logged the full error.
    let result;
    try {
      ({ result } = await streamChat(kb, modelMessages, { model, signal: disconnect.signal }));
    } catch (err) {
      res.status(502).json({ error: publicErrorMessage(err) });
      return;
    }
    // A run can also fail mid-stream (endpoint gone, provider error). The SDK
    // would show "An error occurred."; send the same public reason instead.
    result.pipeUIMessageStreamToResponse(res, { onError: (err) => publicErrorMessage(err) });
  });

  return router;
}
