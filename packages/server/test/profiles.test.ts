import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KnowledgeBase } from "@myzel/core";
import { listen } from "./support/serve.js";
import { buildApp, type App } from "../src/app.js";
import { adminRouter } from "../src/admin.js";
import { profileMemoryHost, singleMemoryHost, type MemoryHost } from "../src/host.js";
import { ProfileError, ProfileRegistry } from "../src/profiles.js";

let root: string;
let registry: ProfileRegistry;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "myzel-profiles-"));
  registry = new ProfileRegistry(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ProfileRegistry", () => {
  it("creates a profile with its own bundle directory and resolves it by key", async () => {
    const { name, key } = await registry.create("work");
    expect(name).toBe("work");
    expect(key).toMatch(/^myz_[A-Za-z0-9_-]{32}$/);
    await expect(fs.stat(path.join(root, "work"))).resolves.toBeTruthy();
    const resolved = await registry.resolve(key);
    expect(resolved?.name).toBe("work");
    expect(resolved?.kb.bundle.root).toBe(path.join(root, "work"));
  });

  it("stores only a hash of the key, in an owner-only file", async () => {
    const { key } = await registry.create("work");
    const file = path.join(root, "profiles.json");
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).not.toContain(key);
    expect(raw).toMatch(/"keyHash": "[0-9a-f]{64}"/);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("rejects unknown, empty and near-miss keys", async () => {
    const { key } = await registry.create("work");
    expect(await registry.resolve("")).toBeNull();
    expect(await registry.resolve("myz_nope")).toBeNull();
    expect(await registry.resolve(key.slice(0, -1))).toBeNull();
    expect(await registry.resolve(key + "x")).toBeNull();
  });

  it.each(["", "..", "../x", "a/b", "Work", ".hidden", "a".repeat(64), "-x", "profiles.json"])(
    "rejects the name %j",
    async (name) => {
      await expect(registry.create(name)).rejects.toMatchObject({ code: "INVALID_NAME" });
    }
  );

  it("refuses duplicate names", async () => {
    await registry.create("work");
    await expect(registry.create("work")).rejects.toMatchObject({ code: "EXISTS" });
  });

  it("returns the same KnowledgeBase instance for a profile every time", async () => {
    const { key } = await registry.create("work");
    const a = await registry.resolve(key);
    const b = await registry.resolve(key);
    expect(a?.kb).toBe(b?.kb);
    expect((await registry.memories())[0].kb).toBe(a?.kb);
  });

  it("rotating a key invalidates the old one and keeps the memory", async () => {
    const { key: old } = await registry.create("work");
    await (await registry.resolve(old))!.kb.writeConcept("/a.md", { type: "T" }, "x", "Added a.");
    const { key } = await registry.rotate("work");
    expect(await registry.resolve(old)).toBeNull();
    const kb = (await registry.resolve(key))!.kb;
    expect((await kb.readConcept("/a.md")).body).toContain("x");
  });

  it("removing revokes the key but keeps the memory unless purged", async () => {
    const { key } = await registry.create("work");
    await registry.remove("work");
    expect(await registry.resolve(key)).toBeNull();
    await expect(fs.stat(path.join(root, "work"))).resolves.toBeTruthy();

    await registry.create("work"); // adopts the kept directory
    await registry.remove("work", { purge: true });
    await expect(fs.stat(path.join(root, "work"))).rejects.toThrow();
  });

  it("reports unknown profiles on rotate and remove", async () => {
    await expect(registry.rotate("ghost")).rejects.toBeInstanceOf(ProfileError);
    await expect(registry.remove("ghost")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("picks up changes made by another process (the CLI) without a restart", async () => {
    const { key } = await registry.create("work");
    expect((await registry.resolve(key))?.name).toBe("work");
    const cli = new ProfileRegistry(root); // stands in for the CLI
    const { key: personal } = await cli.create("personal");
    await cli.remove("work");
    expect((await registry.resolve(personal))?.name).toBe("personal");
    expect(await registry.resolve(key)).toBeNull();
  });

  it("keeps every change when many mutations run at once in one process", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const created = await Promise.all(names.map((n) => registry.create(n)));
    expect((await registry.list()).map((p) => p.name).sort()).toEqual([...names].sort());
    for (const { name, key } of created) expect((await registry.resolve(key))?.name).toBe(name);
  });

  it("lets exactly one of two simultaneous creates for the same name win", async () => {
    const results = await Promise.allSettled([registry.create("dup"), registry.create("dup")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({
      code: "EXISTS",
    });
  });

  it("keeps every change when two processes mutate at once", async () => {
    const a = new ProfileRegistry(root);
    const b = new ProfileRegistry(root);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => [a.create(`a${i}`), b.create(`b${i}`)]).flat()
    );
    expect(await new ProfileRegistry(root).list()).toHaveLength(16);
  });

  it("never undoes a revocation because another process wrote at the same moment", async () => {
    const a = new ProfileRegistry(root);
    const b = new ProfileRegistry(root);
    const { key } = await a.create("victim");
    await b.list(); // b now holds a copy that includes "victim"
    await Promise.all([a.remove("victim"), b.create("other")]);
    const fresh = new ProfileRegistry(root);
    expect(await fresh.resolve(key)).toBeNull();
    expect((await fresh.list()).map((p) => p.name)).toEqual(["other"]);
  });

  it("recovers from a lock left behind by a crashed process", async () => {
    const lock = path.join(root, "profiles.json.lock");
    await fs.writeFile(lock, "crashed");
    const longAgo = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(lock, longAgo, longAgo);
    await expect(registry.create("after-crash")).resolves.toMatchObject({ name: "after-crash" });
  });

  it("never lets an overtaken read bring a revoked key back", async () => {
    const cli = new ProfileRegistry(root);
    const { key } = await cli.create("victim"); // registry's view is now out of date
    // Hold registry's next (unlocked) read of profiles.json until after the revocation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readFile = fs.readFile.bind(fs);
    let first = true;
    vi.spyOn(fs, "readFile").mockImplementation((async (
      ...args: Parameters<typeof fs.readFile>
    ) => {
      const content = await readFile(...args);
      if (first && String(args[0]).endsWith("profiles.json")) {
        first = false;
        await gate;
      }
      return content;
    }) as typeof fs.readFile);

    const stale = registry.resolve(key); // reads the registry while "victim" still exists
    await registry.remove("victim");
    release();
    await stale;
    expect(await registry.resolve(key)).toBeNull();
  });

  it("gives a profile re-created under the same name a fresh memory", async () => {
    const { key } = await registry.create("work");
    const old = (await registry.resolve(key))!.kb;
    const cli = new ProfileRegistry(root);
    await cli.remove("work", { purge: true });
    const { key: fresh } = await cli.create("work");
    expect((await registry.resolve(fresh))!.kb).not.toBe(old);
    await expect(old.writeConcept("/x.md", { type: "T" }, "x", "Added.")).rejects.toMatchObject({
      code: "CLOSED",
    });
  });

  it("closes a removed profile so requests still holding it cannot recreate it", async () => {
    const { key } = await registry.create("work");
    const kb = (await registry.resolve(key))!.kb;
    await registry.remove("work", { purge: true });
    await expect(kb.writeConcept("/x.md", { type: "T" }, "x", "Added.")).rejects.toMatchObject({
      code: "CLOSED",
    });
    await expect(fs.stat(path.join(root, "work"))).rejects.toThrow();
  });

  it("drains the writes of every memory it opened, removed ones included", async () => {
    const { key } = await registry.create("work");
    const kb = (await registry.resolve(key))!.kb;
    const write = kb.writeConcept("/x.md", { type: "T" }, "x", "Added.");
    await registry.drain();
    await expect(write).resolves.toBeTruthy();
  });

  it("treats a dangling lock symlink like any other lock (taken over once stale)", async () => {
    const lock = path.join(root, "profiles.json.lock");
    await fs.symlink(path.join(root, "nowhere"), lock);
    const longAgo = new Date(Date.now() - 5 * 60_000);
    await fs.lutimes(lock, longAgo, longAgo);
    await expect(registry.create("after")).resolves.toMatchObject({ name: "after" });
  });

  it("fails closed on duplicate names or keys in a hand-edited registry", async () => {
    const entry = { name: "a", keyHash: "1".repeat(64), createdAt: "x" };
    for (const profiles of [
      [entry, { ...entry, keyHash: "2".repeat(64) }],
      [entry, { ...entry, name: "b" }],
    ]) {
      await fs.writeFile(
        path.join(root, "profiles.json"),
        JSON.stringify({ version: 1, profiles })
      );
      await expect(new ProfileRegistry(root).list()).rejects.toMatchObject({
        code: "CORRUPT_REGISTRY",
      });
    }
  });

  it("fails closed when the registry file is corrupt or malformed", async () => {
    const { key } = await registry.create("work");
    await fs.writeFile(path.join(root, "profiles.json"), "{ not json");
    await expect(new ProfileRegistry(root).resolve(key)).rejects.toMatchObject({
      code: "CORRUPT_REGISTRY",
    });
    await fs.writeFile(
      path.join(root, "profiles.json"),
      JSON.stringify({ version: 1, profiles: [{ name: "../x", keyHash: "0".repeat(64) }] })
    );
    await expect(new ProfileRegistry(root).list()).rejects.toMatchObject({
      code: "CORRUPT_REGISTRY",
    });
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────

const GUARD = { allowedOrigins: [], allowedHosts: [], hostPolicy: "loopback" as const };
let built: App | undefined;
let closeServer: (() => void) | undefined;

afterEach(() => {
  closeServer?.();
  built?.close();
  closeServer = built = undefined;
});

async function serve(host: MemoryHost, admin?: ReturnType<typeof adminRouter>): Promise<string> {
  built = buildApp(host, {
    guard: GUARD,
    rateLimit: { limit: 0, windowMs: 60_000 },
    browseLimit: 0,
    admin,
  });
  const { base, close } = await listen(built.app);
  closeServer = close;
  return base;
}

const as = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

describe("HTTP isolation between profiles", () => {
  let work: string;
  let personal: string;
  let base: string;

  beforeEach(async () => {
    work = (await registry.create("work")).key;
    personal = (await registry.create("personal")).key;
    const kbs = await registry.memories();
    const kbOf = (n: string) => kbs.find((m) => m.name === n)!.kb;
    await kbOf("work").writeConcept(
      "/deploy.md",
      { type: "Fact", title: "Work deploys" },
      "Fridays",
      "Added."
    );
    await kbOf("personal").writeConcept(
      "/diary.md",
      { type: "Note", title: "Diary" },
      "secret",
      "Added."
    );
    base = await serve(profileMemoryHost(registry));
  });

  it("requires a profile key on /api and /mcp, and says so", async () => {
    const res = await fetch(`${base}/api/tree`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ mode: "profiles" });
    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(401);
  });

  it("serves each key only its own memory and names the profile", async () => {
    expect(await (await fetch(`${base}/api/profile`, as(work))).json()).toEqual({
      mode: "profiles",
      profile: "work",
    });
    const workTree = JSON.stringify(await (await fetch(`${base}/api/tree`, as(work))).json());
    expect(workTree).toContain("deploy.md");
    expect(workTree).not.toContain("diary.md");
  });

  it("cannot reach another profile's concept by path, search or traversal", async () => {
    for (const p of ["/diary.md", "/../personal/diary.md", "../personal/diary.md"]) {
      const res = await fetch(`${base}/api/concept?path=${encodeURIComponent(p)}`, as(work));
      expect(res.status, p).toBeGreaterThanOrEqual(400);
    }
    const hits = await (await fetch(`${base}/api/search?q=secret`, as(work))).json();
    expect(hits).toEqual([]);
  });

  it("gives each profile its own MCP seed overview", async () => {
    const init = (key: string) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      }).then((r) => r.json());
    expect((await init(work)).result.instructions).toContain("Work deploys");
    expect((await init(personal)).result.instructions).toContain("Diary");
    expect((await init(work)).result.instructions).not.toContain("Diary");
  });
});

describe("admin API", () => {
  const ADMIN = "admin-secret-token";
  let base: string;
  let created: string[];

  beforeEach(async () => {
    created = [];
    const admin = adminRouter(registry, ADMIN, async (name) => {
      created.push(name);
      if (name === "broken") throw new Error("git is not installed");
    });
    base = await serve(profileMemoryHost(registry), admin);
  });

  const call = (method: string, url: string, token: string, body?: unknown) =>
    fetch(`${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("keeps admin and profile credentials separate", async () => {
    const { key } = await registry.create("work");
    expect((await call("GET", "/admin/profiles", key)).status).toBe(401);
    expect((await fetch(`${base}/api/tree`, as(ADMIN))).status).toBe(401);
  });

  it("creates, rotates and revokes profiles", async () => {
    const res = await call("POST", "/admin/profiles", ADMIN, { name: "team" });
    expect(res.status).toBe(201);
    const { key } = await res.json();
    expect(created).toEqual(["team"]);
    expect((await fetch(`${base}/api/profile`, as(key))).status).toBe(200);

    expect(await (await call("GET", "/admin/profiles", ADMIN)).json()).toEqual([
      expect.objectContaining({ name: "team" }),
    ]);
    expect((await call("POST", "/admin/profiles", ADMIN, { name: "team" })).status).toBe(409);
    expect((await call("POST", "/admin/profiles", ADMIN, { name: "../x" })).status).toBe(400);

    const rotated = await (await call("POST", "/admin/profiles/team/rotate", ADMIN)).json();
    expect((await fetch(`${base}/api/profile`, as(key))).status).toBe(401);
    expect((await fetch(`${base}/api/profile`, as(rotated.key))).status).toBe(200);

    expect((await call("DELETE", "/admin/profiles/team?purge=true", ADMIN)).status).toBe(204);
    expect((await call("DELETE", "/admin/profiles/team", ADMIN)).status).toBe(404);
    await expect(fs.stat(path.join(root, "team"))).rejects.toThrow();
  });

  it("rolls a profile back when it cannot be initialized, so a retry works", async () => {
    const res = await call("POST", "/admin/profiles", ADMIN, { name: "broken" });
    expect(res.status).toBe(500);
    expect(await registry.list()).toEqual([]);
    // The name is not blocked: a retry gets past the duplicate check again.
    expect((await call("POST", "/admin/profiles", ADMIN, { name: "broken" })).status).toBe(500);
    expect(created).toEqual(["broken", "broken"]);
  });

  it("refuses cross-site requests to /admin (network guard)", async () => {
    const res = await fetch(`${base}/admin/profiles`, {
      headers: { authorization: `Bearer ${ADMIN}`, origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("single-memory mode", () => {
  let bundle: string;

  beforeEach(async () => {
    bundle = path.join(root, "bundle");
    await fs.mkdir(bundle);
  });

  it("is open without AUTH_TOKEN, reports its mode, and has no /admin", async () => {
    const base = await serve(singleMemoryHost(new KnowledgeBase(bundle), undefined));
    expect(await (await fetch(`${base}/api/profile`)).json()).toEqual({
      mode: "single",
      profile: null,
    });
    expect((await fetch(`${base}/admin/profiles`)).status).toBe(404);
  });

  it("requires AUTH_TOKEN when set", async () => {
    const base = await serve(singleMemoryHost(new KnowledgeBase(bundle), "tok"));
    const res = await fetch(`${base}/api/tree`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ mode: "single" });
    expect((await fetch(`${base}/api/tree`, as("tok"))).status).toBe(200);
  });
});

describe("profile registry unavailable", () => {
  it("answers 503 and authenticates nobody", async () => {
    const { key } = await registry.create("work");
    const base = await serve(profileMemoryHost(registry));
    await fs.writeFile(path.join(root, "profiles.json"), "{ broken");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await fetch(`${base}/api/tree`, as(key));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "profile registry unavailable" });
    log.mockRestore();
  });
});

describe("profile key throttle", () => {
  it("locks out a client that keeps presenting wrong keys", async () => {
    const { key } = await registry.create("work");
    const base = await serve(profileMemoryHost(registry, { limit: 3, windowMs: 60_000 }));
    const statuses = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await fetch(`${base}/api/tree`, as("myz_wrong"))).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    expect((await fetch(`${base}/api/tree`, as(key))).status).toBe(429);
  });

  it("does not count requests that present no key at all", async () => {
    const { key } = await registry.create("work");
    const base = await serve(profileMemoryHost(registry, { limit: 2, windowMs: 60_000 }));
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/api/tree`)).status).toBe(401);
    expect((await fetch(`${base}/api/tree`, as(key))).status).toBe(200);
  });

  it("never counts valid keys", async () => {
    const { key } = await registry.create("work");
    const base = await serve(profileMemoryHost(registry, { limit: 2, windowMs: 60_000 }));
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/api/tree`, as(key))).status).toBe(200);
  });
});
