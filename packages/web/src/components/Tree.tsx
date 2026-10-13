import { useState } from "react";
import type { TreeNode } from "../api";

export function Tree({
  node,
  selected,
  onSelect,
  depth = 0,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  return (
    <div>
      {(node.children ?? []).map((child) =>
        child.kind === "directory" ? (
          <DirNode
            key={child.path}
            node={child}
            selected={selected}
            onSelect={onSelect}
            depth={depth}
          />
        ) : (
          <button
            key={child.path}
            onClick={() => onSelect(child.path)}
            title={child.description}
            className={`row flex w-full items-center gap-2 text-sm ${
              selected === child.path
                ? "bg-blue/15 text-blue hover:bg-blue/20"
                : child.kind === "reserved"
                  ? "text-muted italic"
                  : "text-fg"
            }`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <span className="truncate">{child.title ?? child.name}</span>
            {child.type && (
              <span className="chip ml-auto shrink-0 bg-violet/15 font-normal text-violet">
                {child.type}
              </span>
            )}
          </button>
        )
      )}
    </div>
  );
}

function DirNode({
  node,
  selected,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="row flex w-full items-center gap-1 text-sm font-medium text-muted hover:text-strong"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span aria-hidden className="text-xs">
          {open ? "▾" : "▸"}
        </span>
        {node.name}/
      </button>
      {open && <Tree node={node} selected={selected} onSelect={onSelect} depth={depth + 1} />}
    </div>
  );
}
