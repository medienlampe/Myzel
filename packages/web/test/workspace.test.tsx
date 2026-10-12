import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Workspace, type PanelSpec } from "../src/components/Workspace";
import { DEFAULT_LAYOUT, type LayoutState, type PanelId } from "../src/layout";

const PANELS: Record<PanelId, PanelSpec> = {
  explorer: { title: "Explorer", minWidth: 100, content: <p>explorer body</p> },
  content: { title: "View", minWidth: 100, content: <p>view body</p> },
  chat: { title: "Agent chat", minWidth: 100, content: <input aria-label="chat input" /> },
};

function Harness({ onChange }: { onChange?: (l: LayoutState) => void }) {
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  return (
    <Workspace
      layout={layout}
      panels={PANELS}
      onLayoutChange={(next) => {
        setLayout(next);
        onChange?.(next);
      }}
    />
  );
}

const order = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    types: [] as string[],
    dropEffect: "",
    effectAllowed: "",
    setData(type: string, value: string) {
      data.set(type, value);
      this.types.push(type);
    },
    getData: (type: string) => data.get(type) ?? "",
  };
}

describe("Workspace", () => {
  it("moves panels with the arrow buttons and closes them", () => {
    render(<Harness />);
    expect(order()).toEqual(["Explorer", "View", "Agent chat"]);
    expect(screen.getByRole("button", { name: "Move Explorer left" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move Agent chat left" }));
    expect(order()).toEqual(["Explorer", "Agent chat", "View"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Explorer right" }));
    expect(order()).toEqual(["Agent chat", "Explorer", "View"]);
    fireEvent.click(screen.getByRole("button", { name: "Close Explorer" }));
    expect(order()).toEqual(["Agent chat", "View"]);
  });

  it("moves a panel by dragging its title bar onto the left or right half of another", () => {
    render(<Harness />);
    const dt = dataTransfer();
    const chatHeader = screen.getByRole("heading", { name: "Agent chat" }).closest("header")!;
    fireEvent.dragStart(chatHeader, { dataTransfer: dt });

    // While dragging, a shield covers the other panels and takes the drop.
    // (jsdom has no DragEvent, so there are no coordinates: the drop lands on
    // the target's right half — "after" it.)
    const explorer = screen.getByRole("region", { name: "Explorer" }).parentElement!;
    const shield = explorer.querySelector(".z-30")!;
    fireEvent.dragOver(shield, { dataTransfer: dt });
    expect(shield.querySelector(".border-r-4")).toBeInTheDocument();
    fireEvent.drop(shield, { dataTransfer: dt });
    expect(order()).toEqual(["Explorer", "Agent chat", "View"]);
  });

  it("ignores drags that are not panels and cancelled drags", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const header = screen.getByRole("heading", { name: "Agent chat" }).closest("header")!;
    const dt = dataTransfer();
    fireEvent.dragStart(header, { dataTransfer: dt });
    const shield = screen
      .getByRole("region", { name: "View" })
      .parentElement!.querySelector(".z-30")!;
    fireEvent.dragOver(shield, { dataTransfer: { types: ["text/plain"] } }); // e.g. a file
    fireEvent.dragLeave(shield);
    fireEvent.dragEnd(header);
    expect(
      screen.getByRole("region", { name: "View" }).parentElement!.querySelector(".z-30")
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
