import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response, Router } from "express";
import express from "express";
import type { KnowledgeBase } from "@myzel/core";
import { buildMcpServer } from "./server.js";

/**
 * MCP streamable-HTTP at /mcp. Stateless: a fresh McpServer + transport per
 * request (no session store) — the KB itself serializes mutations. Express
 * hands the SDK transport the raw Node req/res directly, so there is no
 * hijack/lifecycle glue and CORS is handled by the app-level cors() middleware.
 */
export function mcpRouter(kb: KnowledgeBase): Router {
  const router = express.Router();

  const handle = async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // one JSON reply per request — no long-lived SSE
    });
    // Listen before the first await: building the server fingerprints the
    // bundle, and a client gone by then must not still start an agent run.
    const built: { server?: Awaited<ReturnType<typeof buildMcpServer>> } = {};
    res.on("close", () => {
      // A rejected close must not become an unhandled rejection (fatal in Node).
      Promise.allSettled([transport.close(), built.server?.close()]).catch(() => {});
    });
    const server = (built.server = await buildMcpServer(kb));
    if (res.destroyed) {
      void server.close().catch(() => {});
      return;
    }
    await server.connect(transport);
    // express.json() already parsed the body; pass it so the transport doesn't
    // try to re-read the consumed stream.
    await transport.handleRequest(req, res, req.body);
  };

  router.post("/", handle);
  router.get("/", handle);
  router.delete("/", handle);
  return router;
}
