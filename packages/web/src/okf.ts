/**
 * Reading the OKF v0.2 families (spec §5) for display. Frontmatter is user
 * data, so every accessor tolerates a value of the wrong shape — it is then
 * treated as absent rather than shown or thrown.
 */

type Frontmatter = Record<string, unknown>;

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/** §5.3, from `verified` only; a bare mapping is a one-element list (§5.2). */
export function trustTier(fm: Frontmatter): TrustTier {
  if (fm.verified === undefined) return "unverified";
  const events = Array.isArray(fm.verified) ? fm.verified : [fm.verified];
  const actors = events.flatMap((e) => (isMapping(e) && text(e.by) ? [e.by as string] : []));
  if (actors.some((by) => by.startsWith("human:"))) return "human-reviewed";
  return actors.length > 0 ? "machine-confirmed" : "unverified";
}

/** §5.4: absent means stable; anything unknown is shown as written. */
export function status(fm: Frontmatter): string {
  return text(fm.status) ?? "stable";
}

/** §5.5: stale on or after `stale_after`. */
export function isStale(fm: Frontmatter, now = Date.now()): boolean {
  const at = text(fm.stale_after);
  const instant = at ? Date.parse(at) : NaN;
  return !Number.isNaN(instant) && now >= instant;
}

/** Who last changed the content and when: `generated` (§5.2), else v0.1's `timestamp`. */
export function lastChange(fm: Frontmatter): { by?: string; at?: string } | null {
  if (isMapping(fm.generated)) {
    const change = { by: text(fm.generated.by), at: text(fm.generated.at) };
    if (change.by || change.at) return change;
  }
  const legacy = text(fm.timestamp);
  return legacy ? { at: legacy } : null;
}

export interface Source {
  id?: string;
  resource: string;
  title?: string;
  author?: string;
}

/** §5.1 entries that carry their required `resource`. */
export function sources(fm: Frontmatter): Source[] {
  if (!Array.isArray(fm.sources)) return [];
  return fm.sources.flatMap((s) => {
    if (!isMapping(s) || !text(s.resource)) return [];
    return [
      {
        id: text(s.id),
        resource: s.resource as string,
        title: text(s.title),
        author: text(s.author),
      },
    ];
  });
}

/** Keys the concept card shows itself; everything else is listed as is. */
export const SHOWN_KEYS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
  "generated",
  "verified",
  "status",
  "stale_after",
  "sources",
  "usage_window",
]);
