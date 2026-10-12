import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Tree } from "../src/components/Tree";
import { LogView } from "../src/components/LogView";
import { ConceptView } from "../src/components/ConceptView";
import { MarkdownRenderer } from "../src/components/MarkdownRenderer";
import type { Concept, LogEntry, TreeNode } from "../src/api";
import { CONCEPT, LOG, TREE } from "./support/fake-api";

describe("Tree", () => {
  it("lists folders and concepts, opens on click and folds folders", () => {
    const onSelect = vi.fn();
    render(<Tree node={TREE as TreeNode} selected="/apis/billing.md" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Billing API"));
    expect(onSelect).toHaveBeenCalledWith("/apis/billing.md");
    fireEvent.click(screen.getAllByText("log.md")[0]);
    expect(onSelect).toHaveBeenCalledWith("/log.md");

    const folder = screen.getByRole("button", { name: /apis\// });
    expect(folder).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(folder);
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Billing API")).not.toBeInTheDocument();
  });
});

describe("LogView", () => {
  it("groups entries by day and links to concepts", async () => {
    const onNavigate = vi.fn();
    render(<LogView entries={LOG as LogEntry[]} onNavigate={onNavigate} />);
    expect(screen.getAllByText("2026-10-02")).toHaveLength(1); // one heading per day
    expect(screen.getByText("Deletion")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Billing"));
    expect(onNavigate).toHaveBeenCalledWith("/apis/billing.md");
  });

  it("says when there is nothing yet", () => {
    render(<LogView entries={[]} onNavigate={() => {}} />);
    expect(screen.getByText("No log entries yet.")).toBeInTheDocument();
  });
});

describe("ConceptView", () => {
  it("shows the frontmatter, survives odd values and resolves relative links", async () => {
    const onNavigate = vi.fn();
    render(<ConceptView concept={CONCEPT as unknown as Concept} onNavigate={onNavigate} />);
    expect(screen.getByRole("heading", { name: "Billing API" })).toBeInTheDocument();
    expect(screen.getByText("#money")).toBeInTheDocument();
    expect(screen.getByText('#{"odd":"tag"}')).toBeInTheDocument(); // a mapping, not a crash
    expect(screen.getByText("owner:")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Customers"));
    expect(onNavigate).toHaveBeenCalledWith("/tables/customers.md");
    expect(screen.getByText("docs")).toHaveAttribute("target", "_blank");
  });

  it("resolves directory, absolute, encoded and fragment links", async () => {
    const onNavigate = vi.fn();
    const body =
      "[dir](sub/) [abs](/b/) [enc](my%20notes.md) [frag](x.md#part) [anchor](#top) [bad](%E0%A4.md)";
    render(
      <ConceptView
        concept={{ path: "/a/doc.md", frontmatter: { type: "T" }, body, raw: "" } as Concept}
        onNavigate={onNavigate}
      />
    );
    for (const text of ["dir", "abs", "enc", "frag", "bad"])
      fireEvent.click(await screen.findByText(text));
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual([
      "/a/sub/index.md",
      "/b/index.md",
      "/a/my notes.md",
      "/a/x.md",
      "/a/%E0%A4.md",
    ]);
    expect(screen.getByText("anchor").closest("a")).not.toHaveAttribute("target", "_blank");
  });

  it("marks generated files instead of showing a frontmatter card", () => {
    render(
      <ConceptView
        concept={
          { path: "/apis/index.md", frontmatter: { type: "" }, body: "# Apis", raw: "" } as Concept
        }
        onNavigate={() => {}}
      />
    );
    expect(screen.getByText(/generated directory index/)).toBeInTheDocument();
  });
});

describe("MarkdownRenderer", () => {
  it("renders GFM tables, inline code and highlighted code blocks", async () => {
    const { container } = render(
      <MarkdownRenderer>
        {
          "| a | b |\n|---|---|\n| 1 | 2 |\n\nUse `npm ci`.\n\n```ts\nconst x: number = 1;\n```\n\n```unknownlang\nplain\n```"
        }
      </MarkdownRenderer>
    );
    expect(container.querySelector("table")).toBeInTheDocument();
    expect(screen.getByText("npm ci").tagName).toBe("CODE");
    await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
    expect(screen.getByText("plain")).toBeInTheDocument();
  });

  it("strips scripts and unsafe links", () => {
    const { container } = render(
      <MarkdownRenderer>
        {'<script>alert(1)</script>[x](javascript:alert(1)) <img src=x onerror="alert(1)">'}
      </MarkdownRenderer>
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript");
    expect(container.innerHTML).not.toContain("onerror");
  });
});
