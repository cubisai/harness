import { useEffect, useRef } from "react";
import type { OutlineNode } from "./frame";

/** Whether a tree row is the canvas's current selection, matched by stable id when both have one, else by selector. */
export function isSelectedNode(node: OutlineNode, selected: { id?: string; selector: string } | null): boolean {
  if (!selected) return false;
  if (selected.id && node.id === selected.id) return true;
  return node.selector === selected.selector;
}

/**
 * The page's layer tree (the Elements tab): one row per element, indented by depth, with the selected row kept in
 * view. Purely presentational: the canvas owns the selection and reports the outline.
 */
export function ElementsTree({
  nodes,
  selected,
  onPick,
}: {
  /** The page outline, in document order. */
  nodes: OutlineNode[];
  /** The canvas's current selection, matched by id or selector. */
  selected: { id?: string; selector: string } | null;
  onPick: (node: OutlineNode) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selKey = selected ? `${selected.id ?? ""}|${selected.selector}` : "";
  useEffect(() => {
    if (!selKey) return;
    listRef.current?.querySelector(".el-row.on")?.scrollIntoView({ block: "nearest" });
  }, [selKey]);

  if (nodes.length === 0) return <p className="el-empty">No elements yet. Open a page to see its layers.</p>;

  const move = (from: number, step: number): void => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>(".el-row");
    if (!rows || rows.length === 0) return;
    rows[Math.min(rows.length - 1, Math.max(0, from + step))]?.focus();
  };
  return (
    <div className="el-tree" role="tree" aria-label="Elements" ref={listRef}>
      {nodes.map((node, i) => {
        const isSel = isSelectedNode(node, selected);
        return (
          <button
            key={`${node.selector}-${i}`}
            className={`el-row${isSel ? " on" : ""}`}
            role="treeitem"
            aria-level={node.depth + 1}
            aria-selected={isSel}
            style={{ paddingLeft: 8 + node.depth * 12 }}
            title={node.selector}
            onClick={() => onPick(node)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, e.key === "ArrowDown" ? 1 : -1);
              }
            }}
          >
            <span className="el-tag">{node.tag}</span>
            {node.cls && <span className="el-cls">.{node.cls}</span>}
            {node.id && <span className="el-id">#{node.id}</span>}
            {node.label && <span className="el-label">{node.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
