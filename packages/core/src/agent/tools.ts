import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  contentVersion,
  FAMILY_KEYS,
  findPlainObjectKeys,
  STATUSES,
  SYSTEM_KEYS,
} from "../okf/index.js";
import type { KnowledgeBase } from "../okf/index.js";
import type { SearchHit, TreeNode } from "../okf/types.js";
import { truncate } from "../util/text.js";
import type { TraceRecorder } from "./trace.js";
import { recordHotDelete, recordHotWrite } from "./hot-memory.js";
import { sanitizeInline, sanitizePath } from "./untrusted.js";
import { capList, PROMPT_LIMITS } from "./limits.js";

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
  .max(PROMPT_LIMITS.logSummaryChars)
  .describe(
    "One past-tense sentence for the update log, with bundle-relative links, e.g. 'Added [Billing API](/apis/billing-api.md).'"
  );

/**
 * What the model has seen of each concept in one run: path → contentVersion of
 * the text it read or last wrote. write_concept replaces a whole file, so it
 * may only replace the version the model actually saw — never one it never
 * read, nor one a person edited in between (premise: Myzel adapts to hand
 * edits instead of fighting them). Shared by a run's read and write tools.
 */
export type SeenVersions = Map<string, string>;

export function buildReadTools(
  kb: KnowledgeBase,
  trace?: TraceRecorder,
  seen: SeenVersions = new Map()
): ToolSet {
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
        if (hits.length > 0) return hits.map(trimHit);
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
        seen.set(c.path, contentVersion(c.raw));
        trace?.record("read_concept", c.path, [c.path]);
        // A synced bundle can hold huge files; every step re-sends tool output,
        // so one of them would otherwise dominate the bill of the whole run.
        const max = PROMPT_LIMITS.readBodyChars;
        const body =
          c.body.length > max
            ? `${c.body.slice(0, max)}\n\n[… truncated: ${c.body.length - max} more characters]`
            : c.body;
        const fmJson = JSON.stringify(c.frontmatter);
        if (fmJson.length <= PROMPT_LIMITS.readFrontmatterChars) {
          return { path: c.path, frontmatter: c.frontmatter, body };
        }
        return {
          path: c.path,
          frontmatter_excerpt: `${fmJson.slice(0, PROMPT_LIMITS.readFrontmatterChars)} [… truncated: ${fmJson.length - PROMPT_LIMITS.readFrontmatterChars} more characters]`,
          body,
        };
      },
    }),
    list_directory: tool({
      description:
        "List the bundle's directory tree with concept types and descriptions. Use to understand structure and decide where new concepts belong. A large bundle is shown as directories only — pass a directory path to list its concepts.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('Directory to list, e.g. "/apis". Defaults to the whole bundle.'),
      }),
      execute: async ({ path: dir }) => {
        trace?.record("list_directory", dir ?? "", []);
        const tree = await kb.listTree();
        if (!dir || dir === "/") return formatTree(tree);
        const node = findDirectory(tree, dir);
        return node ? formatTree(node) : `No directory ${sanitizePath(dir)} in the bundle.`;
      },
    }),
    lint_knowledge: tool({
      description:
        "Graph health check: orphaned concepts (nothing links to them) and broken links. Use to find what needs wiring into the graph or fixing.",
      inputSchema: z.object({}),
      execute: async () => {
        trace?.record("lint_knowledge", "", []);
        const report = await kb.lint();
        const orphans = capList(report.orphans);
        const brokenLinks = capList(report.brokenLinks);
        return {
          ...report,
          orphans: orphans.shown,
          brokenLinks: brokenLinks.shown,
          ...(orphans.omitted ? { orphansOmitted: orphans.omitted } : {}),
          ...(brokenLinks.omitted ? { brokenLinksOmitted: brokenLinks.omitted } : {}),
        };
      },
    }),
  };
}

export function buildWriteTools(
  kb: KnowledgeBase,
  filesChanged: Set<string>,
  trace?: TraceRecorder,
  /** Recorded as generated.by; see agentActor. */
  actor = agentActor(undefined),
  seen: SeenVersions = new Map()
): ToolSet {
  return {
    write_concept: tool({
      description:
        "Create a new concept or fully overwrite an existing one. Overwriting requires reading the concept with read_concept first in this run. Frontmatter must include a non-empty 'type'. index.md and log.md maintenance is automatic — never write those. Who wrote it and when (generated) is recorded automatically; an existing verification (verified) is kept.",
      inputSchema: z.object({
        path: conceptPathSchema,
        frontmatter: frontmatterSchema,
        body: z
          .string()
          .max(PROMPT_LIMITS.writeBodyChars)
          .describe("Markdown body (no frontmatter block)"),
        log_summary: logSummary,
      }),
      execute: async ({ path: conceptPath, frontmatter, body, log_summary }) => {
        const canonical = kb.bundle.toBundlePath(conceptPath);
        const known = seen.get(canonical);
        if (known === undefined && (await kb.bundle.exists(canonical))) {
          throw new Error(
            `${canonical} already exists. Read it with read_concept first, then rewrite it — or use patch_concept for a targeted change.`
          );
        }
        // Checked again inside the write queue: a hand edit since the read wins.
        const c = await kb.writeConcept(canonical, frontmatter, body, log_summary, actor, {
          expectedVersion: known ?? null,
        });
        seen.set(c.path, contentVersion(c.raw));
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
            content: z
              .string()
              .max(PROMPT_LIMITS.writeBodyChars)
              .describe("New content for that section"),
          })
          .optional(),
        replace_body: z
          .string()
          .max(PROMPT_LIMITS.writeBodyChars)
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
        seen.set(c.path, contentVersion(c.raw));
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

/** A search hit with its stored title and description cut to a prompt-sized length. */
function trimHit(hit: SearchHit): SearchHit {
  const cut = (v: string | undefined) =>
    v === undefined ? undefined : truncate(v, PROMPT_LIMITS.hitFieldChars);
  return { ...hit, title: cut(hit.title), description: cut(hit.description) };
}

function findDirectory(node: TreeNode, dir: string): TreeNode | undefined {
  const target = `/${dir.replace(/^\/+|\/+$/g, "")}`;
  for (const child of node.children ?? []) {
    if (child.kind !== "directory") continue;
    if (child.path === target) return child;
    if (target.startsWith(`${child.path}/`)) return findDirectory(child, dir);
  }
  return undefined;
}

/**
 * Compact indented listing for prompts and the list_directory tool. Within
 * the budget every concept gets a line; past it the listing falls back to
 * directories with concept counts, so the prompt stops growing with the
 * bundle and the model drills down with list_directory or search instead.
 */
export function formatTree(node: TreeNode, maxChars: number = PROMPT_LIMITS.treeChars): string {
  const full = renderTree(node, 0, true);
  if (full.length <= maxChars) return full;
  const total = countConcepts(node);
  const header = `[${total} concepts — too many to list. Directories with their concept counts; list_directory with a path lists one, search_knowledge finds the rest.]`;
  const outline = `${header}\n${renderTree(node, 0, false)}`;
  if (outline.length <= maxChars) return outline;
  const tail = "\n[… more directories not shown]";
  const cut = outline.slice(0, maxChars - tail.length);
  return cut.slice(0, cut.lastIndexOf("\n")) + tail;
}

function renderTree(node: TreeNode, depth: number, withConcepts: boolean): string {
  const lines: string[] = [];
  if (depth === 0) lines.push(node.path && node.path !== "/" ? `${sanitizePath(node.path)}/` : "/");
  for (const child of node.children ?? []) {
    const indent = "  ".repeat(depth + 1);
    if (child.kind === "directory") {
      const count = withConcepts ? "" : `  (${countConcepts(child)})`;
      lines.push(`${indent}${sanitizePath(child.name)}/${count}`);
      lines.push(renderTree(child, depth + 1, withConcepts));
    } else if (child.kind === "concept" && withConcepts) {
      // Names, types and descriptions are stored content: one line each, always.
      const meta = [sanitizeInline(child.type, 60), sanitizeInline(child.description, 160)]
        .filter(Boolean)
        .join(" — ");
      lines.push(`${indent}${sanitizePath(child.name)}${meta ? `  [${meta}]` : ""}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function countConcepts(node: TreeNode): number {
  return (node.children ?? []).reduce(
    (n, child) =>
      n + (child.kind === "concept" ? 1 : child.kind === "directory" ? countConcepts(child) : 0),
    0
  );
}
