/**
 * Input ceilings for everything that reaches a model. Each MCP call or chat
 * turn is forwarded to an LLM, so an unbounded string is an unbounded bill —
 * one request could otherwise carry ~1M tokens. The numbers are generous for
 * real use (a long runbook pasted into memory_add fits comfortably) and far
 * below what would make a single call expensive.
 */
export const LIMITS = {
  /** memory_query question. */
  question: 4_000,
  /** memory_add content — whole documents are a legitimate input. */
  content: 100_000,
  /** memory_update instruction. */
  instruction: 20_000,
  /** memory_add suggested_path. */
  path: 300,
  /** Newest user turn in /api/chat. */
  chatTurn: 20_000,
  /** Text of the files attached to the newest /api/chat turn — as much as memory_add takes. */
  chatAttachments: 100_000,
  /** Whole /api/chat conversation as sent (JSON characters, tool results included). */
  chatConversation: 200_000,
  /** Messages per /api/chat request. */
  chatMessages: 200,
  /** JSON request bodies (/mcp, /api). Fits `content` even in worst-case UTF-8. */
  jsonBody: "1mb",
} as const;
