import { isDeepStrictEqual } from "node:util";
import { Document, isMap, isSeq, parse, parseDocument, visit, type Node } from "yaml";
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
 * (spec §4.1 — unknown keys round-trip untouched).
 */
const CLOSING_FENCE = /^---[ \t]*\r?$/m;

/**
 * Permissive parse (spec §11: consumers must not reject unknown keys/types).
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
 * read back exactly what was stored. Strings that only the 1.2 core schema
 * reads differently (`0o17`) are quoted too, so parseDoc gets them back.
 *
 * Given the file's previous text, the write is an edit of that YAML rather
 * than a fresh dump: keys whose value did not change keep their text —
 * comments, quoting, flow lists, order — so a hand-edited file comes back the
 * way its author wrote it and a git diff shows only what changed (plus quotes
 * on any plain value a YAML 1.1 reader would misread).
 */
export function serializeDoc(
  frontmatter: ConceptFrontmatter,
  body: string,
  previousRaw?: string
): string {
  const yaml = (previousRaw && editYaml(previousRaw, frontmatter)) ?? freshYaml(frontmatter);
  // parseDoc drops one blank line after the fence as formatting; a body that
  // really starts with a blank line gets one extra so it survives the round trip.
  const content = body.endsWith("\n") ? body : body + "\n";
  const keepBlank = content.trim() !== "" && /^\r?\n/.test(content);
  return `---\n${yaml}---\n${keepBlank ? "\n" : ""}${content}`;
}

function freshYaml(frontmatter: ConceptFrontmatter): string {
  const doc = new Document(frontmatter, { version: "1.1" });
  quoteAmbiguous(doc);
  return doc.toString({ singleQuote: true });
}

/** The previous YAML with changed keys replaced, or null when it can't be edited. */
function editYaml(previousRaw: string, frontmatter: ConceptFrontmatter): string | null {
  const text = previousRaw.replace(/^\uFEFF/, "");
  const firstBreak = text.indexOf("\n");
  if (!text.startsWith("---") || text[3] === "-" || firstBreak === -1) return null;
  const rest = text.slice(firstBreak + 1);
  const close = CLOSING_FENCE.exec(rest);
  if (!close) return null;
  const doc = parseDocument(rest.slice(0, close.index), { schema: "core" });
  // Nothing worth keeping (empty or broken frontmatter): write it fresh.
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const before = doc.toJS() as Record<string, unknown>;

  for (const key of Object.keys(before)) {
    if (!(key in frontmatter)) doc.delete(key);
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key in before && isDeepStrictEqual(before[key], value)) continue;
    const old = doc.get(key, true) as Node | undefined;
    const node = doc.createNode(value) as Node;
    quoteAmbiguous(node);
    if (isSeq(old) && isSeq(node)) node.flow = old.flow;
    doc.set(key, node);
  }
  // Kept values stay YAML-1.1-safe too: an unquoted date or `yes` gains quotes,
  // nothing else about it changes.
  quoteAmbiguous(doc);
  return doc.toString({ singleQuote: true });
}

function quoteAmbiguous(node: Document | Node): void {
  visit(node, {
    Scalar(_key, scalar) {
      // Already-quoted or block scalars are unambiguous as written.
      const plain = scalar.type === undefined || scalar.type === "PLAIN";
      if (plain && typeof scalar.value === "string" && !readsAsString(scalar.value)) {
        scalar.type = "QUOTE_SINGLE";
      }
    },
  });
}

/** True when both a YAML 1.2 (core) and a YAML 1.1 reader get the plain text back as this string. */
function readsAsString(value: string): boolean {
  try {
    return (
      typeof parse(value, { schema: "core" }) === "string" &&
      typeof parse(value, { version: "1.1" }) === "string"
    );
  } catch {
    return false;
  }
}

export function hasNonEmptyType(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.type === "string" && frontmatter.type.trim().length > 0;
}
