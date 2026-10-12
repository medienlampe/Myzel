#!/usr/bin/env node
/**
 * MCP over stdio — register in Claude Code / Claude Desktop:
 *   claude mcp add myzel -e BUNDLE_ROOT=/path/to/bundle \
 *     -e LLM_API_BASE_URL=... -e LLM_API_KEY=... -e LLM_API_FORMAT=openai \
 *     -- node <repo>/packages/server/dist/mcp/stdio.js
 * (or `make mcp-stdio` from the repository root)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeBase } from "@myzel/core";
import { buildMcpServer } from "./server.js";
import { checkGitAutocommit, checkModelConfig } from "../startup.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

checkModelConfig((line) => console.error(line));

const kb = new KnowledgeBase(bundleRoot, {
  gitAutocommit: process.env.GIT_AUTOCOMMIT === "true",
});
await checkGitAutocommit(kb, (line) => console.error(line));
const server = await buildMcpServer(kb);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(`[myzel] serving bundle ${bundleRoot} over stdio`);
