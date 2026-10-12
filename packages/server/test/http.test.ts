import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { KnowledgeBase } from "@myzel/core";
import { chatRouter } from "../src/api/chat.js";
import { mcpRouter } from "../src/mcp/http.js";
import { LIMITS } from "../src/limits.js";

let root: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "http-test-"));
  const kb = new KnowledgeBase(root);
  await kb.writeConcept("/notes/a.md", { type: "Note", title: "Alpha" }, "body", "Added a.");
  const app = express();
  app.use(express.json({ limit: LIMITS.jsonBody }));
  app.use("/mcp", mcpRouter(kb));
  app.use("/api", chatRouter(kb));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await fs.rm(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("/api/chat request validation (no model call)", () => {
  const user = (text: string) => ({ id: "1", role: "user", parts: [{ type: "text", text }] });

  it("rejects a malformed body with 400", async () => {
    const res = await post("/api/chat", { messages: [] });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized user turn with 413", async () => {
    const res = await post("/api/chat", { messages: [user("x".repeat(LIMITS.chatTurn + 1))] });
    expect(res.status).toBe(413);
  });

  it("refuses a client-chosen model when ALLOWED_MODELS is unset", async () => {
    const res = await post("/api/chat", { messages: [user("hi")], model: "pricey-model" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/client-chosen models are disabled/);
  });
});

describe("/mcp over streamable HTTP", () => {
  const rpc = (method: string, params: unknown = {}) =>
    post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      { Accept: "application/json, text/event-stream" }
    ).then((r) => r.json());

  it("initializes with the seed overview as instructions", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(res.result.serverInfo.name).toBe("myzel");
    expect(res.result.instructions).toContain("Alpha");
  });

  it("lists the five memory tools with bounded inputs", async () => {
    const res = await rpc("tools/list");
    const tools = res.result.tools as { name: string; inputSchema: { properties: object } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_add",
      "memory_maintain",
      "memory_query",
      "memory_status",
      "memory_update",
    ]);
    const query = tools.find((t) => t.name === "memory_query")!;
    expect(JSON.stringify(query.inputSchema)).toContain(`"maxLength":${LIMITS.question}`);
  });

  it("refuses an oversized question before any model call", async () => {
    const res = await rpc("tools/call", {
      name: "memory_query",
      arguments: { question: "x".repeat(LIMITS.question + 1) },
    });
    const text = JSON.stringify(res);
    expect(text).toMatch(/too_big|at most|Too big/i);
  });
});
