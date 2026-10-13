import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/react";
import { composerMarkdown } from "../src/composer-markdown";

const text = (t: string, ...marks: Array<string | { type: string; attrs: object }>) => ({
  type: "text",
  text: t,
  marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)),
});
const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const doc = (...content: JSONContent[]) => composerMarkdown({ type: "doc", content });
const link = (href: string) => ({ type: "link", attrs: { href } });

describe("composerMarkdown", () => {
  it("keeps text exactly as typed — no escapes, no entities", () => {
    expect(doc(p(text("a_b * c < d & e [x] \\ `")))).toBe("a_b * c < d & e [x] \\ `");
  });

  it("opens and closes marks only where they change", () => {
    expect(
      doc(p(text("a ", "bold"), text("b", "bold", "italic"), text(" c", "bold"), text(" d")))
    ).toBe("**a _b_ c** d");
    expect(doc(p(text("x", "strike"), text("y", "italic")))).toBe("~~x~~_y_");
  });

  it("writes links around their marked text, and keeps two links apart", () => {
    expect(
      doc(
        p(
          text("see ", link("https://a.example")),
          text("docs", link("https://a.example"), "bold"),
          text("other", link("https://b.example"))
        )
      )
    ).toBe("[see **docs**](https://a.example)[other](https://b.example)");
  });

  it("fences code spans and blocks around the backticks they contain", () => {
    expect(doc(p(text("a`b", "code", "bold")))).toBe("**``a`b``**");
    expect(doc(p(text("`x", "code")))).toBe("`` `x ``");
    expect(
      doc({
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "x = 1" }],
      })
    ).toBe("```ts\nx = 1\n```");
    expect(doc({ type: "codeBlock", content: [{ type: "text", text: "```md\n```" }] })).toBe(
      "````\n```md\n```\n````"
    );
  });

  it("writes headings, quotes, rules and hard breaks", () => {
    expect(doc({ type: "heading", attrs: { level: 2 }, content: [text("Title")] })).toBe(
      "## Title"
    );
    expect(doc({ type: "heading", content: [text("T")] })).toBe("# T");
    expect(doc({ type: "blockquote", content: [p(text("one")), p(text("two"))] })).toBe(
      "> one\n>\n> two"
    );
    expect(doc(p(text("a")), { type: "horizontalRule" }, p(text("b")))).toBe("a\n\n---\n\nb");
    expect(doc(p(text("a"), { type: "hardBreak" }, text("b")))).toBe("a\\\nb");
  });

  it("writes tight bullet and ordered lists, nested ones indented", () => {
    const item = (...content: JSONContent[]) => ({ type: "listItem", content });
    expect(
      doc({
        type: "bulletList",
        content: [
          item(p(text("one")), { type: "bulletList", content: [item(p(text("deep")))] }),
          item(p(text("two"))),
        ],
      })
    ).toBe("- one\n  - deep\n- two");
    expect(
      doc({
        type: "orderedList",
        attrs: { start: 9 },
        content: [item(p(text("nine"))), item(p(text("ten")), p(text("more")))],
      })
    ).toBe("9. nine\n10. ten\n    more");
    expect(doc({ type: "orderedList", content: [item(p(text("a")))] })).toBe("1. a");
  });

  it("trims, and falls back to the text of unknown nodes", () => {
    expect(doc(p(), p(text("x")), p())).toBe("x");
    expect(composerMarkdown({ type: "doc" })).toBe("");
    expect(doc({ type: "mystery", text: "kept" })).toBe("kept");
    expect(doc({ type: "mystery" })).toBe("");
    expect(doc(p(text("u", "underline")))).toBe("u");
  });
});
