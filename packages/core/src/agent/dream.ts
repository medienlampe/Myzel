import type { KnowledgeBase } from "../okf/index.js";
import type { GraphNode } from "../okf/graph.js";
import { runMutation, type AgentOptions } from "./agent.js";
import {
  formatBrokenLinkList,
  formatLogLine,
  formatOrphanList,
  sanitizePath,
} from "./untrusted.js";

export interface DreamReport {
  ran: boolean;
  /** Why the dream was skipped (when ran=false). */
  reason?: string;
  summary?: string;
  filesChanged?: string[];
}

export interface DuplicateCandidate {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Log length (per bundle) when the last dream finished. The log only grows, so
 * "is there new activity?" has to be measured against the previous dream —
 * otherwise five entries, ever, would trigger a paid run on every interval.
 * In-process only: after a restart the first dream may look at the whole log.
 */
const logLengthAtLastDream = new Map<string, number>();
/**
 * The signals the last dream acted on, per bundle. The prompt tells the agent
 * to leave a genuinely unrelated orphan or two distinct look-alikes alone, so
 * such signals can outlive a dream; unchanged signals mean nothing new to do.
 */
const signalsAtLastDream = new Map<string, string>();
const MIN_NEW_ENTRIES_FOR_INSIGHTS = 5;

/**
 * Dreaming: an autonomous consolidation pass over the memory — what a brain
 * does during sleep. Deterministic signals decide whether there is anything
 * to dream about (orphans, broken links, likely duplicates, recent activity
 * worth abstracting); the agent then consolidates. No signals → no run, no
 * tokens.
 */

export async function runDream(
  kb: KnowledgeBase,
  options: AgentOptions = {},
  // Injectable for tests.
  runner: typeof runMutation = runMutation
): Promise<DreamReport> {
  if (kb.readOnly) return { ran: false, reason: "the memory is read-only" };
  const [lint, graph, log, fat] = await Promise.all([
    kb.lint(),
    kb.graph(),
    kb.readLog(),
    oversizedConcepts(kb),
  ]);
  const dupes = duplicateCandidates(graph.nodes);
  const insightsEnabled = process.env.DREAM_INSIGHTS !== "false";

  const signals: string[] = [];

  if (lint.orphans.length > 0) {
    signals.push(
      `ORPHANED CONCEPTS (nothing links to them). Read each and wire it into genuinely ` +
        `related concepts; if it relates to nothing, leave it alone:\n` +
        formatOrphanList(lint.orphans)
    );
  }
  if (lint.brokenLinks.length > 0) {
    signals.push(
      `BROKEN LINKS (target missing). Fix the path if the target moved, remove the link if it is gone:\n` +
        formatBrokenLinkList(lint.brokenLinks)
    );
  }
  if (dupes.length > 0) {
    signals.push(
      `LIKELY DUPLICATES (title/description similarity). Read each pair; if they cover the ` +
        `same thing, merge the content into the better-placed concept, update anything that ` +
        `linked to the removed one and delete the duplicate (deletion IS authorized for true ` +
        `duplicates after merging). If they are genuinely distinct, cross-link them instead:\n` +
        dupes.map((d) => `- ${sanitizePath(d.a)} ↔ ${sanitizePath(d.b)}`).join("\n")
    );
  }
  if (fat.length > 0) {
    signals.push(
      `OVERSIZED CONCEPTS (grown too large through repeated enrichment). For each: if the ` +
        `body contains genuinely separable topics, extract each into its OWN concept (proper ` +
        `type/title/description, back-linked per the rules), then rewrite the ORIGINAL file ` +
        `as a hub — a short summary that links to every extracted concept. NEVER delete or ` +
        `rename the original path; other concepts link to it. If the content is one ` +
        `indivisible topic, leave it alone:\n` +
        fat
          .map((f) => `- ${sanitizePath(f.path)} (${f.chars} chars, ${f.sections} sections)`)
          .join("\n")
    );
  }
  const newEntries = log.length - (logLengthAtLastDream.get(kb.bundle.root) ?? 0);
  if (insightsEnabled && newEntries >= MIN_NEW_ENTRIES_FOR_INSIGHTS) {
    signals.push(
      `CONSOLIDATION (optional). Review the recent activity below. If several concepts now ` +
        `describe one theme that has no overview concept, create ONE overview concept that ` +
        `summarizes and links them (and back-link per the rules). If nothing meaningful ` +
        `emerges, skip this — do not force an insight.\n` +
        log.slice(0, Math.min(newEntries, 10)).map(formatLogLine).join("\n")
    );
  }

  if (signals.length === 0) {
    return { ran: false, reason: "memory healthy — nothing to consolidate" };
  }
  const fingerprint = signals.join("\n\n");
  if (signalsAtLastDream.get(kb.bundle.root) === fingerprint) {
    return { ran: false, reason: "nothing new since the last dream" };
  }

  const instruction =
    `DREAM: autonomous memory consolidation (maintenance run, no user waiting).\n\n` +
    signals.join("\n\n") +
    `\n\nWork through the applicable items above. Be conservative: prefer small, clearly ` +
    `justified edits over sweeping rewrites. Summarize exactly what changed.`;

  // Oversized concepts become hubs; others link to them, so they stay put.
  const outcome = await runner(kb, instruction, { ...options, keep: fat.map((f) => f.path) });
  // Only a dream that did its work counts: a failed one (provider down,
  // timeout) must be retried on the next interval, not skipped as "seen".
  // The dream's own log entries count as seen, or it would trigger the next one.
  if (outcome.ok || outcome.status === "partial") {
    logLengthAtLastDream.set(kb.bundle.root, (await kb.readLog()).length);
    signalsAtLastDream.set(kb.bundle.root, fingerprint);
  }
  if (outcome.ok) {
    return {
      ran: true,
      summary: outcome.result.summary,
      filesChanged: outcome.result.filesChanged,
    };
  }
  // A dream runs unattended, so a failure is reported, not thrown: a partial
  // run still changed files the caller should hear about.
  return {
    ran: true,
    summary: `dream run failed: ${outcome.error}`,
    filesChanged: outcome.status === "partial" ? outcome.filesChanged : [],
  };
}

export interface OversizedConcept {
  path: string;
  chars: number;
  sections: number;
}

const SPLIT_CHARS = 6000;
const SPLIT_SECTIONS = 6;
const MAX_SPLITS_PER_DREAM = 3;

/**
 * Deterministic bloat detection — the counterpart of duplicate detection.
 * Enrich-over-create makes concepts grow forever; flag ones whose body is
 * very long or has sprouted many top-level sections, so the dream can split
 * them hub-and-spoke (original path preserved, so inbound links never break).
 */
export async function oversizedConcepts(kb: KnowledgeBase): Promise<OversizedConcept[]> {
  const paths = await kb.bundle.listConceptPaths();
  const out: OversizedConcept[] = [];
  for (const p of paths) {
    try {
      const c = await kb.readConcept(p);
      const sections = (c.body.match(/^#\s+/gm) ?? []).length;
      if (c.body.length >= SPLIT_CHARS || sections >= SPLIT_SECTIONS) {
        out.push({ path: p, chars: c.body.length, sections });
      }
    } catch {
      // Permissive: unreadable concepts are lint's problem, not the dream's.
    }
  }
  return out.sort((a, b) => b.chars - a.chars).slice(0, MAX_SPLITS_PER_DREAM);
}

/**
 * Deterministic duplicate detection: token-set similarity over title +
 * description. O(n²) — fine at personal-memory scale.
 */
export function duplicateCandidates(nodes: GraphNode[], threshold = 0.65): DuplicateCandidate[] {
  const tokenized = nodes
    .map((n) => ({ path: n.path, tokens: tokens(`${n.title ?? ""} ${n.description ?? ""}`) }))
    .filter((n) => n.tokens.size >= 2);
  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const similarity = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (similarity >= threshold) {
        out.push({ a: tokenized[i].path, b: tokenized[j].path, similarity });
      }
    }
  }
  return out.sort((x, y) => y.similarity - x.similarity).slice(0, 5);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
