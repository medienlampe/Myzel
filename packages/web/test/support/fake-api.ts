import { vi } from "vitest";

/**
 * A fetch stand-in for the browse/chat API. Routes match on the request path
 * ("/api/tree"); a route returns a JSON body, a Response or a function of
 * the URL. Unrouted paths answer 404. Every call is recorded.
 */
export type Route = unknown | Response | ((url: URL, init?: RequestInit) => unknown);

export interface FakeApi {
  calls: Array<{ path: string; init?: RequestInit }>;
  set(path: string, route: Route): void;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An AI SDK UI message stream (what /api/chat answers with). */
export function uiStream(chunks: Array<Record<string, unknown>>): Response {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join(
    ""
  );
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
}

export function installFakeApi(routes: Record<string, Route> = {}): FakeApi {
  const table = new Map(Object.entries(routes));
  const calls: FakeApi["calls"] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        String(input instanceof Request ? input.url : input),
        "http://localhost/"
      );
      calls.push({ path: url.pathname + url.search, init });
      const route = table.get(url.pathname);
      if (route === undefined) return json({ error: "not found" }, 404);
      const value = typeof route === "function" ? await route(url, init) : route;
      if (value instanceof Response) return value.clone();
      return json(value);
    })
  );
  return { calls, set: (path, route) => table.set(path, route) };
}

// ── Fixtures ──────────────────────────────────────────────────────────

export const TREE = {
  name: "/",
  path: "/",
  kind: "directory",
  children: [
    {
      name: "apis",
      path: "/apis",
      kind: "directory",
      children: [
        {
          name: "billing.md",
          path: "/apis/billing.md",
          kind: "concept",
          type: "API",
          title: "Billing API",
        },
        { name: "index.md", path: "/apis/index.md", kind: "reserved" },
      ],
    },
    { name: "index.md", path: "/index.md", kind: "reserved" },
    { name: "log.md", path: "/log.md", kind: "reserved" },
  ],
};

export const CONCEPT = {
  path: "/apis/billing.md",
  frontmatter: {
    type: "API",
    title: "Billing API",
    description: "Charges customers",
    resource: "https://api.example/billing",
    tags: ["money", { odd: "tag" }],
    timestamp: "2026-10-01T12:00:00.000Z",
    owner: "payments",
  },
  body: "Charges via [Customers](../tables/customers.md) and [docs](https://docs.example).\n\n```js\nconst x = 1;\n```\n",
};

export const LOG = [
  { date: "2026-10-02", action: "Update", summary: "Updated [Billing](/apis/billing.md)." },
  { date: "2026-10-02", action: "Creation", summary: "Added Customers." },
  { date: "2026-10-01", action: "Deletion", summary: "Removed Old." },
];

export const GRAPH = {
  nodes: [
    { path: "/apis/billing.md", title: "Billing API", type: "API", links: 1 },
    { path: "/tables/customers.md", title: "Customers", type: "Table", links: 1 },
    { path: "/notes/stray.md", title: "Stray", type: "Note", links: 0 },
  ],
  edges: [{ source: "/apis/billing.md", target: "/tables/customers.md" }],
};

export const TRACES = [
  {
    id: "t1",
    kind: "query",
    input: "How does billing work?",
    startedAt: "2026-10-02T10:00:00.000Z",
    durationMs: 1200,
    notation: "search → billing.md",
    stepCount: 2,
    usage: { inputTokens: 6200, outputTokens: 320 },
  },
];

export const TRACE = {
  ...TRACES[0],
  answer: "It charges customers.",
  steps: [
    { seq: 1, tool: "search_knowledge", summary: "billing", paths: ["/apis/billing.md"] },
    { seq: 2, tool: "read_concept", summary: "/apis/billing.md", paths: ["/apis/billing.md"] },
    {
      seq: 3,
      tool: "read_concept",
      summary: "/tables/customers.md",
      paths: ["/tables/customers.md"],
    },
  ],
};

export function standardRoutes(): Record<string, Route> {
  return {
    "/api/tree": TREE,
    "/api/validate": { conformant: true, conceptCount: 3, directoryCount: 2, issues: [] },
    "/api/log": LOG,
    "/api/config": {
      model: "fake-model",
      format: "openai",
      fallbackConfigured: true,
      modelOverride: false,
    },
    "/api/profile": { mode: "single", profile: null },
    "/api/concept": CONCEPT,
    "/api/search": [
      { path: "/apis/billing.md", type: "API", title: "Billing API", snippet: "charges" },
    ],
    "/api/graph": GRAPH,
    "/api/traces": TRACES,
    "/api/trace": TRACE,
  };
}
