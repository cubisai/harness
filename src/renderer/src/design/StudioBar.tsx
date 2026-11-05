import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Download, Ellipsis, Monitor, PanelLeft, PanelRight, Smartphone } from "lucide-react";
import { ZOOMS, type Viewport, type Zoom } from "./frame";

export type StudioView = "design" | "preview" | "code" | "system";

/** The four things the canvas can show, in the top bar's order. */
export const STUDIO_VIEWS: { value: StudioView; label: string; hint: string }[] = [
  { value: "design", label: "Design", hint: "Click to select, double-click to edit text" },
  { value: "preview", label: "Preview", hint: "Use the page as a visitor would: links, tabs and dialogs work" },
  { value: "code", label: "Code", hint: "This page's source, its tokens and its components" },
  { value: "system", label: "System", hint: "The design system behind this page" },
];

export type StudioMenuItem =
  | { kind: "item"; id: string; label: string; sub?: string; shortcut?: string; checked?: boolean; disabled?: boolean; keepOpen?: boolean; onSelect: () => void }
  | { kind: "sep"; id: string }
  | { kind: "head"; id: string; label: string };

/** The next item to focus for an arrow key in a menu, wrapping; null for any other key. */
export function menuStep(index: number, count: number, key: string): number | null {
  if (count < 1) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** A button and the menu it opens: closes on a click outside, Esc gives the focus back, arrows move inside it. */
export function StudioMenu({
  label,
  title,
  icon,
  text,
  items,
  align = "right",
  up = false,
  disabled = false,
  className = "icon-button",
}: {
  label: string;
  title: string;
  icon?: ReactNode;
  text?: ReactNode;
  items: StudioMenuItem[];
  align?: "left" | "right";
  /** Opens upward, for a trigger low on the stage. */
  up?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const all = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const next = menuStep(all.indexOf(document.activeElement as HTMLButtonElement), all.length, e.key);
    if (next !== null) {
      e.preventDefault();
      all[next]?.focus();
    }
  };
  return (
    <div className={`artifact-menu-wrap studio-menu${align === "left" ? " left" : ""}${up ? " up" : ""}`} ref={box} onKeyDown={onKey}>
      <button ref={trigger} className={`${className}${open ? " active" : ""}`} aria-label={label} title={title} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        {icon}
        {text}
      </button>
      {open && (
        <div className="artifact-menu design-export-menu" role="menu" aria-label={label}>
          {items.map((it) =>
            it.kind === "sep" ? (
              <div key={it.id} className="design-menu-sep" role="separator" />
            ) : it.kind === "head" ? (
              <div key={it.id} className="studio-menu-head" role="presentation">
                {it.label}
              </div>
            ) : (
              <button
                key={it.id}
                role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={it.checked}
                className={it.checked ? "on" : ""}
                disabled={it.disabled}
                onClick={() => {
                  if (!it.keepOpen) setOpen(false);
                  it.onSelect();
                }}
              >
                <span className="artifact-menu-label">{it.label}</span>
                {it.shortcut ? <kbd className="studio-menu-key">{it.shortcut}</kbd> : it.sub ? <span className="design-export-sub">{it.sub}</span> : null}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** What the viewport chevron offers beyond Desktop and Mobile. */
export function viewportMenu(o: {
  viewport: Viewport;
  zoom: Zoom;
  device: boolean;
  deviceOk: boolean;
  board: { can: boolean; on: boolean; onToggle: () => void };
  flow: { on: boolean; onToggle: () => void } | null;
  onViewport: (v: Viewport) => void;
  onZoom: (z: Zoom) => void;
  onDevice: () => void;
}): StudioMenuItem[] {
  const sized: { value: Viewport; label: string; sub: string }[] = [
    { value: "tablet", label: "Tablet", sub: "768 × 1024" },
    { value: "fit", label: "Fluid width", sub: "The canvas's own size" },
    { value: "slide", label: "Slide", sub: "1920 × 1080" },
  ];
  const items: StudioMenuItem[] = sized.map((s) => ({ kind: "item", id: s.value, label: s.label, sub: s.sub, checked: o.viewport === s.value, onSelect: () => o.onViewport(s.value) }));
  if (o.board.can) items.push({ kind: "sep", id: "s-board" }, { kind: "item", id: "board", label: "Board view", sub: "All pages", checked: o.board.on, onSelect: o.board.onToggle });
  if (o.flow) items.push({ kind: "item", id: "flow", label: "Flow arrows", sub: "Between linked screens", checked: o.flow.on, onSelect: o.flow.onToggle });
  if (o.viewport !== "fit") {
    items.push({ kind: "sep", id: "s-zoom" }, { kind: "head", id: "h-zoom", label: "Zoom" });
    for (const z of ZOOMS) items.push({ kind: "item", id: `z-${z.value}`, label: z.label, checked: o.zoom === z.value, onSelect: () => o.onZoom(z.value) });
  }
  items.push({ kind: "sep", id: "s-device" }, { kind: "item", id: "device", label: "Device frame", checked: o.device, disabled: !o.deviceOk, onSelect: o.onDevice });
  return items;
}

export function StudioBar({
  title,
  page,
  save,
  version,
  hasPage,
  rail,
  view,
  onView,
  viewport,
  onViewport,
  viewportItems,
  customize,
  exportItems,
  exporting,
  moreItems,
}: {
  /** The thread's name, in canvas-first (the main header carries it otherwise). */
  title: string | null;
  page: ReactNode;
  save: ReactNode;
  /** The version pill: only while looking at history. */
  version: ReactNode;
  /** With no page yet the bar keeps only the thread's name and the menu. */
  hasPage: boolean;
  rail: { open: boolean; onToggle: () => void } | null;
  view: StudioView;
  onView: (v: StudioView) => void;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  viewportItems: StudioMenuItem[];
  customize: { open: boolean; disabled: boolean; onToggle: () => void };
  exportItems: StudioMenuItem[];
  exporting: string | null;
  moreItems: StudioMenuItem[];
}) {
  const other = viewport === "desktop" || viewport === "mobile" ? null : viewport === "fit" ? "Fluid" : viewport === "tablet" ? "Tablet" : "Slide";
  return (
    <>
      <div className="studio-left">
        {hasPage && rail && (
          <button className={`icon-button${rail.open ? " active" : ""}`} aria-pressed={rail.open} aria-label="Pages and layers" title={`${rail.open ? "Hide" : "Show"} pages and layers (⌘\\)`} onClick={rail.onToggle}>
            <PanelLeft size={16} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        {title && (
          <span className="studio-title" title={title}>
            {title}
          </span>
        )}
        {title && hasPage && (
          <span className="studio-slash" aria-hidden>
            /
          </span>
        )}
        {hasPage && page}
        {version}
        {hasPage && save}
      </div>
      {hasPage && (
        <div className="studio-center">
          <div className="segmented studio-views" role="tablist" aria-label="View">
            {STUDIO_VIEWS.map((v) => (
              <button key={v.value} role="tab" aria-selected={view === v.value} className={view === v.value ? "on" : ""} title={v.hint} onClick={() => onView(v.value)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="segmented studio-viewports" role="group" aria-label="Viewport">
            <button aria-pressed={viewport === "desktop"} className={viewport === "desktop" ? "on" : ""} aria-label="Desktop" title="Desktop, 1440 wide" onClick={() => onViewport("desktop")}>
              <Monitor size={14} strokeWidth={1.75} aria-hidden />
              <span className="studio-fold">Desktop</span>
            </button>
            <button aria-pressed={viewport === "mobile"} className={viewport === "mobile" ? "on" : ""} aria-label="Mobile" title="Mobile, 390 wide" onClick={() => onViewport("mobile")}>
              <Smartphone size={14} strokeWidth={1.75} aria-hidden />
              <span className="studio-fold">Mobile</span>
            </button>
            <StudioMenu
              label="More sizes and views"
              title="Tablet, fluid width, slide, board, zoom, device frame"
              className={other ? "on" : ""}
              text={
                <>
                  {other && <span className="studio-fold">{other}</span>}
                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
                </>
              }
              items={viewportItems}
            />
          </div>
        </div>
      )}
      <div className="studio-right">
        {hasPage && (
          <>
            <button className={`icon-button${customize.open ? " active" : ""}`} aria-pressed={customize.open} aria-label="Customize" title="Customize: the page's theme, or the selected element" disabled={customize.disabled} onClick={customize.onToggle}>
              <PanelRight size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <StudioMenu
              label="Export"
              title={exporting ? `Exporting ${exporting.toUpperCase()}…` : "Export"}
              className="button ghost studio-export"
              icon={<Download size={14} strokeWidth={1.75} aria-hidden />}
              text={<span className="studio-fold">Export</span>}
              disabled={exporting !== null}
              items={exportItems}
            />
          </>
        )}
        <StudioMenu label="More" title="More" icon={<Ellipsis size={16} strokeWidth={1.75} aria-hidden />} items={moreItems} />
      </div>
    </>
  );
}
