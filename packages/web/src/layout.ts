/**
 * Workspace layout: which panels are shown, in which column order, at which
 * widths. Pure functions so the drag & drop UI stays a thin shell around them.
 * Persisted per browser in localStorage — a convenience, never required: any
 * storage failure or malformed value falls back to the default.
 */

export const PANEL_IDS = ["explorer", "content", "chat"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface LayoutState {
  /** Column order, left to right. Always a permutation of PANEL_IDS. */
  order: PanelId[];
  /** Panels currently closed. At least one panel stays visible. */
  hidden: PanelId[];
  /** Last known width of each panel, in percent of the workspace. */
  sizes: Record<PanelId, number>;
}

export type DropSide = "before" | "after";

export const DEFAULT_LAYOUT: LayoutState = {
  order: ["explorer", "content", "chat"],
  hidden: [],
  sizes: { explorer: 20, content: 52, chat: 28 },
};

const STORAGE_KEY = "myzel-layout";
/** Key used before the project was renamed from understory. */
const LEGACY_STORAGE_KEY = "understory-layout";

function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

/** Accepts only a well-formed layout; anything else yields null. */
export function parseLayout(raw: unknown): LayoutState | null {
  if (!raw || typeof raw !== "object") return null;
  const { order, hidden, sizes } = raw as Partial<Record<keyof LayoutState, unknown>>;
  if (!Array.isArray(order) || order.length !== PANEL_IDS.length) return null;
  if (!order.every(isPanelId) || new Set(order).size !== PANEL_IDS.length) return null;
  if (!Array.isArray(hidden) || !hidden.every(isPanelId)) return null;
  if (new Set(hidden).size >= PANEL_IDS.length) return null;
  if (!sizes || typeof sizes !== "object") return null;
  const parsedSizes = { ...DEFAULT_LAYOUT.sizes };
  for (const id of PANEL_IDS) {
    const size = (sizes as Record<string, unknown>)[id];
    if (typeof size === "number" && Number.isFinite(size) && size > 0 && size <= 100) {
      parsedSizes[id] = size;
    }
  }
  return { order, hidden: [...new Set(hidden)], sizes: parsedSizes };
}

export function loadLayout(): LayoutState {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      if (raw === null) {
        raw = legacy;
        localStorage.setItem(STORAGE_KEY, legacy);
      }
    }
    return (raw && parseLayout(JSON.parse(raw))) || DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Private mode or blocked storage: the layout just won't survive a reload.
  }
}

export function visiblePanels(layout: LayoutState): PanelId[] {
  return layout.order.filter((id) => !layout.hidden.includes(id));
}

/** Moves `id` next to `target`, on the given side. Dropping onto itself is a no-op. */
export function movePanel(
  order: PanelId[],
  id: PanelId,
  target: PanelId,
  side: DropSide
): PanelId[] {
  if (id === target) return order;
  const rest = order.filter((p) => p !== id);
  const at = rest.indexOf(target) + (side === "after" ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Moves `id` one visible column left (-1) or right (+1) — the keyboard path. */
export function shiftPanel(layout: LayoutState, id: PanelId, delta: -1 | 1): PanelId[] {
  const visible = visiblePanels(layout);
  const neighbour = visible[visible.indexOf(id) + delta];
  if (!neighbour) return layout.order;
  return movePanel(layout.order, id, neighbour, delta < 0 ? "before" : "after");
}

export function togglePanel(layout: LayoutState, id: PanelId): LayoutState {
  if (layout.hidden.includes(id)) {
    return { ...layout, hidden: layout.hidden.filter((p) => p !== id) };
  }
  // Never close the last open panel — the workspace would be empty with no
  // obvious way back except the toolbar.
  if (visiblePanels(layout).length <= 1) return layout;
  return { ...layout, hidden: [...layout.hidden, id] };
}

/** Initial widths for the visible panels, rescaled so they add up to 100%. */
export function visibleSizes(layout: LayoutState): Record<string, number> {
  const visible = visiblePanels(layout);
  const total = visible.reduce((sum, id) => sum + layout.sizes[id], 0);
  return Object.fromEntries(visible.map((id) => [id, (layout.sizes[id] / total) * 100]));
}
