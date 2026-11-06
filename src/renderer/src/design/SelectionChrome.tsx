import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowUp, Diamond, Plus, Search } from "lucide-react";
import type { FrameRect } from "./frame";
import type { ActionId } from "./ElementBar";
import { menuStep } from "./StudioBar";
import { groupParts, type KitPart } from "./kit-parts";

/** The six clear directions first; the rest wait behind More. `Custom` asks for words instead. */
export const VARIANT_DIRECTIONS: { id: ActionId; label: string }[] = [
  { id: "polish", label: "Polish" },
  { id: "bolder", label: "Bolder" },
  { id: "quieter", label: "Calmer" },
  { id: "colorize", label: "Restyle" },
  { id: "layout", label: "Rearrange" },
];
export const MORE_DIRECTIONS: { id: ActionId; label: string }[] = [
  { id: "distill", label: "Distill" },
  { id: "typeset", label: "Typeset" },
  { id: "adapt", label: "Adapt" },
  { id: "animate", label: "Animate" },
  { id: "delight", label: "Delight" },
  { id: "overdrive", label: "Overdrive" },
];

/** The badge sits on the element's top edge, inside the view: above it when there's room, else just inside. */
export function placeBadge(el: FrameRect, view: FrameRect, height = 20, tools = { right: 0, bottom: 0 }): { left: number; top: number } {
  const above = el.y - height;
  const top = above >= view.y ? above : Math.min(Math.max(view.y, el.y), view.y + view.height - height);
  const left = Math.max(view.x, Math.min(el.x, view.x + view.width - 60));
  // The tools float over the stage's top-left corner, and would take the badge's clicks.
  return { left: top < tools.bottom && left < tools.right ? tools.right + 4 : left, top };
}

/** Where the 4 edge handles sit: the middle of each side, in the stage's coordinates. */
export function handlePoints(el: FrameRect): { id: "n" | "e" | "s" | "w"; x: number; y: number }[] {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  return [
    { id: "n", x: cx, y: el.y },
    { id: "e", x: el.x + el.width, y: cy },
    { id: "s", x: cx, y: el.y + el.height },
    { id: "w", x: el.x, y: cy },
  ];
}

/** The selection on the canvas: a name tag (its diamond swaps) and the edge handles. Everything else is in the Actions menu and the Composer. */
export function SelectionChrome({ el, view, label, canSwap, onSwap }: { el: FrameRect; view: FrameRect; label: string; canSwap: boolean; onSwap: () => void }) {
  // Where the V, D and C tools end, with the comments chip when it's there.
  const row = document.querySelector<HTMLElement>(".studio-tool-row");
  const badge = placeBadge(el, view, 20, row ? { right: row.offsetLeft + row.offsetWidth, bottom: row.offsetTop + row.offsetHeight } : undefined);
  const inView = (x: number, y: number) => x >= view.x && x <= view.x + view.width && y >= view.y && y <= view.y + view.height;
  return (
    <>
      {handlePoints(el)
        .filter((h) => inView(h.x, h.y))
        .map((h) => (
          <span key={h.id} className={`studio-handle studio-handle-${h.id}`} style={{ left: h.x, top: h.y }} aria-hidden />
        ))}
      <div className="studio-badge" style={{ left: badge.left, top: badge.top }}>
        <span className="studio-badge-name" title={label}>
          {label}
        </span>
        {canSwap && (
          <button className="studio-badge-swap" aria-label={`Swap ${label}`} title="Swap component (⌘S)" onClick={onSwap}>
            <Diamond size={10} strokeWidth={2} aria-hidden />
          </button>
        )}
      </div>
    </>
  );
}

/** The hairline and `+` at a gap between two blocks, drawn at a fixed size whatever the page's scale. */
export function SeamButton({ rect, position, onOpen }: { rect: FrameRect; position: "before" | "after"; onOpen: () => void }) {
  const horizontal = rect.width >= rect.height;
  return (
    <div className="studio-seam" style={{ left: rect.x, top: rect.y, width: horizontal ? rect.width : 1, height: horizontal ? 1 : rect.height }}>
      <button className="studio-seam-add" aria-label={position === "before" ? "Add above" : "Add below"} title={position === "before" ? "Add above" : "Add below"} onClick={onOpen}>
        <Plus size={14} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

/** A search box over the kit's parts, grouped by category, with arrow keys. Shared by Swap and the seam palette. */
function PartList({ parts, placeholder, exclude, empty, onPick, onEscape }: { parts: KitPart[]; placeholder: string; exclude?: string; empty: string; onPick: (part: KitPart) => void; onEscape: () => void }) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const groups = useMemo(() => groupParts(parts, query, exclude), [parts, query, exclude]);
  const flat = groups.flatMap((g) => g.parts);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);
  return (
    <>
      <label className="studio-search">
        <Search size={14} strokeWidth={1.75} aria-hidden />
        <input
          autoFocus
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const next = menuStep(at, flat.length, e.key);
            if (next !== null && e.key.startsWith("Arrow")) {
              e.preventDefault();
              setAt(next);
            } else if (e.key === "Enter" && flat[at]) {
              e.preventDefault();
              onPick(flat[at]!);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onEscape();
            }
          }}
        />
      </label>
      <div className="studio-part-list" role="listbox" aria-label="Components" ref={list}>
        {flat.length === 0 && <p className="studio-part-empty">{empty}</p>}
        {groups.map((g) => (
          <div key={g.category} role="group" aria-label={g.category}>
            <div className="studio-menu-head">{g.category}</div>
            {g.parts.map((p) => (
              <button key={p.ui} role="option" aria-selected={flat[at] === p} className={flat[at] === p ? "on" : ""} onMouseEnter={() => setAt(flat.indexOf(p))} onClick={() => onPick(p)}>
                {p.name}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** Keeps a popover inside the stage, next to what opened it. */
function usePopoverPlace(at: { x: number; y: number }, bounds: FrameRect) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const pad = 8;
    const left = Math.max(bounds.x + pad, Math.min(at.x, bounds.x + bounds.width - el.offsetWidth - pad));
    const top = Math.max(bounds.y + pad, Math.min(at.y, bounds.y + bounds.height - el.offsetHeight - pad));
    setPlace({ left, top });
  }, [at.x, at.y, bounds.x, bounds.y, bounds.width, bounds.height]);
  // Once placed: it starts hidden so it can be measured, and a hidden field can't take the focus.
  const placed = place !== null;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>("input")?.focus();
  }, [placed]);
  // A short stage shrinks it, and its list scrolls.
  const maxHeight = Math.min(420, Math.max(120, bounds.height - 16));
  const style: CSSProperties = place ? { ...place, maxHeight } : { left: 0, top: 0, maxHeight, visibility: "hidden" };
  return { box, style };
}

/** Closes a popover on a click anywhere else. */
function useClickAway(box: React.RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [box]);
}

/** `Swap Button for…`: any part of the kit, with a warning about the props the swap would drop. */
export function SwapPopover({ at, bounds, name, parts, ui, warn, onSwap, onClose }: { at: { x: number; y: number }; bounds: FrameRect; name: string; parts: KitPart[]; ui: string | undefined; warn: (to: KitPart) => string | null; onSwap: (to: KitPart) => void; onClose: () => void }) {
  const { box, style } = usePopoverPlace(at, bounds);
  useClickAway(box, onClose);
  const [hover, setHover] = useState<KitPart | null>(null);
  const note = hover ? warn(hover) : null;
  return (
    <div className="studio-popover" ref={box} style={style} role="dialog" aria-label={`Swap ${name}`} onMouseOver={(e) => setHover(parts.find((p) => p.name === (e.target as HTMLElement).textContent && (e.target as HTMLElement).getAttribute("role") === "option") ?? hover)}>
      <PartList parts={parts} placeholder={`Swap ${name} for…`} exclude={ui} empty="Nothing in this kit matches." onPick={onSwap} onEscape={onClose} />
      {note && <p className="studio-popover-note">{note}</p>}
    </div>
  );
}

export type SeamPosition = "before" | "after" | "inside";

/** The seam palette: where (Before, After, Inside), then a part of the kit, or words for the agent. */
export function SeamPalette({
  at,
  bounds,
  anchorName,
  position,
  parts,
  busy,
  onInsert,
  onAsk,
  onClose,
}: {
  at: { x: number; y: number };
  bounds: FrameRect;
  anchorName: string;
  position: SeamPosition;
  parts: KitPart[];
  busy: string | null;
  onInsert: (part: KitPart, position: SeamPosition) => void;
  onAsk: (text: string, position: "before" | "after") => void;
  onClose: () => void;
}) {
  const { box, style } = usePopoverPlace(at, bounds);
  useClickAway(box, onClose);
  const [where, setWhere] = useState<SeamPosition>(position);
  const [words, setWords] = useState("");
  const side: "before" | "after" = where === "before" ? "before" : "after";
  return (
    <div className="studio-popover" ref={box} style={style} role="dialog" aria-label={`Insert near ${anchorName}`}>
      <div className="studio-seam-head">
        <div className="segmented" role="group" aria-label="Where">
          {(["before", "after", "inside"] as SeamPosition[]).map((p) => (
            <button key={p} aria-pressed={where === p} className={where === p ? "on" : ""} onClick={() => setWhere(p)}>
              {p === "before" ? "Before" : p === "after" ? "After" : "Inside"}
            </button>
          ))}
        </div>
        <span className="studio-seam-target" title={anchorName}>
          {anchorName}
        </span>
      </div>
      {parts.length > 0 && <PartList parts={parts} placeholder="Search components…" empty="Nothing in this kit matches." onPick={(p) => onInsert(p, where)} onEscape={onClose} />}
      <form
        className="studio-seam-ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (words.trim() && !busy) onAsk(words, side);
        }}
      >
        <input
          className="studio-pill-input"
          aria-label="Ask the agent for something else"
          placeholder={parts.length ? "Or ask for something else…" : "What goes here?"}
          value={words}
          maxLength={2000}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <button type="submit" className="icon-button" aria-label="Make 3 options for this spot" title={busy ?? "Make 3 options for this spot"} disabled={!words.trim() || busy !== null}>
          <ArrowUp size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </form>
    </div>
  );
}

export type ActionItem = { id: string; label: string; group: string; shortcut?: string; disabled?: boolean; run: () => void };

/** The Actions menu (right-click or `/`): searchable; what matches nothing goes to the agent as a request. */
export function ActionsMenu({ at, bounds, title, items, onAsk, onClose }: { at: { x: number; y: number }; bounds: FrameRect; title: string; items: ActionItem[]; onAsk: (text: string) => void; onClose: () => void }) {
  const { box, style } = usePopoverPlace(at, bounds);
  useClickAway(box, onClose);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.group.toLowerCase().includes(q));
  const live = shown.filter((i) => !i.disabled);
  useEffect(() => setIndex(0), [query]);
  const run = (item: ActionItem) => {
    onClose();
    item.run();
  };
  let lastGroup = "";
  return (
    <div className="studio-popover" ref={box} style={style} role="menu" aria-label={`Actions: ${title}`}>
      <label className="studio-search">
        <Search size={14} strokeWidth={1.75} aria-hidden />
        <input
          autoFocus
          aria-label="Search actions, or type a change"
          placeholder="Search actions, or type a change…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const next = menuStep(index, live.length, e.key);
            if (next !== null && e.key.startsWith("Arrow")) {
              e.preventDefault();
              setIndex(next);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (live[index]) run(live[index]!);
              else if (query.trim()) {
                onClose();
                onAsk(query);
              }
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
      </label>
      <div className="studio-part-list">
        {shown.length === 0 && <p className="studio-part-empty">Press Enter to ask the agent.</p>}
        {shown.map((item) => {
          const head = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.id}>
              {head && <div className="studio-menu-head">{head}</div>}
              <button role="menuitem" disabled={item.disabled} className={live[index] === item ? "on" : ""} onMouseEnter={() => !item.disabled && setIndex(live.indexOf(item))} onClick={() => run(item)}>
                <span className="artifact-menu-label">{item.label}</span>
                {item.shortcut && <kbd className="studio-menu-key">{item.shortcut}</kbd>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
