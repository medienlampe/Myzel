import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  clearHotMemory,
  clearQueryCache,
  KnowledgeBase,
  type KnowledgeBaseOptions,
} from "@myzel/core";

/**
 * Profiles: several isolated memories hosted by one server.
 * (Ported from upstream understory, thecodacus/understory#45.)
 *
 * Layout under PROFILES_ROOT:
 *   profiles.json      registry — name, SHA-256 of the API key, created date
 *   <name>/            that profile's OKF bundle
 *
 * The API key is the only thing that selects a memory: a request carrying
 * profile A's key is served by A's KnowledgeBase and can reach nothing else.
 * Keys are shown once at creation and stored only as hashes. They are 192
 * random bits, so a fast hash is the right tool — there is nothing to
 * brute-force that a slow hash would protect.
 */

export interface ProfileInfo {
  name: string;
  createdAt: string;
}

interface ProfileRecord extends ProfileInfo {
  keyHash: string;
}

interface RegistryFile {
  version: 1;
  profiles: ProfileRecord[];
}

export type ProfileErrorCode =
  "INVALID_NAME" | "EXISTS" | "NOT_FOUND" | "CORRUPT_REGISTRY" | "LOCKED";

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly code: ProfileErrorCode
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

const REGISTRY_FILE = "profiles.json";
// Lowercase, no dots or slashes: a name is used verbatim as a directory.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KEY_PREFIX = "myz_";
/** 192 random bits per key. */
const KEY_BYTES = 24;
// A registry change takes milliseconds; a lock older than this was left by a
// process that died while holding it.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Identity of the registry file as last seen. Every save replaces the file
 * by rename, so the inode changes even when size and a coarse mtime do not
 * (a key rotation rewrites a hash of the same length).
 */
function fileStamp(st: { ino: number; mtimeMs: number; size: number }): string {
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
}

function generateKey(): string {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
}

function isValidProfileName(name: string): boolean {
  return NAME_RE.test(name);
}

export class ProfileRegistry {
  readonly root: string;
  private records: ProfileRecord[] = [];
  private loadedStamp: string | null = null;
  // Bumped by every save. An unlocked refresh that started before a save must
  // not apply what it read afterwards: it would put back records the save
  // just replaced — a revoked or rotated key working again.
  private generation = 0;
  // One KnowledgeBase per profile: its mutation queue only serializes writes if
  // every request shares the instance. Keyed to the record's createdAt, so a
  // profile removed and re-created under the same name gets a fresh instance.
  private readonly kbs = new Map<string, { kb: KnowledgeBase; createdAt: string }>();
  // Every instance handed out, kept for drain() at shutdown — including ones
  // whose profile has since been removed.
  private readonly everyKb = new Set<KnowledgeBase>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    private readonly kbOptions: KnowledgeBaseOptions = {}
  ) {
    this.root = path.resolve(root);
  }

  private get file(): string {
    return path.join(this.root, REGISTRY_FILE);
  }

  bundlePath(name: string): string {
    return path.join(this.root, name);
  }

  /**
   * Re-read the registry if it changed on disk, so profiles created or
   * revoked with the CLI take effect on a running server without a restart.
   */
  async refresh(force = false): Promise<void> {
    let stamp = "absent";
    try {
      stamp = fileStamp(await fs.stat(this.file));
    } catch {
      // No registry yet: an empty set of profiles.
    }
    if (!force && stamp === this.loadedStamp) return;
    const generation = this.generation;

    let records: ProfileRecord[] = [];
    if (stamp !== "absent") {
      try {
        const parsed = JSON.parse(await fs.readFile(this.file, "utf-8")) as RegistryFile;
        if (!Array.isArray(parsed.profiles)) throw new Error("missing profiles array");
        records = parsed.profiles.filter(
          (r) => isValidProfileName(r.name) && /^[0-9a-f]{64}$/.test(r.keyHash)
        );
        if (records.length !== parsed.profiles.length) throw new Error("malformed profile entry");
        const names = new Set(records.map((r) => r.name));
        const hashes = new Set(records.map((r) => r.keyHash));
        if (names.size !== records.length || hashes.size !== records.length) {
          throw new Error("duplicate profile name or key");
        }
      } catch (err) {
        // Fail closed: an unreadable registry authenticates nobody.
        throw new ProfileError(
          `profile registry ${this.file} is unreadable: ${(err as Error).message}`,
          "CORRUPT_REGISTRY"
        );
      }
    }
    if (!force && generation !== this.generation) return; // a save overtook this read
    this.records = records;
    this.loadedStamp = stamp;

    // Drop in-memory state for profiles that are gone — or gone and re-created.
    const live = new Map(records.map((r) => [r.name, r.createdAt]));
    for (const [name, entry] of [...this.kbs]) {
      if (live.get(name) !== entry.createdAt) this.forget(name);
    }
  }

  /** Close a profile's KnowledgeBase and drop its cached state. Returns it, if loaded. */
  private forget(name: string): KnowledgeBase | undefined {
    const kb = this.kbs.get(name)?.kb;
    if (!kb) return undefined;
    kb.close(); // requests still holding it can no longer write
    clearHotMemory(kb.bundle.root);
    clearQueryCache(kb.bundle.root);
    this.kbs.delete(name);
    return kb;
  }

  /** Wait for the writes of every memory this process opened (shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.everyKb].map((kb) => kb.idle()));
  }

  /** Write the registry atomically, owner-only. Only ever called from inside mutate(). */
  private async save(): Promise<void> {
    const body: RegistryFile = { version: 1, profiles: this.records };
    const tmp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(body, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx", // never follow a planted file or symlink
      });
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    this.generation++;
    this.loadedStamp = fileStamp(await fs.stat(this.file));
  }

  /**
   * Run one registry change. Changes are queued within this process and take
   * a lock file across processes (the server and the CLI share the registry),
   * and each starts from a fresh read made while holding the lock. Without
   * this, two writers would each save their own copy and the later one would
   * silently drop the other's change — for a revoked key, access coming back.
   */
  private mutate<T>(change: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await fs.mkdir(this.root, { recursive: true });
      const release = await this.acquireLock();
      try {
        await this.refresh(true);
        return await change();
      } finally {
        await release();
      }
    };
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  /**
   * Take the cross-process lock. The lock file holds a random token: release
   * removes only our own lock, and a stale lock (left by a crashed process) is
   * taken over by an atomic rename, so two processes can never both conclude
   * they removed it — the second rename fails and that process waits.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    const lock = `${this.file}.lock`;
    const token = randomBytes(16).toString("hex");
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        await handle.writeFile(token);
        await handle.close();
        return async () => {
          const current = await fs.readFile(lock, "utf-8").catch(() => null);
          if (current === token) await fs.rm(lock, { force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      // lstat: a dangling symlink at the lock path must count as a lock, not
      // as "released" (which would retry forever without ever waiting).
      const age = await fs.lstat(lock).then(
        (st) => Date.now() - st.mtimeMs,
        () => null
      );
      if (age !== null && age > LOCK_STALE_MS) {
        const aside = `${lock}.${randomBytes(8).toString("hex")}.stale`;
        // Only one process can move the stale lock aside; the others see
        // ENOENT here and go round again.
        if (
          await fs.rename(lock, aside).then(
            () => true,
            () => false
          )
        ) {
          await fs.rm(aside, { force: true });
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new ProfileError(`profile registry is locked by another process (${lock})`, "LOCKED");
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 20));
    }
  }

  private kbFor(record: ProfileRecord): KnowledgeBase {
    const cached = this.kbs.get(record.name);
    if (cached) return cached.kb;
    const kb = new KnowledgeBase(this.bundlePath(record.name), this.kbOptions);
    this.kbs.set(record.name, { kb, createdAt: record.createdAt });
    this.everyKb.add(kb);
    return kb;
  }

  async list(): Promise<ProfileInfo[]> {
    await this.refresh();
    return this.records.map(({ name, createdAt }) => ({ name, createdAt }));
  }

  /** Every profile with its KnowledgeBase — for dreaming and shutdown. */
  async memories(): Promise<{ name: string; kb: KnowledgeBase }[]> {
    await this.refresh();
    return this.records.map((r) => ({ name: r.name, kb: this.kbFor(r) }));
  }

  /**
   * Create a profile and return its API key (the only time it is available).
   * An existing directory of that name is adopted as the profile's bundle,
   * which is how a bundle from single-memory mode moves into a profile.
   */
  async create(name: string): Promise<{ name: string; key: string }> {
    if (!isValidProfileName(name)) {
      throw new ProfileError(
        `invalid profile name "${name}": use lowercase letters, digits, "-" or "_" (max 63, starting with a letter or digit)`,
        "INVALID_NAME"
      );
    }
    return this.mutate(async () => {
      if (this.records.some((r) => r.name === name)) {
        throw new ProfileError(`profile "${name}" already exists`, "EXISTS");
      }
      await fs.mkdir(this.bundlePath(name), { recursive: true });
      const key = generateKey();
      this.records = [
        ...this.records,
        { name, keyHash: sha256(key).toString("hex"), createdAt: new Date().toISOString() },
      ];
      await this.save();
      return { name, key };
    });
  }

  /** Issue a new key for a profile; the old key stops working immediately. */
  async rotate(name: string): Promise<{ name: string; key: string }> {
    return this.mutate(async () => {
      if (!this.records.some((r) => r.name === name)) {
        throw new ProfileError(`profile "${name}" not found`, "NOT_FOUND");
      }
      const key = generateKey();
      this.records = this.records.map((r) =>
        r.name === name ? { ...r, keyHash: sha256(key).toString("hex") } : r
      );
      await this.save();
      return { name, key };
    });
  }

  /**
   * Revoke a profile's key. The memory itself stays on disk unless `purge`
   * is set, so removing access is never the same step as destroying data.
   */
  async remove(name: string, options: { purge?: boolean } = {}): Promise<void> {
    return this.mutate(async () => {
      if (!this.records.some((r) => r.name === name)) {
        throw new ProfileError(`profile "${name}" not found`, "NOT_FOUND");
      }
      this.records = this.records.filter((r) => r.name !== name);
      await this.save();
      // Let writes already running finish before the data goes; closing first
      // means nothing new can start (and recreate the directory after a purge).
      await this.forget(name)?.idle();
      if (options.purge) {
        await fs.rm(this.bundlePath(name), { recursive: true, force: true });
      }
    });
  }

  /** The profile a presented API key belongs to, or null. */
  async resolve(key: string): Promise<{ name: string; kb: KnowledgeBase } | null> {
    if (!key) return null;
    await this.refresh();
    const presented = sha256(key);
    let match: ProfileRecord | null = null;
    // Compare against every record so timing does not depend on which matched.
    for (const record of this.records) {
      const stored = Buffer.from(record.keyHash, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = record;
    }
    return match ? { name: match.name, kb: this.kbFor(match) } : null;
  }
}
