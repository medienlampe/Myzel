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
  /** Tokens the run consumed, when the provider reported them. */
  usage?: { inputTokens: number; outputTokens: number };
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
  /** Characters of attached text the server accepts per message. */
  attachmentLimit?: number;
}

const TOKEN_KEY = "myzel-token";
/** Key used before the project was renamed from understory. */
const LEGACY_TOKEN_KEY = "understory-token";

/**
 * The access token lives in sessionStorage: it is gone when the tab closes, so
 * a script injected into the page later cannot harvest a token that has been
 * sitting on disk for months. Storage can be unavailable (private modes,
 * blocked site data) — then it is kept in memory for the life of the page.
 */
let memoryToken = "";

/**
 * One-time move of a token kept where older versions put it: localStorage, and
 * the key from before the rename (in either store).
 */
function migrateLegacyToken(): void {
  const slots: [Storage, string][] = [
    [localStorage, TOKEN_KEY],
    [localStorage, LEGACY_TOKEN_KEY],
    [sessionStorage, LEGACY_TOKEN_KEY],
  ];
  for (const [store, key] of slots) {
    const legacy = store.getItem(key);
    if (!legacy) continue;
    store.removeItem(key);
    if (!sessionStorage.getItem(TOKEN_KEY)) sessionStorage.setItem(TOKEN_KEY, legacy);
  }
}

export function getAuthToken(): string {
  try {
    migrateLegacyToken();
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

/** Which memory this session talks to. `profile` is null when the server hosts one memory. */
export interface SessionInfo {
  mode: "single" | "profiles";
  profile: string | null;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** On a 401: whether the server wants a profile key or its single AUTH_TOKEN. */
    public readonly authMode?: SessionInfo["mode"]
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Resolve an API path against the page URL, so calls stay under the prefix
 * when the UI is served behind a path-prefixing reverse proxy
 * (https://host/myzel/), where a root-absolute "/api/…" would escape it.
 */
export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).toString();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    let authMode: SessionInfo["mode"] | undefined;
    try {
      const mode = (JSON.parse(body) as { mode?: unknown }).mode;
      if (mode === "single" || mode === "profiles") authMode = mode;
    } catch {
      // Not JSON: no mode to report.
    }
    throw new ApiError(res.status, `${res.status} ${body}`, authMode);
  }
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
  profile: () => get<SessionInfo>("/api/profile"),
};

/** A setting the settings page can change; mirrors the server's catalog. */
export interface SettingView {
  key: string;
  group: string;
  label: string;
  description: string;
  kind: "text" | "secret" | "url" | "boolean" | "count" | "duration" | "choice";
  /** Applied on the next request; otherwise after a restart. */
  live: boolean;
  fallback?: string;
  choices?: string[];
  source: "settings" | "environment" | "default";
  /** Absent for secrets, which never leave the server. */
  value?: string;
  isSet?: boolean;
}

export interface SettingsData {
  /** False without SETTINGS_FILE: the page is read-only. */
  writable: boolean;
  settings: SettingView[];
}

export interface SettingsSaved extends SettingsData {
  applied: string[];
  restart: string[];
}

/**
 * The admin token is kept in memory only: it can change what the server runs
 * on, so unlike the memory's token it is not stored at all — a reload asks
 * for it again.
 */
let adminToken = "";
export const getAdminToken = () => adminToken;
export const setAdminToken = (token: string) => {
  adminToken = token;
};

async function admin<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const error = (await res.json()) as { error?: unknown };
      if (typeof error.error === "string") message = error.error;
    } catch {
      // Not JSON: the status has to do.
    }
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export const adminApi = {
  settings: () => admin<SettingsData>("GET", "/admin/settings"),
  /** A string sets a value; null goes back to the environment's. */
  saveSettings: (changes: Record<string, string | null>) =>
    admin<SettingsSaved>("PUT", "/admin/settings", { changes }),
};
