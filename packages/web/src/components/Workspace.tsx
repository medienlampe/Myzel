import { Fragment, useState, type DragEvent, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  movePanel,
  shiftPanel,
  togglePanel,
  visiblePanels,
  visibleSizes,
  type DropSide,
  type LayoutState,
  type PanelId,
} from "../layout";

/** MIME type of a panel being dragged — nothing else on the page can carry it. */
const DRAG_TYPE = "application/x-myzel-panel";

export interface PanelSpec {
  title: string;
  /** Minimum width in pixels, so a panel cannot be squeezed into uselessness. */
  minWidth: number;
  content: ReactNode;
}

interface DropTarget {
  id: PanelId;
  side: DropSide;
}

/**
 * Resizable columns whose order the user rearranges by dragging a panel's
 * title bar onto another panel: the left or right half of the target decides
 * on which side it lands. Arrow buttons in the title bar do the same from the
 * keyboard.
 */
export function Workspace({
  layout,
  onLayoutChange,
  panels,
}: {
  layout: LayoutState;
  onLayoutChange: (layout: LayoutState) => void;
  panels: Record<PanelId, PanelSpec>;
}) {
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const visible = visiblePanels(layout);

  const endDrag = () => {
    setDragging(null);
    setDropTarget(null);
  };

  const sideOf = (e: DragEvent<HTMLElement>): DropSide => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const onDragOver = (id: PanelId) => (e: DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault(); // marks this element as a valid drop zone
    e.dataTransfer.dropEffect = "move";
    const side = sideOf(e);
    if (dropTarget?.id !== id || dropTarget.side !== side) setDropTarget({ id, side });
  };

  const onDrop = (id: PanelId) => (e: DragEvent<HTMLElement>) => {
    const source = e.dataTransfer.getData(DRAG_TYPE) as PanelId;
    e.preventDefault();
    endDrag();
    if (!visible.includes(source)) return;
    onLayoutChange({ ...layout, order: movePanel(layout.order, source, id, sideOf(e)) });
  };

  return (
    <Group
      // Remount when the column order changes: panel order is fixed at mount,
      // and the saved widths are reapplied through defaultLayout.
      key={visible.join("|")}
      orientation="horizontal"
      defaultLayout={visibleSizes(layout)}
      onLayoutChanged={(sizes, meta) => {
        if (!meta.isUserInteraction) return;
        onLayoutChange({
          ...layout,
          sizes: { ...layout.sizes, ...(meta.requestedLayout ?? sizes) },
        });
      }}
      className="min-h-0 flex-1"
    >
      {visible.map((id, index) => {
        const spec = panels[id];
        const isTarget = dragging !== null && dragging !== id && dropTarget?.id === id;
        return (
          <Fragment key={id}>
            {index > 0 && (
              <Separator className="w-px bg-zinc-800 outline-hidden transition-colors focus-visible:bg-cyan-500 data-[separator=active]:bg-cyan-500 data-[separator=hover]:bg-cyan-700" />
            )}
            <Panel id={id} minSize={spec.minWidth} className="relative flex h-full flex-col">
              <section aria-label={spec.title} className="flex h-full min-h-0 flex-col">
                <header
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(id);
                  }}
                  onDragEnd={endDrag}
                  title="Drag to move this panel"
                  className={`flex shrink-0 cursor-grab items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/40 px-2 py-1 text-xs select-none active:cursor-grabbing ${
                    dragging === id ? "opacity-50" : ""
                  }`}
                >
                  <span aria-hidden className="text-zinc-600">
                    ⠿
                  </span>
                  <h2 className="font-semibold tracking-wide text-zinc-400 uppercase">
                    {spec.title}
                  </h2>
                  <div className="ml-auto flex items-center">
                    <PanelButton
                      label={`Move ${spec.title} left`}
                      disabled={index === 0}
                      onClick={() =>
                        onLayoutChange({ ...layout, order: shiftPanel(layout, id, -1) })
                      }
                    >
                      ←
                    </PanelButton>
                    <PanelButton
                      label={`Move ${spec.title} right`}
                      disabled={index === visible.length - 1}
                      onClick={() =>
                        onLayoutChange({ ...layout, order: shiftPanel(layout, id, 1) })
                      }
                    >
                      →
                    </PanelButton>
                    <PanelButton
                      label={`Close ${spec.title}`}
                      disabled={visible.length <= 1}
                      onClick={() => onLayoutChange(togglePanel(layout, id))}
                    >
                      ×
                    </PanelButton>
                  </div>
                </header>
                <div className="relative min-h-0 flex-1">{spec.content}</div>
              </section>

              {/* While a panel is dragged, a shield over every other panel takes
                  the drop — otherwise inputs, the graph canvas or links inside
                  would swallow the drag events. */}
              {dragging !== null && dragging !== id && (
                <div
                  onDragOver={onDragOver(id)}
                  onDragLeave={() => setDropTarget((t) => (t?.id === id ? null : t))}
                  onDrop={onDrop(id)}
                  className="absolute inset-0 z-30"
                >
                  {isTarget && (
                    <div
                      className={`pointer-events-none absolute inset-y-0 w-1/2 border-cyan-400 bg-cyan-500/15 ${
                        dropTarget?.side === "before" ? "left-0 border-l-4" : "right-0 border-r-4"
                      }`}
                    />
                  )}
                </div>
              )}
            </Panel>
          </Fragment>
        );
      })}
    </Group>
  );
}

function PanelButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      // The title bar is draggable; keep clicks on its buttons from starting a drag.
      onMouseDown={(e) => e.stopPropagation()}
      draggable={false}
      className="rounded-sm px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
