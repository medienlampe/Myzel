import type { JSONContent } from "@tiptap/react";

/**
 * The chat composer's document as markdown. The message goes to the agent,
 * which may write it into the memory verbatim, so text comes out exactly as
 * typed: no backslash escapes, no HTML entities (TipTap's own serializer adds
 * both). Covers what the composer's StarterKit can produce.
 */

type Mark = NonNullable<JSONContent["marks"]>[number];

// Outermost first, so a link can hold bold text and `code` sits innermost.
const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];

const DELIMITERS: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  strike: ["~~", "~~"],
};

function openMark(mark: Mark): string {
  return mark.type === "link" ? "[" : (DELIMITERS[mark.type]?.[0] ?? "");
}

function closeMark(mark: Mark): string {
  if (mark.type === "link") return `](${String(mark.attrs?.href ?? "")})`;
  return DELIMITERS[mark.type]?.[1] ?? "";
}

function sameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && (a.type !== "link" || a.attrs?.href === b.attrs?.href);
}

/** A code span needs a backtick run longer than any inside it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Inline content, opening and closing marks only where they change. */
function inline(nodes: JSONContent[] = []): string {
  let out = "";
  let open: Mark[] = [];
  const closeFrom = (index: number) => {
    for (let i = open.length - 1; i >= index; i--) out += closeMark(open[i]);
    open = open.slice(0, index);
  };
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out += "\\\n";
      continue;
    }
    const marks = (node.marks ?? [])
      .filter((m) => MARK_ORDER.includes(m.type))
      .sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
    const isCode = marks.some((m) => m.type === "code");
    const outer = marks.filter((m) => m.type !== "code");
    let keep = 0;
    while (keep < open.length && keep < outer.length && sameMark(open[keep], outer[keep])) keep++;
    closeFrom(keep);
    for (const mark of outer.slice(keep)) {
      out += openMark(mark);
      open.push(mark);
    }
    const text = node.text ?? "";
    out += isCode ? codeSpan(text) : text;
  }
  closeFrom(0);
  return out;
}

function indent(text: string, prefix: string, first = prefix): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first : line ? prefix : prefix.trimEnd()) + line)
    .join("\n");
}

function block(node: JSONContent): string {
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
      return inline(children);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${inline(children)}`;
    case "codeBlock": {
      const text = children.map((c) => c.text ?? "").join("");
      const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${fence}${String(node.attrs?.language ?? "")}\n${text}\n${fence}`;
    }
    case "blockquote":
      return indent(blocks(children), "> ");
    case "bulletList":
      return children.map((item) => indent(listItem(item), "  ", "- ")).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      return children
        .map((item, i) => {
          const marker = `${start + i}. `;
          return indent(listItem(item), " ".repeat(marker.length), marker);
        })
        .join("\n");
    }
    case "horizontalRule":
      return "---";
    default:
      return children.length ? blocks(children) : (node.text ?? "");
  }
}

/** Items stay tight: their blocks are joined by single line breaks. */
function listItem(item: JSONContent): string {
  return (item.content ?? []).map(block).join("\n");
}

function blocks(nodes: JSONContent[]): string {
  return nodes.map(block).join("\n\n");
}

export function composerMarkdown(doc: JSONContent): string {
  return blocks(doc.content ?? []).trim();
}
