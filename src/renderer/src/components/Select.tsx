import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconChevron } from "../icons";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** A quieter second line under the label. */
  detail?: string;
  disabled?: boolean;
}

/** Where the popup goes: under the button, or above it when the window has no room below. */
export function popupPlacement(
  button: { top: number; bottom: number; left: number; width: number },
  popupHeight: number,
  viewportHeight: number,
  gap = 4,
): { top: number; left: number; minWidth: number; above: boolean } {
  const below = viewportHeight - button.bottom - gap;
  const above = popupHeight > below && button.top - gap > below;
  return {
    top: above ? Math.max(gap, button.top - gap - popupHeight) : button.bottom + gap,
    left: button.left,
    minWidth: button.width,
    above,
  };
}

/** A Select popup is open: a sheet's own Escape handler leaves Escape to it. */
export function selectPopupOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(".select-popup") !== null;
}

/** The next enabled option index from `from`, stepping by `step` and wrapping; -1 when none is enabled. */
export function nextEnabled<T extends string | number>(options: SelectOption<T>[], from: number, step: 1 | -1): number {
  for (let n = 1; n <= options.length; n++) {
    const i = (((from + step * n) % options.length) + options.length) % options.length;
    if (!options[i]!.disabled) return i;
  }
  return -1;
}

/**
 * A themed replacement for a native <select>: a button plus a listbox popup.
 * The native popup can't be themed (Windows draws it light in dark mode) or
 * driven by tests, so every pick list in the app uses this.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  disabled,
  id,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange(value: T): void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);

  const close = (focus = true) => {
    setOpen(false);
    setPlace(null);
    if (focus) button.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onChange(o.value);
  };
  const show = () => {
    if (disabled || !options.length) return;
    const at = options.findIndex((o) => o.value === value);
    setActive(at >= 0 && !options[at]!.disabled ? at : nextEnabled(options, -1, 1));
    setOpen(true);
  };

  // Placed after the popup has a size, so it can flip above the button.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    setPlace(popupPlacement(button.current.getBoundingClientRect(), list.current.offsetHeight, window.innerHeight));
    list.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    // The popup is fixed: any scroll or resize would leave it behind, so it closes.
    const onMove = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => nextEnabled(options, i, 1));
    else if (e.key === "ArrowUp") setActive((i) => nextEnabled(options, i, -1));
    else if (e.key === "Home") setActive(nextEnabled(options, -1, 1));
    else if (e.key === "End") setActive(nextEnabled(options, 0, -1));
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else if (e.key === "Escape") close();
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1) {
      // Type-ahead: the next option whose label starts with the key.
      const k = e.key.toLowerCase();
      for (let n = 1; n <= options.length; n++) {
        const i = (active + n) % options.length;
        if (!options[i]!.disabled && options[i]!.label.toLowerCase().startsWith(k)) {
          setActive(i);
          break;
        }
      }
    } else return;
    // Handled here, so the window's own shortcuts (Esc closes a sheet) don't also fire.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        className={`select-button${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="select-value">{current?.label ?? ""}</span>
        <IconChevron open size={12} />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          className="select-popup"
          // Invisible (not visibility:hidden, which can't take focus) until it's placed.
          style={place ? { top: place.top, left: place.left, minWidth: place.minWidth } : { opacity: 0, top: 0, left: 0 }}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`select-option${i === active ? " active" : ""}${o.value === value ? " on" : ""}`}
              onMouseMove={() => !o.disabled && i !== active && setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              <span className="select-option-label">{o.label}</span>
              {o.detail && <span className="select-option-detail">{o.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
