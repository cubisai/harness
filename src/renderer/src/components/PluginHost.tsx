import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Minus } from "lucide-react";
import type { AppInfo } from "../../../shared/types";
import { IconClose, IconRefresh } from "../icons";
import { create } from "zustand";
import { useStore } from "../store";
import { AppFrame, appIcon } from "./AppFrame";

/** The title strip above a floating widget's frame, in px (the manifest's size is the frame's). */
const STRIP = 30;
const EDGE = 12;
const DEFAULT_SIZE = { width: 280, height: 200 };
const KEY_STEP = 16;
const PLACE_PREFIX = "cubiq.floating.place.";

interface Place {
  x: number;
  y: number;
  collapsed: boolean;
}

const sizeOf = (app: AppInfo) => app.size ?? DEFAULT_SIZE;

function readPlace(key: string): Place | null {
  try {
    const v = JSON.parse(localStorage.getItem(PLACE_PREFIX + key) ?? "null") as Partial<Place> | null;
    if (!v || typeof v.x !== "number" || typeof v.y !== "number" || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
    return { x: v.x, y: v.y, collapsed: v.collapsed === true };
  } catch {
    return null;
  }
}

function writePlace(key: string, place: Place): void {
  try {
    localStorage.setItem(PLACE_PREFIX + key, JSON.stringify(place));
  } catch {
    // Not remembered: it opens at its default spot next time.
  }
}

/** Keep the whole widget (or at least its strip) inside the window. */
export function clampPlace(p: { x: number; y: number }, box: { width: number; height: number }, view: { width: number; height: number }): { x: number; y: number } {
  const x = Math.min(Math.max(EDGE, p.x), Math.max(EDGE, view.width - box.width - EDGE));
  const y = Math.min(Math.max(EDGE, p.y), Math.max(EDGE, view.height - box.height - EDGE));
  return { x: Math.round(x), y: Math.round(y) };
}

const viewSize = () => ({ width: window.innerWidth, height: window.innerHeight });

/** Below the 46px header; widgets the user hasn't moved sit top right, stacked, clear of the composer at the bottom. */
const HEADER = 46;

/** Where a widget the user never moved sits: the top-right corner, the i-th one a strip lower. */
export function defaultPlace(index: number, box: { width: number; height: number }, view: { width: number; height: number }): { x: number; y: number } {
  return clampPlace({ x: view.width - box.width - EDGE - 4, y: HEADER + EDGE + index * (STRIP + 8) }, box, view);
}

/** The top bar's tray, where a minimised widget docks as a chip (like a macOS menu-bar extra). */
const useTray = create<{ el: HTMLElement | null }>(() => ({ el: null }));
export const setPluginTray = (el: HTMLElement | null): void => {
  if (useTray.getState().el !== el) useTray.setState({ el });
};

/** The centred plugin modal: one app at a time, Escape or Close to leave. */
export function PluginModal() {
  const app = useStore((s) => s.appOpen);
  if (!app) return null;
  return <PluginModalSheet key={app.key} app={app} />;
}

function PluginModalSheet({ app }: { app: AppInfo }) {
  const close = useStore((s) => s.closeApp);
  const sheetRef = useRef<HTMLDivElement>(null);
  const Icon = appIcon(app.icon);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLElement>(".plugin-modal-close")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        useStore.getState().closeApp();
        return;
      }
      if (e.key === "Tab") {
        const controls = [...(sheetRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), iframe") ?? [])].filter((el) => el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop plugin-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={sheetRef} className="plugin-modal" role="dialog" aria-modal="true" aria-label={app.title}>
        <AppFrame
          app={app}
          head={({ logsButton, reload }) => (
            <div className="plugin-head">
              <span className="plugin-head-icon" aria-hidden>
                <Icon size={14} strokeWidth={1.75} />
              </span>
              <span className="plugin-head-title" title={app.description}>
                {app.title}
              </span>
              {app.scope === "draft" && <span className="proposal-chip">Draft</span>}
              <span className="grow" />
              {logsButton}
              <button type="button" className="icon-button" title="Reload" aria-label="Reload" onClick={reload}>
                <IconRefresh />
              </button>
              <button type="button" className="icon-button plugin-modal-close" title="Close" aria-label={`Close ${app.title}`} onClick={close}>
                <IconClose />
              </button>
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** Floating widgets: enabled installed apps with placement "floating" (unless closed), plus Creator draft previews. */
export function FloatingPlugins() {
  const apps = useStore((s) => s.apps);
  const hidden = useStore((s) => s.floatingHidden);
  const drafts = useStore((s) => s.floatingDrafts);
  const shown = useMemo(() => {
    const installed = apps.filter((a) => a.placement === "floating" && a.enabled !== false && !a.error && !hidden.includes(a.key));
    return [...installed, ...drafts.filter((d) => !installed.some((a) => a.key === d.key))];
  }, [apps, hidden, drafts]);
  const [order, setOrder] = useState<string[]>([]);
  const focus = useStore((s) => s.floatingFocus);
  useEffect(() => {
    if (focus) setOrder((o) => [...o.filter((k) => k !== focus.key), focus.key]);
  }, [focus]);
  if (!shown.length) return null;
  return (
    <div className="floating-layer">
      {shown.map((app, i) => (
        <FloatingWidget key={app.key} app={app} index={i} z={order.indexOf(app.key) + 1} onFront={() => setOrder((o) => [...o.filter((k) => k !== app.key), app.key])} />
      ))}
    </div>
  );
}

function FloatingWidget({ app, index, z, onFront }: { app: AppInfo; index: number; z: number; onFront(): void }) {
  const closeFloating = useStore((s) => s.closeFloating);
  const focus = useStore((s) => (s.floatingFocus?.key === app.key ? s.floatingFocus.n : 0));
  const size = sizeOf(app);
  const [pill, setPill] = useState("");
  // Never moved: it follows the window's top-right corner (the window may still be sizing up at first paint).
  const anchored = useRef(false);
  const [place, setPlace] = useState<Place>(() => {
    const saved = readPlace(app.key);
    const box = { width: size.width + 2, height: size.height + STRIP + 2 };
    anchored.current = !saved;
    return saved ? { ...clampPlace(saved, box, viewSize()), collapsed: saved.collapsed } : { ...defaultPlace(index, box, viewSize()), collapsed: false };
  });
  const placeRef = useRef(place);
  placeRef.current = place;
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean } | null>(null);
  const Icon = appIcon(app.icon);

  const box = () => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { width: r.width, height: r.height } : { width: size.width + 2, height: size.height + STRIP + 2 };
  };
  const commit = (next: Place) => {
    anchored.current = false;
    setPlace(next);
    writePlace(app.key, next);
  };

  // Opened again from the sidebar: expand and come forward.
  useEffect(() => {
    if (!focus) return;
    if (placeRef.current.collapsed) commit({ ...placeRef.current, collapsed: false });
    onFront();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // A smaller window (or an expanded widget) must still fit.
  useEffect(() => {
    const fit = () => {
      const p = placeRef.current;
      const next = anchored.current ? defaultPlace(index, box(), viewSize()) : clampPlace(p, box(), viewSize());
      if (next.x !== p.x || next.y !== p.y) setPlace({ ...p, ...next });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.collapsed]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".floating-action")) return;
    onFront();
    drag.current = { id: e.pointerId, dx: e.clientX - place.x, dy: e.clientY - place.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const next = clampPlace({ x: e.clientX - d.dx, y: e.clientY - d.dy }, box(), viewSize());
    if (!d.moved && Math.abs(next.x - place.x) + Math.abs(next.y - place.y) < 3) return;
    d.moved = true;
    setPlace((p) => ({ ...p, ...next }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      anchored.current = false;
      writePlace(app.key, placeRef.current);
    }
    else if (placeRef.current.collapsed) commit({ ...placeRef.current, collapsed: false });
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (delta) {
      e.preventDefault();
      commit({ ...place, ...clampPlace({ x: place.x + delta[0]!, y: place.y + delta[1]! }, box(), viewSize()) });
    } else if (place.collapsed && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      commit({ ...place, collapsed: false });
    }
  };

  const tray = useTray((t) => t.el);
  // Minimised with a top bar to dock in: the widget (and its running frame) stays mounted but out of sight.
  const docked = place.collapsed && tray !== null;
  const label = place.collapsed ? pill || app.title : app.title;
  return (
    <div
      ref={rootRef}
      className={`floating-plugin${place.collapsed ? " collapsed" : ""}${docked ? " docked" : ""}`}
      aria-hidden={docked || undefined}
      style={{ left: place.x, top: place.y, zIndex: z, ...(place.collapsed ? {} : { width: size.width + 2 }), "--frame-h": `${size.height}px` } as CSSProperties}
      role="dialog"
      aria-label={app.title}
      onPointerDownCapture={onFront}
    >
      <AppFrame
        app={app}
        onPill={setPill}
        head={({ logsButton }) => (
          <div
            className="floating-strip"
            tabIndex={0}
            role="button"
            aria-label={place.collapsed ? `${app.title}: expand, or move with the arrow keys` : `Move ${app.title} with the arrow keys`}
            title={place.collapsed ? "Click to expand; drag to move" : "Drag to move"}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <span className="floating-icon" aria-hidden>
              <Icon size={13} strokeWidth={1.75} />
            </span>
            <span className={`floating-title${place.collapsed && pill ? " pill-text" : ""}`}>{label}</span>
            {app.scope === "draft" && !place.collapsed && <span className="proposal-chip">Draft</span>}
            {!place.collapsed && logsButton}
            {!place.collapsed && (
              <button type="button" className="icon-button floating-action" title="Minimise" aria-label={`Minimise ${app.title}`} onClick={() => commit({ ...place, collapsed: true })}>
                <Minus size={14} strokeWidth={1.75} aria-hidden />
              </button>
            )}
            <button type="button" className="icon-button floating-action" title="Close" aria-label={`Close ${app.title}`} onClick={() => closeFloating(app.key)}>
              <IconClose />
            </button>
          </div>
        )}
      />
      {docked &&
        createPortal(
          <button
            type="button"
            className="plugin-tray-chip"
            title={`${app.title}: click to open`}
            aria-label={`Open ${app.title}${pill ? ` (${pill})` : ""}`}
            onClick={() => {
              commit({ ...place, collapsed: false });
              onFront();
            }}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden />
            {pill && <span className="plugin-tray-text">{pill}</span>}
          </button>,
          tray,
        )}
    </div>
  );
}
