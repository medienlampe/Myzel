import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseDuration, resolveFallbackConfig, resolveModelConfig } from "@myzel/core";

/**
 * Settings that can be changed from the web UI (behind ADMIN_TOKEN). They are
 * saved to SETTINGS_FILE, whose values override the environment, and applied
 * by writing process.env — every setting marked `live` is read where it is
 * used, so the next request sees it; the others are read at startup.
 *
 * Only model and behaviour settings are in this catalog. Network and access
 * settings (HOST, PORT, AUTH_TOKEN, ADMIN_TOKEN, ALLOWED_ORIGINS/HOSTS,
 * TRUST_PROXY, BUNDLE_ROOT, PROFILES_ROOT, SETTINGS_FILE) stay env-only, so a
 * change in the UI can neither lock anyone out nor widen who gets in — and the
 * file cannot set them either: unknown keys in it are ignored.
 */

export type SettingKind = "text" | "secret" | "url" | "boolean" | "count" | "duration" | "choice";

export interface SettingSpec {
  key: string;
  group: string;
  label: string;
  description: string;
  kind: SettingKind;
  /** Applied on the next request; otherwise at the next restart. */
  live: boolean;
  /** What applies when nothing is set, for display. */
  fallback?: string;
  choices?: string[];
}

const MODEL = "Primary model";
const FALLBACK = "Fallback model";
const RUNS = "Agent runs";
const MEMORY = "Memory layers";
const BACKGROUND = "Dreaming and git";
const LIMITS = "Rate limits";

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: "LLM_API_BASE_URL",
    group: MODEL,
    label: "API base URL",
    description: "Any OpenAI- or Anthropic-compatible endpoint, e.g. https://api.deepseek.com/v1.",
    kind: "url",
    live: true,
  },
  {
    key: "LLM_API_KEY",
    group: MODEL,
    label: "API key",
    description: "Sent to the endpoint above. Never shown again once saved.",
    kind: "secret",
    live: true,
  },
  {
    key: "LLM_API_FORMAT",
    group: MODEL,
    label: "API format",
    description: "Which API the endpoint speaks.",
    kind: "choice",
    choices: ["openai", "anthropic"],
    fallback: "openai",
    live: true,
  },
  {
    key: "LLM_MODEL",
    group: MODEL,
    label: "Model",
    description:
      "Model id to request. Empty on an OpenAI-compatible endpoint: discovered from /v1/models.",
    kind: "text",
    fallback: "auto-discovered",
    live: true,
  },
  {
    key: "ALLOWED_MODELS",
    group: MODEL,
    label: "Models clients may pick",
    description:
      'Comma-separated ids a client may request instead (the chat\'s model field), "*" for any. Empty: none.',
    kind: "text",
    live: true,
  },
  {
    key: "LLM_FALLBACK_API_BASE_URL",
    group: FALLBACK,
    label: "API base URL",
    description: "Used when the primary model fails with a retryable error. Empty: no fallback.",
    kind: "url",
    live: true,
  },
  {
    key: "LLM_FALLBACK_API_KEY",
    group: FALLBACK,
    label: "API key",
    description: "Sent to the fallback endpoint. Never shown again once saved.",
    kind: "secret",
    live: true,
  },
  {
    key: "LLM_FALLBACK_API_FORMAT",
    group: FALLBACK,
    label: "API format",
    description: "Which API the fallback endpoint speaks.",
    kind: "choice",
    choices: ["openai", "anthropic"],
    fallback: "openai",
    live: true,
  },
  {
    key: "LLM_FALLBACK_MODEL",
    group: FALLBACK,
    label: "Model",
    description:
      "Model id at the fallback endpoint. Empty on an OpenAI-compatible one: discovered.",
    kind: "text",
    fallback: "auto-discovered",
    live: true,
  },
  {
    key: "LLM_FALLBACK_ALLOW_FOR",
    group: FALLBACK,
    label: "Allowed for",
    description: "Which runs may fail over: query, mutate, chat (comma-separated). Empty: all.",
    kind: "text",
    fallback: "all runs",
    live: true,
  },
  {
    key: "LLM_FALLBACK_RETRY_429",
    group: FALLBACK,
    label: "Fail over on HTTP 429",
    description:
      "A 429 usually means “slow down”; moving the load to a second model may cost more.",
    kind: "boolean",
    fallback: "false",
    live: true,
  },
  {
    key: "LLM_TIMEOUT",
    group: RUNS,
    label: "Run time limit",
    description: "Ceiling for one agent run, the whole tool loop included.",
    kind: "duration",
    fallback: "30m",
    live: true,
  },
  {
    key: "LLM_MAX_STEPS",
    group: RUNS,
    label: "Step budget",
    description: "Tool-loop steps per run. Local models often need more than hosted ones.",
    kind: "count",
    fallback: "12",
    live: true,
  },
  {
    key: "LLM_DISCOVERY_TIMEOUT",
    group: RUNS,
    label: "Model discovery timeout",
    description: "How long to wait for /v1/models when no model id is set.",
    kind: "duration",
    fallback: "10s",
    live: true,
  },
  {
    key: "QUERY_CACHE",
    group: MEMORY,
    label: "Query cache",
    description: "Repeated questions answer from cache until the memory changes.",
    kind: "boolean",
    fallback: "true",
    live: true,
  },
  {
    key: "QUERY_CACHE_TTL",
    group: MEMORY,
    label: "Query cache lifetime",
    description: "How long a cached answer stays valid.",
    kind: "duration",
    fallback: "24h",
    live: true,
  },
  {
    key: "HOT_MEMORY",
    group: MEMORY,
    label: "Hot memory",
    description: "Answer from recent writes and answers with one cheap call before a full run.",
    kind: "boolean",
    fallback: "true",
    live: true,
  },
  {
    key: "HOT_MEMORY_TTL",
    group: MEMORY,
    label: "Hot memory lifetime",
    description: "How long writes and answers stay in the working set.",
    kind: "duration",
    fallback: "1h",
    live: true,
  },
  {
    key: "HOT_MEMORY_TIMEOUT",
    group: MEMORY,
    label: "Hot memory timeout",
    description: "Give up on the hot lookup after this long and run the full agent.",
    kind: "duration",
    fallback: "1m",
    live: true,
  },
  {
    key: "HOT_MEMORY_RECALL_QA",
    group: MEMORY,
    label: "Recall recent answers",
    description:
      "Recent Q&A pairs are other callers' conversations — turn off on a shared instance.",
    kind: "boolean",
    fallback: "true",
    live: true,
  },
  {
    key: "DREAM_INTERVAL",
    group: BACKGROUND,
    label: "Dreaming interval",
    description: "Tidy the graph on a schedule, e.g. 6h (at least 5m). Empty: off.",
    kind: "duration",
    fallback: "off",
    live: false,
  },
  {
    key: "DREAM_INSIGHTS",
    group: BACKGROUND,
    label: "Dream insights",
    description:
      "Let a dream also connect concepts after recent activity, not only repair the graph.",
    kind: "boolean",
    fallback: "true",
    live: true,
  },
  {
    key: "GIT_AUTOCOMMIT",
    group: BACKGROUND,
    label: "Git autocommit",
    description:
      "Commit the memory after every change. Checked at startup: the server refuses to start if committing cannot work.",
    kind: "boolean",
    fallback: "false",
    live: false,
  },
  {
    key: "RATE_LIMIT",
    group: LIMITS,
    label: "Agent requests per window",
    description: "Per client on /mcp and /api/chat, which can start agent runs. 0 disables.",
    kind: "count",
    fallback: "60",
    live: false,
  },
  {
    key: "RATE_LIMIT_WINDOW",
    group: LIMITS,
    label: "Window",
    description: "The window both rate limits count in.",
    kind: "duration",
    fallback: "1m",
    live: false,
  },
  {
    key: "RATE_LIMIT_BROWSE",
    group: LIMITS,
    label: "Browse requests per window",
    description: "Per client on the read-only /api routes. 0 disables.",
    kind: "count",
    fallback: "600",
    live: false,
  },
];

const SPEC = new Map(SETTINGS.map((s) => [s.key, s]));

/** Endpoint settings and the key each one is sent. */
const ENDPOINT_KEYS = [
  ["LLM_API_BASE_URL", "LLM_API_KEY"],
  ["LLM_FALLBACK_API_BASE_URL", "LLM_FALLBACK_API_KEY"],
] as const;

/** A setting as the UI sees it. Secrets never leave the server. */
export interface SettingView extends SettingSpec {
  /** Where the effective value comes from. */
  source: "settings" | "environment" | "default";
  /** The effective value; absent for secrets. */
  value?: string;
  /** Whether a secret has a value. */
  isSet?: boolean;
}

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 500,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

/** Generous for URLs and model lists; no setting needs more. */
const MAX_VALUE = 2_000;

function validate(spec: SettingSpec, value: string): string | null {
  if (value.length > MAX_VALUE) return `at most ${MAX_VALUE} characters`;
  // A value lands in an environment variable and possibly a header: one line.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value))
    return "must be a single line without control characters";
  if (value === "") {
    return ["text", "secret", "url"].includes(spec.kind) ? null : "must not be empty";
  }
  switch (spec.kind) {
    case "url":
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? null : "must be an http(s) URL";
      } catch {
        return "must be a URL";
      }
    case "boolean":
      return value === "true" || value === "false" ? null : 'must be "true" or "false"';
    case "count":
      return /^\d{1,9}$/.test(value) ? null : "must be a whole number";
    case "duration":
      return parseDuration(value) !== null
        ? null
        : 'must be a duration like "30s", "15m", "6h" or "1d"';
    case "choice":
      return spec.choices?.includes(value) ? null : `must be one of ${spec.choices?.join(", ")}`;
    default:
      return null;
  }
}

/** Compose passes unset variables as empty strings: those count as not set. */
const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

export class SettingsStore {
  /** The environment's own values, before the file was applied. */
  private readonly base: Record<string, string | undefined> = {};
  private overrides: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    /** null: SETTINGS_FILE is unset, so settings can be viewed but not saved. */
    readonly file: string | null,
    private readonly env: NodeJS.ProcessEnv
  ) {
    for (const { key } of SETTINGS) this.base[key] = env[key];
  }

  /**
   * Read SETTINGS_FILE and apply it to `env`. A missing file is an empty one;
   * an unreadable or invalid one throws, so the server refuses to start rather
   * than run on settings nobody chose.
   */
  static async load(
    file: string | null,
    env: NodeJS.ProcessEnv = process.env,
    warn: (line: string) => void = console.warn
  ): Promise<SettingsStore> {
    const store = new SettingsStore(file ? path.resolve(file) : null, env);
    if (!store.file) return store;
    let raw: string;
    try {
      raw = await fs.readFile(store.file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw new Error(`cannot read SETTINGS_FILE ${store.file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`SETTINGS_FILE ${store.file} is not valid JSON`, { cause: err });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`SETTINGS_FILE ${store.file} must hold a JSON object`);
    }
    for (const [key, value] of Object.entries(parsed)) {
      const spec = SPEC.get(key);
      if (!spec) {
        warn(
          `[myzel] SETTINGS_FILE: ignoring "${key.slice(0, 100)}" — not a setting the UI manages`
        );
        continue;
      }
      const problem = typeof value === "string" ? validate(spec, value) : "must be a string";
      if (problem) throw new Error(`SETTINGS_FILE ${store.file}: ${key} ${problem}`);
      store.overrides[key] = value as string;
      env[key] = value as string;
    }
    return store;
  }

  get writable(): boolean {
    return this.file !== null;
  }

  describe(): SettingView[] {
    return SETTINGS.map((spec) => {
      const value = this.env[spec.key];
      const source =
        spec.key in this.overrides
          ? "settings"
          : isSet(this.base[spec.key])
            ? "environment"
            : "default";
      return spec.kind === "secret"
        ? { ...spec, source, isSet: isSet(value) }
        : { ...spec, source, value: value ?? "" };
    });
  }

  /**
   * Apply changes: a string sets an override, null drops it (back to the
   * environment's value). All-or-nothing — every value is validated, and the
   * resulting model configuration must resolve, before anything is written.
   */
  update(changes: Record<string, unknown>): Promise<{ applied: string[]; restart: string[] }> {
    const run = this.queue.then(() => this.apply(changes));
    this.queue = run.catch(() => {});
    return run;
  }

  private async apply(
    changes: Record<string, unknown>
  ): Promise<{ applied: string[]; restart: string[] }> {
    if (!this.file) {
      throw new SettingsError("settings cannot be saved: SETTINGS_FILE is not set", 409);
    }
    const next = { ...this.overrides };
    for (const [key, value] of Object.entries(changes)) {
      const spec = SPEC.get(key);
      if (!spec) throw new SettingsError(`unknown setting "${key.slice(0, 100)}"`, 400);
      if (value === null) {
        delete next[key];
        continue;
      }
      if (typeof value !== "string")
        throw new SettingsError(`${key} must be a string or null`, 400);
      const problem = validate(spec, value);
      if (problem) throw new SettingsError(`${key} ${problem}`, 400);
      next[key] = value;
    }

    const candidate: NodeJS.ProcessEnv = { ...this.env };
    for (const { key } of SETTINGS) {
      if (key in next) candidate[key] = next[key];
      else if (this.base[key] === undefined) delete candidate[key];
      else candidate[key] = this.base[key];
    }
    // An endpoint other than the environment's must use a key set here too:
    // otherwise an admin could point the URL at their own host and receive the
    // environment's key, which was never shown to them.
    for (const [url, key] of ENDPOINT_KEYS) {
      if (candidate[url] && candidate[url] !== this.base[url] && !(key in next)) {
        throw new SettingsError(`changing ${url} requires setting ${key} as well`, 400);
      }
    }
    try {
      resolveModelConfig(candidate);
      resolveFallbackConfig(candidate);
    } catch (err) {
      throw new SettingsError(`the model settings would not work: ${(err as Error).message}`, 400, {
        cause: err,
      });
    }

    await writePrivate(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.overrides = next;
    const changed = SETTINGS.filter(({ key }) => candidate[key] !== this.env[key]);
    for (const { key } of changed) {
      if (candidate[key] === undefined) delete this.env[key];
      else this.env[key] = candidate[key];
    }
    return {
      applied: changed.filter((s) => s.live).map((s) => s.key),
      restart: changed.filter((s) => !s.live).map((s) => s.key),
    };
  }
}

/**
 * Atomic write (temp file + rename) of a file only its owner can read: it
 * holds API keys. The temp name is random and created exclusively, so a
 * planted symlink cannot redirect the write.
 */
async function writePrivate(file: string, content: string): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new SettingsError(`settings could not be saved: ${(err as Error).message}`, 500, {
      cause: err,
    });
  }
}
