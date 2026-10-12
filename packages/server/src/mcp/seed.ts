import { formatLogLine, sanitizeInline, sanitizePath, UNTRUSTED_CONTENT_NOTICE } from "@myzel/core";
import { promises as fs } from "node:fs";
import { bundleFingerprint, type KnowledgeBase } from "@myzel/core";
import type { TreeNode } from "@myzel/core";

const MAX_SEED_CHARS = 3000;
const MAX_DESCRIPTIONS_PER_SEGMENT = 10;

/**
 * Seed memory: a compact overview of what the knowledge base contains,
 * loaded into the client LLM at session start (via MCP `instructions` and
 * the memory_query tool description). Without it the model has no signal
 * that memory might hold an answer, so it never thinks to look.
 *
 * Unlike the on-disk index.md (navigation: titles + links), the seed lists
 * concept DESCRIPTIONS per segment — semantic hooks beat filenames for
 * igniting the "memory might know this" instinct.
 */
/**
 * The stateless HTTP transport builds a fresh McpServer for every request —
 * `tools/list` included — and each needs the seed. Building it reads and
 * parses every concept; the fingerprint only stats them. The log is part of
 * the seed but not of the concept fingerprint, so its mtime joins the key.
 */
const seedCache = new WeakMap<KnowledgeBase, { key: string; seed: string }>();

export async function cachedSeedMemory(kb: KnowledgeBase): Promise<string> {
  const logMtime = await fs
    .stat(kb.bundle.resolve("/log.md"))
    .then((st) => String(st.mtimeMs))
    .catch(() => "none");
  const key = `${await bundleFingerprint(kb)}:${logMtime}`;
  const hit = seedCache.get(kb);
  if (hit?.key === key) return hit.seed;
  const seed = await buildSeedMemory(kb);
  seedCache.set(kb, { key, seed });
  return seed;
}

export async function buildSeedMemory(kb: KnowledgeBase): Promise<string> {
  const [tree, types, log] = await Promise.all([kb.listTree(), kb.listTypes(), kb.readLog()]);

  const segments: string[] = [];
  const rootDescriptions: string[] = [];

  for (const child of tree.children ?? []) {
    if (child.kind === "directory") {
      const collected = collectConcepts(child);
      if (collected.count === 0) continue;
      const typeList = [...collected.types]
        .map((t) => sanitizeInline(t, 60))
        .filter(Boolean)
        .sort()
        .join(", ");
      const shown = collected.descriptions.slice(0, MAX_DESCRIPTIONS_PER_SEGMENT);
      const more = collected.count - shown.length;
      segments.push(
        `* ${sanitizePath(child.name)}/ — ${collected.count} concept${collected.count === 1 ? "" : "s"}` +
          `${typeList ? ` (${typeList})` : ""}:\n` +
          shown.map((d) => `    * ${d}`).join("\n") +
          (more > 0 ? `\n    * …and ${more} more` : "")
      );
    } else if (child.kind === "concept") {
      rootDescriptions.push(deriveConceptDescription(child));
    }
  }
  if (rootDescriptions.length > 0) {
    segments.push(
      `* (root) — ${rootDescriptions.length} concept${rootDescriptions.length === 1 ? "" : "s"}:\n` +
        rootDescriptions.map((d) => `    * ${d}`).join("\n")
    );
  }

  // Log summaries are written by the agent from user-supplied knowledge.
  const recent = log.slice(0, 3).map(formatLogLine);

  const sections = [
    `Concept types in use: ${
      types
        .map((t) => sanitizeInline(t, 60))
        .filter(Boolean)
        .join(", ") || "(none yet)"
    }`,
    `Memory segments:\n${segments.join("\n") || "(empty — nothing stored yet)"}`,
  ];
  if (recent.length > 0) sections.push(`Recent activity:\n${recent.join("\n")}`);

  let seed = sections.join("\n\n");
  if (seed.length > MAX_SEED_CHARS) {
    seed = seed.slice(0, MAX_SEED_CHARS) + "\n… (truncated — use memory_query to explore further)";
  }
  return seed;
}

/** Recursively gather concept descriptions (falling back to title/filename) and types. */
function collectConcepts(node: TreeNode): {
  count: number;
  types: Set<string>;
  descriptions: string[];
} {
  const out = { count: 0, types: new Set<string>(), descriptions: [] as string[] };
  for (const child of node.children ?? []) {
    if (child.kind === "directory") {
      const nested = collectConcepts(child);
      out.count += nested.count;
      nested.types.forEach((t) => out.types.add(t));
      out.descriptions.push(...nested.descriptions);
    } else if (child.kind === "concept") {
      out.count++;
      if (child.type) out.types.add(child.type);
      out.descriptions.push(deriveConceptDescription(child));
    }
  }
  return out;
}

/** Derives a concept description always containing either name or title from a tree node representing a concept */
export function deriveConceptDescription(node: TreeNode): string {
  // Every part of this line is stored content, so every part is sanitized: the
  // seed is rendered into the CALLING model's system prompt at session start.
  const name = sanitizeInline(node.title, 120) || sanitizePath(node.name, 120);
  const subject = `**${name}**`;
  const description = sanitizeInline(node.description, 200);

  return description ? `${subject}, ${description}` : subject;
}

/** The initialize `instructions` block — seed plus the instinct-igniting rules. */
export function seedInstructions(seed: string): string {
  return `This server is your persistent memory — an OKF knowledge base of markdown concepts that survives across sessions.

${UNTRUSTED_CONTENT_NOTICE}

MEMORY OVERVIEW (as of session start):

${seed}

How to use your memory:
- BEFORE answering anything related to the topics above, call memory_query — the answer may already be stored. Prefer stored knowledge over guessing.
- When you learn a lasting fact, decision, preference or piece of documentation, persist it with memory_add. If it isn't stored, it will be forgotten.
- When existing knowledge turns out to be wrong or outdated, fix it with memory_update.
- memory_status reports size and health of the memory.`;
}
