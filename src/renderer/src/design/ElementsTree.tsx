import { ChevronRight, ClipboardList, Film, Frame, Heading, Image, Link, List, Menu, RectangleHorizontal, Search, Shapes, Square, Table, TextCursorInput, Type, X, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OutlineNode } from "./frame";
import { ancestorKeys, layerKey, layerKind, layerName, layerRows, type LayerKind } from "./layers";

/** Whether a tree row is the canvas's current selection, matched by stable id when both have one, else by selector. */
export function isSelectedNode(node: OutlineNode, selected: { id?: string; selector: string } | null): boolean {
  if (!selected) return false;
  if (selected.id && node.id === selected.id) return true;
  return node.selector === selected.selector;
}

const KIND_ICONS: Record<LayerKind, LucideIcon> = {
  heading: Heading,
  text: Type,
  image: Image,
  vector: Shapes,
  button: RectangleHorizontal,
  link: Link,
  input: TextCursorInput,
  list: List,
  nav: Menu,
  section: Frame,
  form: ClipboardList,
  table: Table,
  media: Film,
  group: Square,
};

/** Fewer layers than this and the search box stays hidden: the whole tree fits at a glance. */
const SEARCH_FROM = 12;

/**
 * The page's layer tree (the Layers rail and the Elements tab): one row per element with an icon for its kind and a
 * readable name, collapsible, searchable, and hovering a row outlines its element on the page. The selected row is
 * revealed and kept in view. Purely presentational: the canvas owns the selection and reports the outline.
 */
export function ElementsTree({
  nodes,
  selected,
  onPick,
  onHover,
}: {
  /** The page outline, in document order. */
  nodes: OutlineNode[];
  /** The canvas's current selection, matched by id or selector. */
  selected: { id?: string; selector: string } | null;
  onPick: (node: OutlineNode) => void;
  /** A row is hovered (or focused), or null when it's left. */
  onHover?: (node: OutlineNode | null) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const selKey = selected ? `${selected.id ?? ""}|${selected.selector}` : "";

  // A selection made on the page opens the rows above it.
  useEffect(() => {
    if (!selected) return;
    const i = nodes.findIndex((n) => isSelectedNode(n, selected));
    if (i < 0) return;
    const above = ancestorKeys(nodes, i).filter((k) => collapsed.has(k));
    if (above.length) setCollapsed((c) => new Set([...c].filter((k) => !above.includes(k))));
  }, [selKey, nodes]);
  useEffect(() => {
    if (!selKey) return;
    listRef.current?.querySelector(".el-row.on")?.scrollIntoView({ block: "nearest" });
  }, [selKey, collapsed]);

  const rows = useMemo(() => layerRows(nodes, collapsed, query), [nodes, collapsed, query]);

  if (nodes.length === 0) return <p className="el-empty">No elements yet. Open a page to see its layers.</p>;

  const toggle = (key: string, open?: boolean): void =>
    setCollapsed((c) => {
      const next = new Set(c);
      const isOpen = !next.has(key);
      if (open ?? !isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
  const focusRow = (r: number): void => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>(".el-row");
    if (!buttons || buttons.length === 0) return;
    buttons[Math.min(buttons.length - 1, Math.max(0, r))]?.focus();
  };
  const searching = query.trim() !== "";

  return (
    <div className="el-tree-wrap">
      {nodes.length >= SEARCH_FROM && (
        <div className="el-search">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a layer" aria-label="Find a layer" spellCheck={false} onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              focusRow(0);
            }
          }} />
          {query && (
            <button className="el-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div className="el-tree" role="tree" aria-label="Elements" ref={listRef} onMouseLeave={() => onHover?.(null)}>
        {rows.length === 0 && <p className="el-empty">No layer matches “{query.trim()}”.</p>}
        {rows.map(({ node, index, hasChildren }, r) => {
          const isSel = isSelectedNode(node, selected);
          const key = layerKey(node);
          const open = searching || !collapsed.has(key);
          const Icon = KIND_ICONS[layerKind(node)];
          const name = layerName(node);
          return (
            <button
              key={`${node.selector}-${index}`}
              className={`el-row${isSel ? " on" : ""}`}
              role="treeitem"
              aria-level={node.depth + 1}
              aria-selected={isSel}
              aria-expanded={hasChildren ? open : undefined}
              style={{ paddingLeft: 4 + node.depth * 12 }}
              title={node.selector}
              onClick={() => onPick(node)}
              onMouseEnter={() => onHover?.(node)}
              onFocus={() => onHover?.(node)}
              onBlur={() => onHover?.(null)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  focusRow(r + (e.key === "ArrowDown" ? 1 : -1));
                } else if (e.key === "ArrowRight" && hasChildren && !open) {
                  e.preventDefault();
                  toggle(key, true);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  if (hasChildren && open && !searching) toggle(key, false);
                  else {
                    // To the parent row: the nearest row above that is shallower.
                    for (let p = r - 1; p >= 0; p--) if (rows[p]!.node.depth < node.depth) return focusRow(p);
                  }
                }
              }}
            >
              <span
                className={`el-twisty${hasChildren ? "" : " none"}${open ? " open" : ""}`}
                aria-hidden
                onClick={(e) => {
                  if (!hasChildren || searching) return;
                  e.stopPropagation();
                  toggle(key);
                }}
              >
                {hasChildren && <ChevronRight size={12} />}
              </span>
              <Icon size={13} strokeWidth={1.75} className="el-icon" aria-hidden />
              <span className="el-name">{name}</span>
              <span className="el-tag">{node.tag}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
