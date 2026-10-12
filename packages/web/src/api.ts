export interface TreeNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: TreeNode[];
}

export interface Concept {
  path: string;
  frontmatter: Record<string, unknown> & { type: string };
  body: string;
}

export interface SearchHit {
  path: string;
  type: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface LogEntry {
  date: string;
  action: "Creation" | "Update" | "Deletion";
  summary: string;
}

export interface ConformanceReport {
  conformant: boolean;
  conceptCount: number;
  directoryCount: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export interface GraphNode {
  path: string;
  title?: string;
  type?: string;
  description?: string;
  links: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export interface TraceStep {
  seq: number;
  tool: string;
  summary: string;
  paths: string[];
  write?: boolean;
}

export interface TraceSummary {
  id: string;
  kind: "query" | "mutation" | "chat";
  input: string;
  startedAt: string;
  durationMs: number;
  notation: string;
  stepCount: number;
}

export interface QueryTrace extends TraceSummary {
  steps: TraceStep[];
  answer: string;
}

export interface AppConfig {
  model: string;
  format: "openai" | "anthropic" | string;
  fallbackConfigured: boolean;
  /** False when the server refuses client-chosen models (ALLOWED_MODELS unset). */
  modelOverride?: boolean;
}

const TOKEN_KEY = "understory-token";

/**
 * The access token lives in sessionStorage: it is gone when the tab closes, so
 * a script injected into the page later cannot harvest a token that has been
 * sitting on disk for months. Storage can be unavailable (private modes,
 * blocked site data) — then it is kept in memory for the life of the page.
 */
let memoryToken = "";

export function getAuthToken(): string {
  try {
    // One-time move of a token saved by older versions in localStorage.
    const legacy = localStorage.getItem(TOKEN_KEY);
    if (legacy) {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.setItem(TOKEN_KEY, legacy);
    }
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setAuthToken(token: string): void {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: memoryToken carries it until the page is closed.
  }
}

/** Headers for API calls — includes the bearer token when one is stored. */
export function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${await res.text()}`);
  return res.json();
}

export const api = {
  tree: () => get<TreeNode>("/api/tree"),
  concept: (path: string) => get<Concept>(`/api/concept?path=${encodeURIComponent(path)}`),
  search: (q: string) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  log: () => get<LogEntry[]>("/api/log"),
  validate: () => get<ConformanceReport>("/api/validate"),
  graph: () => get<GraphData>("/api/graph"),
  traces: () => get<TraceSummary[]>("/api/traces"),
  trace: (id: string) => get<QueryTrace>(`/api/trace?id=${encodeURIComponent(id)}`),
  config: () => get<AppConfig>("/api/config"),
};
