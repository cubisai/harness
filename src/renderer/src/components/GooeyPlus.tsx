import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";

export interface GooeyItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect(): void;
}

/** Button size and the gap between the + and its items, in px. */
const SIZE = 28;
const STEP = 34;

/**
 * Per-property transition delays for item `i` of `n`: a 40 ms stagger outward on
 * open (icons fade in once their blob has pulled away), inward on close (icons go at once).
 */
export function gooeyDelays(i: number, n: number, open: boolean): { blob: string; item: string } {
  const stagger = (open ? i : n - 1 - i) * 40;
  return open ? { blob: `${stagger}ms, 0ms`, item: `${stagger}ms, ${stagger + 220}ms` } : { blob: `${stagger}ms, ${stagger + 200}ms`, item: `${stagger}ms, 0ms` };
}

/** Where item `i` of an open menu sits, relative to the +: a row along the bar, to its right. */
export function gooeyOffset(i: number): { x: number; y: number } {
  return { x: (i + 1) * STEP, y: 0 };
}

/**
 * The composer's + (after libraries.dev Gooey): opening it splits round buttons
 * out of the + that merge like liquid while they travel. The shapes are drawn
 * in an SVG under the real buttons and run through a goo filter (blur, then a
 * hard alpha threshold), so the buttons' icons stay crisp. The motion setting
 * gates the travel; without it the items just appear.
 */
export function GooeyPlus({ items, title = "Add context" }: { items: GooeyItem[]; title?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const filterId = `goo-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (item: GooeyItem) => {
    setOpen(false);
    item.onSelect();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>(".goo-item") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" && open) {
      setOpen(false);
      box.current?.querySelector<HTMLButtonElement>(".goo-main")?.focus();
    } else if (open && (e.key === "ArrowRight" || e.key === "ArrowDown")) buttons[(at + 1) % buttons.length]?.focus();
    else if (open && (e.key === "ArrowLeft" || e.key === "ArrowUp")) buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className={`goo${open ? " open" : ""}`} ref={box} onKeyDown={onKey}>
      <svg className="goo-shapes" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId} filterUnits="userSpaceOnUse" x={-30} y={-30} width={STEP * items.length + 90} height={90} colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
        <g filter={`url(#${filterId})`}>
          <circle className="goo-blob goo-blob-main" cx={SIZE / 2} cy={SIZE / 2} r={SIZE / 2} style={{ transitionDelay: open ? "0ms, 0ms" : `0ms, ${(items.length - 1) * 40 + 260}ms` }} />
          {items.map((item, i) => {
            const { x, y } = gooeyOffset(i);
            return (
              <circle
                key={item.id}
                className="goo-blob"
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={SIZE / 2}
                style={{ transform: open ? `translate(${x}px, ${y}px)` : undefined, transitionDelay: gooeyDelays(i, items.length, open).blob }}
              />
            );
          })}
        </g>
      </svg>
      <button
        className="chip-button icon goo-main"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          setOpen((o) => !o);
          // Opened from the keyboard (no pointer, detail 0): focus the first item.
          if (!open && e.detail === 0) requestAnimationFrame(() => first.current?.focus({ preventScroll: true }));
        }}
      >
        <Plus size={15} />
      </button>
      <div className="goo-items" role="menu" aria-label={title} aria-hidden={!open}>
        {items.map((item, i) => {
          const { x, y } = gooeyOffset(i);
          return (
            <button
              key={item.id}
              ref={i === 0 ? first : undefined}
              role="menuitem"
              className="goo-item"
              title={item.label}
              aria-label={item.label}
              tabIndex={open ? 0 : -1}
              style={{ transform: open ? `translate(${x}px, ${y}px)` : undefined, transitionDelay: gooeyDelays(i, items.length, open).item }}
              onClick={() => pick(item)}
            >
              {item.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}
