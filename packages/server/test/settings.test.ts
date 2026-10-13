import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@myzel/core";
import { listen } from "./support/serve.js";
import { buildApp, type App } from "../src/app.js";
import { adminRouter } from "../src/admin.js";
import { singleMemoryHost } from "../src/host.js";
import { SETTINGS, SettingsStore } from "../src/settings.js";

let dir: string;
let file: string;
let env: NodeJS.ProcessEnv;
let closers: Array<() => void> = [];

const MODEL_ENV = {
  LLM_API_BASE_URL: "http://127.0.0.1:9/v1",
  LLM_API_KEY: "env-key",
  LLM_API_FORMAT: "openai",
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-settings-"));
  file = path.join(dir, "config", "settings.json");
  env = { ...MODEL_ENV, RATE_LIMIT: "" };
});

afterEach(async () => {
  for (const close of closers) close();
  closers = [];
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const view = (store: SettingsStore, key: string) => store.describe().find((s) => s.key === key)!;

describe("SettingsStore", () => {
  it("starts empty without a file, and applies the file over the environment", async () => {
    const empty = await SettingsStore.load(file, env);
    expect(view(empty, "LLM_MODEL")).toMatchObject({ source: "default", value: "" });
    // Compose passes unset variables as empty strings: still "default".
    expect(view(empty, "RATE_LIMIT").source).toBe("default");

    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify({ LLM_MODEL: "from-file", AUTH_TOKEN: "sneaky" }));
    const warn = vi.fn();
    const store = await SettingsStore.load(file, env, warn);
    expect(env.LLM_MODEL).toBe("from-file");
    expect(view(store, "LLM_MODEL")).toMatchObject({ source: "settings", value: "from-file" });
    expect(view(store, "LLM_API_FORMAT").source).toBe("environment");
    // Access settings are not the file's to set.
    expect(env.AUTH_TOKEN).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring "AUTH_TOKEN"'));
  });

  it("refuses to start on a file it cannot trust", async () => {
    await fs.mkdir(path.dirname(file));
    for (const [content, message] of [
      ["{ nope", /not valid JSON/],
      ["[1]", /must hold a JSON object/],
      ['{"LLM_MAX_STEPS": 5}', /LLM_MAX_STEPS must be a string/],
      ['{"LLM_TIMEOUT": "soon"}', /LLM_TIMEOUT must be a duration/],
    ] as const) {
      await fs.writeFile(file, content);
      await expect(SettingsStore.load(file, { ...MODEL_ENV })).rejects.toThrow(message);
    }
    await expect(SettingsStore.load(dir, { ...MODEL_ENV })).rejects.toThrow(/cannot read/);
  });

  it("saves changes to a private file, applies them and reports which need a restart", async () => {
    const store = await SettingsStore.load(file, env);
    const result = await store.update({
      LLM_MODEL: "new-model",
      LLM_API_KEY: "new-key",
      RATE_LIMIT: "10",
    });
    expect(result).toEqual({ applied: ["LLM_API_KEY", "LLM_MODEL"], restart: ["RATE_LIMIT"] });
    expect(env).toMatchObject({ LLM_MODEL: "new-model", LLM_API_KEY: "new-key", RATE_LIMIT: "10" });
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({
      LLM_MODEL: "new-model",
      LLM_API_KEY: "new-key",
      RATE_LIMIT: "10",
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // The secret's value never leaves the store.
    expect(view(store, "LLM_API_KEY")).toMatchObject({ source: "settings", isSet: true });
    expect(view(store, "LLM_API_KEY")).not.toHaveProperty("value");

    // null drops an override: back to the environment's value, or unset.
    const reverted = await store.update({ LLM_API_KEY: null, LLM_MODEL: null, RATE_LIMIT: "10" });
    expect(reverted).toEqual({ applied: ["LLM_API_KEY", "LLM_MODEL"], restart: [] });
    expect(env.LLM_API_KEY).toBe("env-key");
    expect(env).not.toHaveProperty("LLM_MODEL");
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({ RATE_LIMIT: "10" });
    expect(await fs.readdir(path.dirname(file))).toEqual(["settings.json"]);
  });

  it("validates every value and the resulting model setup before writing anything", async () => {
    const store = await SettingsStore.load(file, env);
    const refused = async (changes: Record<string, unknown>, message: RegExp) => {
      await expect(store.update(changes)).rejects.toThrow(message);
      await expect(fs.stat(file)).rejects.toThrow();
    };
    await refused({ AUTH_TOKEN: "x" }, /unknown setting "AUTH_TOKEN"/);
    await refused({ LLM_MODEL: 5 }, /must be a string or null/);
    await refused({ LLM_API_BASE_URL: "file:///etc/passwd" }, /http\(s\) URL/);
    await refused({ LLM_API_BASE_URL: "not a url" }, /must be a URL/);
    await refused({ LLM_API_FORMAT: "gemini" }, /one of openai, anthropic/);
    await refused({ QUERY_CACHE: "yes" }, /"true" or "false"/);
    await refused({ LLM_MAX_STEPS: "-1" }, /whole number/);
    await refused({ HOT_MEMORY_TTL: "" }, /must not be empty/);
    await refused({ LLM_MODEL: "a\nINJECTED=1" }, /single line/);
    await refused({ LLM_MODEL: "x".repeat(2_001) }, /at most 2000/);
    await refused({ LLM_API_BASE_URL: "" }, /model settings would not work: No LLM configured/);
    // A rejected batch changes nothing, even its valid parts.
    await refused({ LLM_MODEL: "fine", LLM_TIMEOUT: "never" }, /LLM_TIMEOUT/);
    expect(env.LLM_MODEL).toBeUndefined();
  });

  it("refuses a new endpoint without its key, so the env key cannot be redirected", async () => {
    const store = await SettingsStore.load(file, env);
    const url = "https://elsewhere.example/v1";
    await expect(store.update({ LLM_API_BASE_URL: url })).rejects.toThrow(/requires .*LLM_API_KEY/);
    await expect(store.update({ LLM_FALLBACK_API_BASE_URL: url })).rejects.toThrow(
      /requires .*LLM_FALLBACK_API_KEY/
    );
    // Naming the key with null falls back to the env key: refused too.
    await expect(store.update({ LLM_API_BASE_URL: url, LLM_API_KEY: null })).rejects.toThrow(
      /requires/
    );
    await store.update({ LLM_API_BASE_URL: url, LLM_API_KEY: "new-key" });
    expect(env.LLM_API_BASE_URL).toBe(url);
    // Dropping the key later would hand the new endpoint the env key.
    await expect(store.update({ LLM_API_KEY: null })).rejects.toThrow(/requires/);
    expect(env.LLM_API_KEY).toBe("new-key");
  });

  it("is read-only without SETTINGS_FILE", async () => {
    const store = await SettingsStore.load(null, env);
    expect(store.writable).toBe(false);
    await expect(store.update({ LLM_MODEL: "x" })).rejects.toThrow(/SETTINGS_FILE is not set/);
  });

  it("reports a file it cannot write", async () => {
    const store = await SettingsStore.load(file, env);
    await fs.writeFile(path.join(dir, "config"), "a file where the directory should be");
    await expect(store.update({ LLM_MODEL: "x" })).rejects.toThrow(/could not be saved/);
    expect(env.LLM_MODEL).toBeUndefined();
  });

  it("covers only model and behaviour settings", () => {
    const keys = SETTINGS.map((s) => s.key);
    for (const key of [
      "HOST",
      "PORT",
      "AUTH_TOKEN",
      "ADMIN_TOKEN",
      "ALLOWED_ORIGINS",
      "ALLOWED_HOSTS",
      "TRUST_PROXY",
      "BUNDLE_ROOT",
      "PROFILES_ROOT",
      "SETTINGS_FILE",
    ]) {
      expect(keys).not.toContain(key);
    }
  });
});

describe("settings API", () => {
  const ADMIN = "admin-secret-token";

  async function serve(store: SettingsStore): Promise<string> {
    const kb = new KnowledgeBase(dir);
    const built: App = buildApp(singleMemoryHost(kb, "memory-token"), {
      guard: { allowedOrigins: [], allowedHosts: [], hostPolicy: "loopback" },
      rateLimit: { limit: 0, windowMs: 60_000 },
      browseLimit: 0,
      admin: adminRouter(null, ADMIN, async () => {}, undefined, store),
    });
    const { base, close } = await listen(built.app);
    closers.push(close, () => built.close());
    return base;
  }

  const call = (base: string, method: string, token: string, body?: unknown) =>
    fetch(`${base}/admin/settings`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("needs the admin token — the memory's own token is not enough", async () => {
    const base = await serve(await SettingsStore.load(file, env));
    expect((await call(base, "GET", "memory-token")).status).toBe(401);
    expect((await fetch(`${base}/admin/settings`)).status).toBe(401);
    // Outside profile mode there are no profile routes.
    expect(
      (await fetch(`${base}/admin/profiles`, { headers: { authorization: `Bearer ${ADMIN}` } }))
        .status
    ).toBe(404);
  });

  it("lists the settings without secrets, and applies a change live", async () => {
    for (const [k, v] of Object.entries(MODEL_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("LLM_MODEL", "before");
    const base = await serve(await SettingsStore.load(file));
    const listed = await (await call(base, "GET", ADMIN)).json();
    expect(listed.writable).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("env-key");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await call(base, "PUT", ADMIN, {
      changes: { LLM_MODEL: "after", LLM_API_KEY: "s3cret" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toEqual(["LLM_API_KEY", "LLM_MODEL"]);
    expect(JSON.stringify(body)).not.toContain("s3cret");
    expect(log).toHaveBeenCalledWith("[myzel] settings changed: LLM_API_KEY, LLM_MODEL");
    expect(JSON.stringify(log.mock.calls)).not.toContain("s3cret");
    // The next request sees it.
    const config = await fetch(`${base}/api/config`, {
      headers: { authorization: "Bearer memory-token" },
    }).then((r) => r.json());
    expect(config.model).toBe("after");
  });

  it("answers bad requests with a reason", async () => {
    const base = await serve(await SettingsStore.load(file, env));
    expect((await call(base, "PUT", ADMIN, { LLM_MODEL: "x" })).status).toBe(400);
    expect((await call(base, "PUT", ADMIN, { changes: [] })).status).toBe(400);
    const res = await call(base, "PUT", ADMIN, { changes: { LLM_TIMEOUT: "never" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/LLM_TIMEOUT must be a duration/);

    const readOnly = await serve(await SettingsStore.load(null, env));
    const refused = await call(readOnly, "PUT", ADMIN, { changes: { LLM_MODEL: "x" } });
    expect(refused.status).toBe(409);
  });
});
