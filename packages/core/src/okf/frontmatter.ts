import { parse, stringify } from "yaml";
import type { ConceptFrontmatter } from "./types.js";

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Frontmatter is a `---` fenced YAML block at the very top of the file.
 *
 * Only YAML is accepted. A fence naming another language (`---js`) is refused
 * outright: general-purpose frontmatter libraries evaluate such blocks as code,
 * and a bundle file can come from anywhere (git sync, a bind mount).
 *
 * Parsing uses the YAML 1.2 core schema, so values keep the type they were
 * written with: an unquoted `2026-01-01` stays the string it was rather than
 * becoming a Date that would be re-serialized as `2026-01-01T00:00:00.000Z`
 * (spec §9 — unknown keys round-trip untouched).
 */
const CLOSING_FENCE = /^---[ \t]*\r?$/m;

/**
 * Permissive parse (spec §9: consumers must not reject unknown keys/types).
 * Throws only if the frontmatter itself is unusable: not YAML, not a mapping
 * or never closed.
 */
export function parseDoc(raw: string): ParsedDoc {
  const text = raw.replace(/^\uFEFF/, "");
  // "----" is a horizontal rule, not a fence.
  if (!text.startsWith("---") || text[3] === "-") return { frontmatter: {}, body: text };

  const firstBreak = text.indexOf("\n");
  const language = (firstBreak === -1 ? text.slice(3) : text.slice(3, firstBreak)).trim();
  if (language && language.toLowerCase() !== "yaml") {
    throw new Error(`only YAML frontmatter is supported (found "---${language}")`);
  }
  if (firstBreak === -1) return { frontmatter: {}, body: "" };

  const rest = text.slice(firstBreak + 1);
  const close = CLOSING_FENCE.exec(rest);
  if (!close) throw new Error("frontmatter is never closed (missing a second ---)");

  const data: unknown = parse(rest.slice(0, close.index), { schema: "core" });
  if (data != null && (typeof data !== "object" || Array.isArray(data))) {
    throw new Error("frontmatter must be a YAML mapping (key: value pairs)");
  }

  const afterFence = rest.slice(close.index + close[0].length).replace(/^\n/, "");
  return {
    frontmatter: (data as Record<string, unknown> | null) ?? {},
    // One blank line after the fence is formatting, not content.
    body: afterFence.replace(/^\r?\n/, ""),
  };
}

/**
 * Written in YAML 1.1 style: strings that a 1.1 reader would turn into
 * something else (`yes`, `012`, timestamps) are quoted, so other OKF tools
 * read back exactly what was stored.
 */
export function serializeDoc(frontmatter: ConceptFrontmatter, body: string): string {
  const yaml = stringify(frontmatter, { version: "1.1", singleQuote: true });
  // parseDoc drops one blank line after the fence as formatting; a body that
  // really starts with a blank line gets one extra so it survives the round trip.
  const content = body.endsWith("\n") ? body : body + "\n";
  const keepBlank = content.trim() !== "" && /^\r?\n/.test(content);
  return `---\n${yaml}---\n${keepBlank ? "\n" : ""}${content}`;
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}
