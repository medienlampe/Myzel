import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAYOUT,
  loadLayout,
  movePanel,
  parseLayout,
  shiftPanel,
  togglePanel,
  visibleSizes,
  type LayoutState,
} from "../src/layout";

describe("movePanel", () => {
  it("puts the chat in the centre when dropped before the content panel", () => {
    expect(movePanel(DEFAULT_LAYOUT.order, "chat", "content", "before")).toEqual([
      "explorer",
      "chat",
      "content",
    ]);
  });

  it("moves a panel after its target", () => {
    expect(movePanel(DEFAULT_LAYOUT.order, "explorer", "chat", "after")).toEqual([
      "content",
      "chat",
      "explorer",
    ]);
  });

  it("ignores a drop onto the dragged panel itself", () => {
    expect(movePanel(DEFAULT_LAYOUT.order, "chat", "chat", "before")).toBe(DEFAULT_LAYOUT.order);
  });
});

describe("shiftPanel", () => {
  it("skips hidden panels", () => {
    const layout: LayoutState = { ...DEFAULT_LAYOUT, hidden: ["content"] };
    expect(shiftPanel(layout, "chat", -1)).toEqual(["chat", "explorer", "content"]);
  });

  it("is a no-op at the edge", () => {
    expect(shiftPanel(DEFAULT_LAYOUT, "explorer", -1)).toBe(DEFAULT_LAYOUT.order);
  });
});

describe("togglePanel", () => {
  it("hides and restores a panel", () => {
    const hidden = togglePanel(DEFAULT_LAYOUT, "chat");
    expect(hidden.hidden).toEqual(["chat"]);
    expect(togglePanel(hidden, "chat").hidden).toEqual([]);
  });

  it("never hides the last visible panel", () => {
    const one: LayoutState = { ...DEFAULT_LAYOUT, hidden: ["explorer", "chat"] };
    expect(togglePanel(one, "content")).toBe(one);
  });
});

describe("visibleSizes", () => {
  it("rescales the visible panels to 100%", () => {
    const sizes = visibleSizes({ ...DEFAULT_LAYOUT, hidden: ["explorer"] });
    expect(Object.keys(sizes)).toEqual(["content", "chat"]);
    expect(sizes.content + sizes.chat).toBeCloseTo(100);
  });
});

describe("parseLayout", () => {
  it("round-trips a valid layout", () => {
    expect(parseLayout(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)))).toEqual(DEFAULT_LAYOUT);
  });

  it.each([
    ["null", null],
    ["unknown panel", { ...DEFAULT_LAYOUT, order: ["explorer", "content", "evil"] }],
    ["duplicate panel", { ...DEFAULT_LAYOUT, order: ["chat", "chat", "content"] }],
    ["missing panel", { ...DEFAULT_LAYOUT, order: ["chat", "content"] }],
    ["everything hidden", { ...DEFAULT_LAYOUT, hidden: ["explorer", "content", "chat"] }],
  ])("rejects %s", (_name, raw) => {
    expect(parseLayout(raw)).toBeNull();
  });

  it("replaces out-of-range sizes with defaults", () => {
    const parsed = parseLayout({ ...DEFAULT_LAYOUT, sizes: { explorer: -5, content: 300 } });
    expect(parsed?.sizes).toEqual(DEFAULT_LAYOUT.sizes);
  });
});

describe("loadLayout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(entries: Record<string, string>) {
    const map = new Map(Object.entries(entries));
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    return map;
  }

  it("picks up a layout saved under the name used before the rename", () => {
    const saved = { ...DEFAULT_LAYOUT, order: ["explorer", "chat", "content"] };
    const map = stubStorage({ "understory-layout": JSON.stringify(saved) });
    expect(loadLayout().order).toEqual(["explorer", "chat", "content"]);
    expect(map.has("understory-layout")).toBe(false);
    expect(map.has("myzel-layout")).toBe(true);
  });

  it("prefers the current key when both exist", () => {
    const current = { ...DEFAULT_LAYOUT, hidden: ["chat"] };
    stubStorage({
      "myzel-layout": JSON.stringify(current),
      "understory-layout": JSON.stringify({ ...DEFAULT_LAYOUT, hidden: ["explorer"] }),
    });
    expect(loadLayout().hidden).toEqual(["chat"]);
  });

  it("falls back to the default when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});
