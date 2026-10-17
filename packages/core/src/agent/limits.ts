/**
 * Ceilings for bundle content headed into a prompt. The server caps what
 * callers send (server/src/limits.ts); these cap what the bundle itself
 * contributes. Every step of the tool loop re-sends the system prompt and all
 * earlier tool output, so a listing that grows with the bundle would make each
 * run cost as much as the bundle is big — and outgrow the context of the
 * cheap models Myzel promises to run on.
 */
export const PROMPT_LIMITS = {
  /** Bundle layout in the system prompt, list_directory and a search miss. */
  treeChars: 8_000,
  /** Orphans, broken links and similar lists in tool output and instructions. */
  listEntries: 25,
  /** One concept body in read_concept. */
  readBodyChars: 20_000,
  /** One concept's frontmatter in read_concept, as JSON. */
  readFrontmatterChars: 4_000,
  /** Title and description of one search hit. */
  hitFieldChars: 300,
  /** Search hits per search_knowledge call. */
  searchHits: 25,
  /** One stored answer replayed by hot memory. */
  hotAnswerChars: 1_500,
  /** Body the model may write in one call — a long document, not a dump. */
  writeBodyChars: 200_000,
  /** One log summary the model may write. */
  logSummaryChars: 1_000,
} as const;

/** The first `max` entries plus a count of the rest, for lists that grow with the bundle. */
export function capList<T>(items: readonly T[], max: number = PROMPT_LIMITS.listEntries) {
  return { shown: items.slice(0, max), omitted: Math.max(0, items.length - max) };
}
