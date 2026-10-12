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
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-zinc-800 ${
              selected === child.path ? "bg-zinc-800 text-cyan-300" : "text-zinc-300"
            } ${child.kind === "reserved" ? "italic text-zinc-500" : ""}`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <span className="truncate">{child.title ?? child.name}</span>
            {child.type && (
              <span className="ml-auto shrink-0 rounded-sm bg-zinc-800 px-1.5 py-0.5 text-[10px] text-purple-300">
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
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-medium text-zinc-400 hover:text-zinc-200"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className="text-xs">{open ? "▾" : "▸"}</span>
        {node.name}/
      </button>
      {open && <Tree node={node} selected={selected} onSelect={onSelect} depth={depth + 1} />}
    </div>
  );
}
