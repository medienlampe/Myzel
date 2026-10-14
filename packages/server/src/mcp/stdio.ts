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
import { checkModelConfig, requireGitReady } from "../startup.js";
import { SettingsStore } from "../settings.js";
import { isDemoMode } from "../env.js";

const bundleRoot = process.env.BUNDLE_ROOT;
if (!bundleRoot) {
  console.error("BUNDLE_ROOT env var is required");
  process.exit(1);
}

// The settings saved from the web UI apply here too — read once, at start.
// Warnings go to stderr: stdout is the MCP protocol stream.
try {
  await SettingsStore.load(process.env.SETTINGS_FILE || null, process.env, (line) =>
    console.error(line)
  );
} catch (err) {
  console.error(`[myzel] ${(err as Error).message}`);
  process.exit(1);
}

const readOnly = isDemoMode();
checkModelConfig((line) => console.error(line), { optional: readOnly });

const gitAutocommit = !readOnly && process.env.GIT_AUTOCOMMIT === "true";
const kb = new KnowledgeBase(bundleRoot, { gitAutocommit, readOnly });
if (gitAutocommit) {
  try {
    await requireGitReady(kb, "the bundle");
  } catch (err) {
    console.error(`[myzel] ${(err as Error).message}`);
    process.exit(1);
  }
  // stderr: stdout is the MCP protocol stream on this transport.
  console.error("[myzel] git autocommit: enabled");
}
const server = await buildMcpServer(kb);
await server.connect(new StdioServerTransport());
// stdio transport keeps the process alive; logs must go to stderr only.
console.error(
  `[myzel] serving bundle ${bundleRoot} over stdio${readOnly ? " (DEMO_MODE: read-only)" : ""}`
);
