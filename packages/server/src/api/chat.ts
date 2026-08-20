import express, { type Router } from "express";
import { z } from "zod";
import { convertToModelMessages, type UIMessage } from "ai";
import { streamChat, type KnowledgeBase } from "@understory/core";

/**
 * The client sends AI SDK UIMessages. Their internal shape is the SDK's
 * business, so this schema only asserts the envelope understory itself relies
 * on — enough to fail with a 400 instead of a 500, and to keep an unbounded or
 * client-chosen `model` out of the provider call.
 */
const chatBodySchema = z.object({
  messages: z
    .array(z.object({ role: z.string() }).passthrough())
    .min(1)
    .max(200),
  model: z.string().min(1).max(200).optional(),
});

/**
 * Which models a client may request. Unset means none: the server's configured
 * model is used and a client-supplied override is refused, so a request cannot
 * redirect spend onto a different (pricier) model. "*" restores free choice.
 */
export function parseAllowedModels(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Streaming chat endpoint for the web UI (`useChat`). Full agent toolset —
 * the chat exists to exercise the same agent the MCP server uses.
 */
export function chatRouter(kb: KnowledgeBase): Router {
  const router = express.Router();
  const allowedModels = parseAllowedModels(process.env.ALLOWED_MODELS);

  router.post("/chat", async (req, res) => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `invalid chat request: ${parsed.error.issues[0]?.message}` });
      return;
    }
    const { messages, model } = parsed.data;

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
      modelMessages = convertToModelMessages(messages as unknown as UIMessage[]);
    } catch (err) {
      res.status(400).json({ error: `unreadable messages: ${(err as Error).message}` });
      return;
    }

    const { result } = await streamChat(kb, modelMessages, { model });
    const response = result.toUIMessageStreamResponse();
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
    }
    res.end();
  });

  return router;
}
