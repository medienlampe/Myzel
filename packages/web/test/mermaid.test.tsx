import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "../src/components/MarkdownRenderer";

// jsdom cannot lay out SVG text, so the real Mermaid cannot render here. The
// fake returns whatever SVG a test hands it, hostile markup included.
const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (code: string) => !code.includes("syntax error")),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120.5 40"><script>alert(1)</script>' +
  '<text onclick="alert(2)">A → B</text></svg>';

beforeEach(() => {
  mermaid.initialize.mockClear();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({ svg: HOSTILE_SVG });
});

describe("Mermaid diagrams", () => {
  it("shows a mermaid block as an image, never as inline SVG", async () => {
    const { container } = render(
      <MarkdownRenderer>{"```mermaid\ngraph LR\n  A --> B\n```"}</MarkdownRenderer>
    );
    const img = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain("A → B");
    expect(img).toHaveAttribute("width", "121");
    expect(img).toHaveAttribute("height", "40");
    // The SVG's markup never reaches the document.
    expect(container.querySelector("svg, script, [onclick]")).toBeNull();
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), "graph LR\n  A --> B");
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", htmlLabels: false, theme: "default" })
    );
  });

  it("keeps a block that does not parse as code", async () => {
    render(<MarkdownRenderer>{"```mermaid\ngraph LR syntax error\n```"}</MarkdownRenderer>);
    await waitFor(() => expect(mermaid.parse).toHaveBeenCalled());
    expect(screen.getByText("graph LR syntax error").tagName).toBe("CODE");
    expect(screen.queryByRole("img")).toBeNull();
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("keeps the code when rendering fails", async () => {
    mermaid.render.mockRejectedValue(new Error("layout failed"));
    render(<MarkdownRenderer>{"```mermaid\ngraph TD\n  X --> Y\n```"}</MarkdownRenderer>);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    expect(screen.getByText(/X --> Y/).tagName).toBe("CODE");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders in the dark theme when the system is dark", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: true,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList
    );
    render(<MarkdownRenderer>{"```mermaid\ngraph LR\n  A --> B\n```"}</MarkdownRenderer>);
    await screen.findByRole("img");
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark" }));
    vi.restoreAllMocks();
  });

  it("leaves other code blocks alone", async () => {
    const { container } = render(<MarkdownRenderer>{"```ts\nconst x = 1;\n```"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector("pre.shiki")).toBeInTheDocument());
    expect(mermaid.parse).not.toHaveBeenCalledWith("const x = 1;", expect.anything());
  });
});
