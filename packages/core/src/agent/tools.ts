import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { FAMILY_KEYS, findPlainObjectKeys, STATUSES, SYSTEM_KEYS } from "../okf/index.js";
import type { KnowledgeBase } from "../okf/index.js";
import type { TreeNode } from "../okf/types.js";
import type { TraceRecorder } from "./trace.js";
import { recordHotDelete, recordHotWrite } from "./hot-memory.js";
import { sanitizeInline, sanitizePath } from "./untrusted.js";

/** Longest concept body handed to the model in one read_concept call. */
const MAX_READ_CHARS = 20_000;

/** Bundle-relative concept path, e.g. "/tables/customers.md". */
const conceptPathSchema = z
  .string()
  .describe('Bundle-relative path starting with "/", ending in .md');

const datetime = z.iso
  .datetime({ offset: true })
  .describe("ISO 8601 datetime with a UTC offset, e.g. 2026-06-30T14:00:00Z");

/** One provenance entry (OKF v0.2 §5.1). */
const sourceSchema = z.looseObject({
  id: z
    .string()
    .optional()
    .describe("Stable key. A footnote [^id] in the body attributes a claim to this source."),
  resource: z
    .string()
    .min(1)
    .describe("Absolute URL, bundle path (/…) or a scope descriptor. Required."),
  title: z.string().optional(),
  author: z.string().optional().describe("Who produced the source, e.g. team:payments"),
  usage_count: z.number().int().nonnegative().optional(),
  last_modified: datetime.optional(),
});

// The spec's own keys, typed: a model must not hand a mapping where a string
// belongs (thecodacus/understory#41).
const fields = {
  type: z.string().min(1).describe("Concept kind, e.g. 'API Endpoint'"),
  title: z.string(),
  description: z.string().describe("One-line summary"),
  resource: z.string().describe("Canonical URI of the underlying asset"),
  tags: z.array(z.string()),
  status: z.enum(STATUSES).describe("Lifecycle; absent means stable"),
  stale_after: datetime.describe("Instant from which the content counts as stale"),
  sources: z.array(sourceSchema).describe("Provenance: what this concept derives from"),
};

const SYSTEM_KEYS_MESSAGE = `${[...SYSTEM_KEYS].join(", ")} are recorded by the system — leave them out.`;
const noSystemKeys = (fm: Record<string, unknown>) =>
  !Object.keys(fm).some((key) => SYSTEM_KEYS.has(key));

const frontmatterSchema = z
  .looseObject({
    ...fields,
    type: fields.type.describe("Concept kind, e.g. 'API Endpoint'. Required."),
    title: fields.title.optional(),
    description: fields.description.optional(),
    resource: fields.resource.optional(),
    tags: fields.tags.optional(),
    status: fields.status.optional(),
    stale_after: fields.stale_after.optional(),
    sources: fields.sources.optional(),
  })
  .refine(noSystemKeys, SYSTEM_KEYS_MESSAGE)
  .describe("YAML frontmatter (OKF v0.2). Additional producer-defined keys are allowed.");

/**
 * patch_concept's merge: each key typed as above, or null to delete it. A
 * mapping is accepted only in the structured v0.2 families (sources, …) —
 * models otherwise produce `{ __type, __value }` placeholders and tag maps.
 * (Adapted from upstream understory, thecodacus/understory#41 by @Piggidragon.)
 */
export const frontmatterPatchSchema = z
  .looseObject({
    type: fields.type.nullable().optional(),
    title: fields.title.nullable().optional(),
    description: fields.description.nullable().optional(),
    resource: fields.resource.nullable().optional(),
    tags: fields.tags.nullable().optional(),
    status: fields.status.nullable().optional(),
    stale_after: fields.stale_after.nullable().optional(),
    sources: fields.sources.nullable().optional(),
  })
  .refine(noSystemKeys, SYSTEM_KEYS_MESSAGE)
  .refine(
    (fm) => findPlainObjectKeys(fm).every((key) => FAMILY_KEYS.has(key)),
    "Frontmatter values must be strings, numbers or lists of strings — never objects (pass 'Description text', not { __type: 'string', __value: … }). Set a key to null to remove it."
  )
  .describe(
    "Frontmatter keys to merge; null removes a key. Producer-defined keys are allowed with the same value rules."
  );

/**
 * The actor recorded as generated.by for agent writes (spec §7:
 * `<producer>/<version>`). The model id can come from endpoint discovery, so
 * it is reduced to one short token.
 */
export function agentActor(modelId: string | undefined): string {
  const id = (modelId ?? "").replace(/\s+/g, "-").slice(0, 100);
  return `myzel/${id || "agent"}`;
}

const logSummary = z
  .string()
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

export function buildReadTools(kb: KnowledgeBase, trace?: TraceRecorder): ToolSet {
  return {
    search_knowledge: tool({
      description:
        "Search the knowledge base by keywords, optionally filtered by concept type and/or tags. Returns ranked hits with paths and snippets. NOTE: matching is keyword-based, not semantic — a miss does NOT mean the knowledge is absent; it may be worded differently.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Keywords to search for. May be empty when filtering by type/tags only."),
        type: z.string().optional().describe("Exact concept type filter"),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags"),
      }),
      execute: async ({ query, type, tags }) => {
        const hits = await kb.search(query, { type, tags });
        trace?.record(
          "search_knowledge",
          query,
          hits.map((h) => h.path)
        );
        if (hits.length > 0) return hits;
        // Keyword miss ≠ knowledge absent. Put the map in the tool result so
        // the model's next step is to read plausible concepts, not give up.
        const tree = formatTree(await kb.listTree());
        return {
          hits: [],
          notice:
            "No keyword matches — but this search is literal, not semantic. The knowledge may exist under different wording. Before concluding it is absent: (1) retry with 1-2 synonyms or broader terms, (2) review the layout below and read_concept ANY concept whose type, name or description could plausibly relate to the question.",
          bundle_layout: tree,
        };
      },
    }),
    read_concept: tool({
      description: "Read one concept document in full: frontmatter and markdown body.",
      inputSchema: z.object({ path: conceptPathSchema }),
      execute: async ({ path: conceptPath }) => {
        const c = await kb.readConcept(conceptPath);
        trace?.record("read_concept", c.path, [c.path]);
        // A synced bundle can hold huge files; every step re-sends tool output,
        // so one of them would otherwise dominate the bill of the whole run.
        const body =
          c.body.length > MAX_READ_CHARS
            ? `${c.body.slice(0, MAX_READ_CHARS)}\n\n[… truncated: ${c.body.length - MAX_READ_CHARS} more characters]`
            : c.body;
        return { path: c.path, frontmatter: c.frontmatter, body };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types/titles/descriptions. Use to understand structure and decide where new concepts belong.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("list_directory", "", []);
        return formatTree(await kb.listTree());
      },
    }),
    lint_knowledge: tool({
      description:
        "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("lint_knowledge", "", []);
        return kb.lint();
      },
    }),
  };
}

export function buildWriteTools(
  kb: KnowledgeBase,
  filesChanged: Set<string>,
  trace?: TraceRecorder,
  /** Recorded as generated.by; see agentActor. */
  actor = agentActor(undefined)
): ToolSet {
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those. Who wrote it and when (generated) is recorded automatically; an existing verification (verified) is kept.",
      inputSchema: z.object({
        path: conceptPathSchema,
        frontmatter: frontmatterSchema,
        body: z.string().describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path: conceptPath, frontmatter, body, log_summary }) => {
        // Verification is independent of the content (spec §5.2): a rewrite
        // keeps who confirmed it, and the model cannot add or drop that.
        const existing = await kb.readConcept(conceptPath).catch(() => null);
        const verified = existing?.frontmatter.verified;
        const c = await kb.writeConcept(
          conceptPath,
          verified === undefined ? frontmatter : { ...frontmatter, verified },
          body,
          log_summary,
          actor
        );
        filesChanged.add(c.path);
        recordHotWrite(kb.bundle.root, c.path);
        trace?.record("write_concept", c.path, [c.path], true);
        return { written: c.path };
      },
    }),
    patch_concept: tool({
      description:
        "Targeted update of an existing concept: merge frontmatter keys (null deletes a key) and/or replace one body section under a heading of any level (# to ######). Prefer this over write_concept for small edits.",
      inputSchema: z.object({
        path: conceptPathSchema,
        frontmatter: frontmatterPatchSchema.optional(),
        replace_section: z
          .object({
            heading: z
              .string()
              .min(1)
              .describe(
                "Heading name (any level), e.g. 'Schema'. Must be non-empty — to replace the whole body use replace_body instead."
              ),
            content: z.string().describe("New content for that section"),
          })
          .optional(),
        replace_body: z
          .string()
          .optional()
          .describe(
            "Replace the entire markdown body (frontmatter untouched). Use for restructuring; prefer replace_section for targeted edits."
          ),
        log_summary: logSummary,
      }),
      execute: async ({
        path: conceptPath,
        frontmatter,
        replace_section,
        replace_body,
        log_summary,
      }) => {
        const c = await kb.patchConcept(
          conceptPath,
          {
            frontmatter,
            replaceSection: replace_section
              ? { heading: replace_section.heading, content: replace_section.content }
              : undefined,
            replaceBody: replace_body,
          },
          log_summary,
          actor
        );
        filesChanged.add(c.path);
        recordHotWrite(kb.bundle.root, c.path);
        trace?.record("patch_concept", c.path, [c.path], true);
        return { patched: c.path };
      },
    }),
    delete_concept: tool({
      description:
        "Permanently delete a concept file. Prefer deprecation (status: deprecated via patch_concept) unless content is wrong/harmful or deletion was explicitly requested.",
      inputSchema: z.object({
        path: conceptPathSchema,
        log_summary: logSummary,
      }),
      execute: async ({ path: rawPath, log_summary }) => {
        await kb.deleteConcept(rawPath, log_summary);
        const conceptPath = kb.bundle.toBundlePath(rawPath);
        filesChanged.add(conceptPath);
        recordHotDelete(kb.bundle.root, conceptPath);
        trace?.record("delete_concept", conceptPath, [conceptPath], true);
        return { deleted: conceptPath };
      },
    }),
  };
}

/** Compact indented listing for prompts and the list_directory tool. */
export function formatTree(node: TreeNode, depth = 0): string {
  const lines: string[] = [];
  if (depth === 0) lines.push("/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      lines.push(`${indent}${sanitizePath(child.name)}/`);
      lines.push(formatTree(child, depth + 1));
    } else if (child.kind === "concept") {
      // Names, types and descriptions are stored content: one line each, always.
      const meta = [sanitizeInline(child.type, 60), sanitizeInline(child.description, 160)]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${indent}${sanitizePath(child.name)}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
