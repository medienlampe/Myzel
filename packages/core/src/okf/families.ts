import type { ConformanceIssue } from "./types.js";

/**
 * The OKF v0.2 vocabulary beyond `type`: which frontmatter keys hold scalars,
 * which hold the structured families of spec §5 and §10, and the soft checks
 * on those families. Producers SHOULD follow §5–§10; consumers MUST NOT reject
 * a concept over them (§11), so every finding here is a warning.
 */

export const OKF_VERSION = "0.2";

/** Spec-defined keys whose value is a string (or, for tags, a list of strings). */
export const SCALAR_KEYS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  "stale_after",
  "runtime",
  "computation",
  // v0.1's last-change stamp, superseded by generated.at (§13.1).
  "timestamp",
]);

/** Spec-defined keys whose value is a mapping or a list of mappings (§5, §10). */
export const FAMILY_KEYS = new Set([
  "sources",
  "usage_window",
  "generated",
  "verified",
  "parameters",
  "executor",
  "attester",
]);

/** Keys the write path sets itself; an agent may neither set nor change them. */
export const SYSTEM_KEYS = new Set(["generated", "verified", "timestamp"]);

export const STATUSES = ["draft", "stable", "deprecated"] as const;

/** §5: every timestamp is an ISO 8601 datetime with an explicit UTC offset. */
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isOkfDatetime(value: unknown): boolean {
  return typeof value === "string" && DATETIME.test(value) && !Number.isNaN(Date.parse(value));
}

/** §7: `<producer>/<version>`, `human:<id>` or `process:<id>`. */
export function isActor(value: unknown): boolean {
  return typeof value === "string" && /^(human:|process:)\S+$|^[^\s/:]+\/\S+$/.test(value);
}

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True if the value is a mapping, or a list holding one anywhere. */
export function containsPlainObject(value: unknown): boolean {
  if (value instanceof Date) return false;
  if (Array.isArray(value)) return value.some(containsPlainObject);
  return typeof value === "object" && value !== null;
}

/** Top-level keys whose values contain a mapping. */
export function findPlainObjectKeys(frontmatter: Record<string, unknown>): string[] {
  return Object.entries(frontmatter)
    .filter(([, value]) => containsPlainObject(value))
    .map(([key]) => key);
}

/** Soft checks on the §5 and §10 families of one concept. */
export function familyIssues(path: string, fm: Record<string, unknown>): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const warn = (message: string) => issues.push({ path, severity: "warning", message });
  const datetime = (value: unknown, where: string) => {
    if (value !== undefined && !isOkfDatetime(value)) {
      warn(`${where} should be an ISO 8601 datetime with a UTC offset (spec §5)`);
    }
  };
  const actor = (value: unknown, where: string) => {
    if (!isActor(value)) {
      warn(
        `${where} should be an actor: <producer>/<version>, human:<id> or process:<id> (spec §7)`
      );
    }
  };

  if (fm.sources !== undefined) {
    if (!Array.isArray(fm.sources)) warn('"sources" should be a list (spec §5.1)');
    else {
      fm.sources.forEach((source, i) => {
        if (!isMapping(source) || typeof source.resource !== "string" || !source.resource) {
          warn(`sources[${i}] needs a "resource" (spec §5.1)`);
          return;
        }
        // `author` is left alone: the spec's own examples use team:<id> there.
        datetime(source.last_modified, `sources[${i}].last_modified`);
      });
    }
  }
  if (fm.usage_window !== undefined) {
    if (!isMapping(fm.usage_window))
      warn('"usage_window" should be a { from, to } mapping (spec §5.1)');
    else {
      datetime(fm.usage_window.from, "usage_window.from");
      datetime(fm.usage_window.to, "usage_window.to");
    }
  }
  if (fm.generated !== undefined) {
    if (!isMapping(fm.generated)) warn('"generated" should be a { by, at } mapping (spec §5.2)');
    else {
      actor(fm.generated.by, "generated.by");
      datetime(fm.generated.at, "generated.at");
    }
  }
  if (fm.verified !== undefined) {
    // §5.2: a bare mapping is a one-element list.
    const events = Array.isArray(fm.verified) ? fm.verified : [fm.verified];
    events.forEach((event, i) => {
      if (!isMapping(event)) {
        warn(`verified[${i}] should be a { by, at } mapping (spec §5.2)`);
        return;
      }
      actor(event.by, `verified[${i}].by`);
      datetime(event.at, `verified[${i}].at`);
    });
  }
  if (fm.status !== undefined && !STATUSES.includes(fm.status as (typeof STATUSES)[number])) {
    warn(`"status" should be one of ${STATUSES.join(", ")} (spec §5.4)`);
  }
  datetime(fm.stale_after, '"stale_after"');
  if (fm.type === "Attested Computation" && (typeof fm.runtime !== "string" || !fm.runtime)) {
    warn('An Attested Computation needs a "runtime" (spec §10.2)');
  }
  return issues;
}
