import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize2, Play } from "lucide-react";
import { BOARD_HEADER, BOARD_TITLE_BAND, boardLayout, boardSections, clampZoom, dotSpacing, fitBoard, zoomAt, type BoardFrame, type BoardPage, flowPath } from "./board-layout";
import { Beam } from "../components/Beam";
import { affectedPages } from "../store";
import type { DesignEntry } from "../../../shared/types";

/** The margin around the stage within which a frame's iframe is rendered (others are placeholders). */
const LAZY_MARGIN = 400;
/** The on-screen frame width below which its header shows only the label. */
const HEAD_BUTTONS_MIN = 120;

interface View {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The next per-artboard reload counts after a change: each page the change affects gets one more, so its frame
 * remounts while the others stay put. Unknown paths affect every page.
 */
export function bumpArtboardCounts(counts: ReadonlyMap<string, number>, pages: string[], changes: { paths: string[] | null } | undefined): Map<string, number> {
  const next = new Map(counts);
  const affected = affectedPages(changes?.paths ?? undefined, pages);
  for (const rel of affected === "all" ? pages : affected) next.set(rel, (next.get(rel) ?? 0) + 1);
  return next;
}

/**
 * The board: every page of a design at once, laid out as labelled artboards on one pannable, zoomable canvas. Frames
 * off screen stay as placeholders, so a design with many pages doesn't pay for them all.
 */
export function Board({
  pages,
  links,
  flow,
  changes,
  manual,
  labelOf,
  writing,
  onFocus,
  onPresent,
}: {
  pages: DesignEntry["pages"];
  links?: { from: string; to: string }[];
  flow: boolean;
  /** The thread's latest design change (counter + changed paths), so only the artboards it affects reload. */
  changes?: { n: number; paths: string[] | null };
  /** The canvas's manual Reload counter: it remounts every artboard. */
  manual: number;
  /** An artboard's label (`Page · Style`); the page's own label without it. */
  labelOf?: (page: BoardPage) => string;
  /** Pages the running agent is writing right now: their frames wear the running beam. */
  writing?: ReadonlySet<string>;
  onFocus: (rel: string) => void;
  onPresent: (rel: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [space, setSpace] = useState(false);
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);

  // Per-artboard reload counts: a change increments only the pages it affects, so their frames remount while the
  // rest stay. `manual` sits in the key too, so a manual Reload still remounts them all.
  const counts = useRef<Map<string, number>>(new Map());
  const appliedN = useRef(0);
  const rels = pages.map((p) => p.rel);
  const n = changes?.n ?? 0;
  if (n !== appliedN.current) {
    // More than one change since the last render: the earlier ones' paths are gone, so reload every artboard.
    const missed = n - appliedN.current > 1;
    appliedN.current = n;
    counts.current = bumpArtboardCounts(counts.current, rels, missed ? { paths: null } : changes);
  }

  const sections = boardSections(pages);
  // Set when the board is fitted, so section labels have room at that zoom.
  const [sectionGap, setSectionGap] = useState(120);
  const board = boardLayout(sections, 48, sectionGap);

  // Where each frame sits on the board (frame x/y + its section origin), for the flow arrows.
  const places = new Map<string, BoardFrame>();
  for (const s of board.sections) for (const f of s.frames) places.set(f.page.rel, { ...f, x: s.x + f.x, y: s.y + f.y });
  // A link is drawn only when both of its pages are on the board; the arrow runs right-to-left, or bottom-to-top
  // when the target sits left of the source.
  const arrows = (links ?? [])
    .map((l) => ({ from: places.get(l.from), to: places.get(l.to) }))
    .filter((a): a is { from: BoardFrame; to: BoardFrame } => !!a.from && !!a.to && a.from.page.rel !== a.to.page.rel);

  // Measure the stage (CompareFrame does the same).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the whole board on mount, and again when the stage size or the set of pages changes (not on every
  // rewrite of a page, so the agent's edits keep the user's pan and zoom).
  const pageKey = pages.map((p) => p.rel).join("\n");
  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    // Room the canvas's floating tools and prompt bar take at the left and the foot (CSS sets them where they float).
    const css = getComputedStyle(el);
    const left = parseFloat(css.getPropertyValue("--board-inset-left")) || 0;
    const bottom = parseFloat(css.getPropertyValue("--board-inset-bottom")) || 0;
    const fitted = fitBoard(sections, { width: Math.max(1, el.clientWidth - left), height: Math.max(1, el.clientHeight - bottom) });
    setSectionGap(fitted.sectionGap);
    setView({ ...fitted.view, x: fitted.view.x + left });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sections` follows `pageKey`
  }, [pageKey]);
  useEffect(() => {
    fit();
  }, [fit]);
  useEffect(() => {
    if (stage.width > 0 && stage.height > 0) fit();
  }, [stage.width, stage.height]);

  // Space held turns a left-drag on the background into a pan, like a design tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setSpace(e.type === "keydown");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, []);

  // Wheel: ctrl/meta zooms around the cursor; otherwise it pans. Non-passive so preventDefault works.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top));
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("design-board-content");
    const middle = e.button === 1;
    const leftPan = e.button === 0 && (space || onBackground);
    if (!middle && !leftPan) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.viewX + (e.clientX - d.x), y: d.viewY + (e.clientY - d.y) }));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  // What the stage currently shows, in board coordinates, padded so frames just off screen still render.
  const visible = {
    left: -view.x / view.zoom - LAZY_MARGIN,
    top: -view.y / view.zoom - LAZY_MARGIN,
    right: (stage.width - view.x) / view.zoom + LAZY_MARGIN,
    bottom: (stage.height - view.y) / view.zoom + LAZY_MARGIN,
  };
  const isVisible = (f: BoardFrame) => f.x < visible.right && f.x + f.width > visible.left && f.y < visible.bottom && f.y + f.height > visible.top;

  const step = (factor: number) => setView((v) => zoomAt(v, factor, stage.width / 2, stage.height / 2));
  // The dotted surface moves and scales with the board, so it reads as one infinite canvas.
  const dots = dotSpacing(view.zoom);
  const surface = { "--dot-size": `${dots}px`, "--dot-x": `${view.x}px`, "--dot-y": `${view.y}px` } as CSSProperties;

  return (
    <div className="design-board" ref={stageRef} style={surface} role="region" aria-label="Board: every page" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div className="design-board-content" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}>
        {flow && arrows.length > 0 && (
          <svg
            className="design-board-flow"
            width={board.width}
            height={board.height}
            viewBox={`0 0 ${board.width} ${board.height}`}
            aria-hidden
          >
            <defs>
              <marker id="design-board-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {arrows.map((a) => {
              const d = flowPath(a.from, a.to, view.zoom);
              return <path key={`${a.from.page.rel}->${a.to.page.rel}`} d={d} fill="none" strokeWidth={2 / view.zoom} markerEnd="url(#design-board-arrowhead)" />;
            })}
          </svg>
        )}
        {board.sections.map((section) => (
          <div key={section.title}>
            {/* Titles and frame headers keep their on-screen size at any zoom (scaled by 1/zoom), like a design tool. */}
            <div
              className="design-board-section-title"
              style={{ left: section.x, top: section.y + BOARD_TITLE_BAND + BOARD_HEADER, transform: `scale(${1 / view.zoom}) translateY(calc(-100% - ${BOARD_HEADER + 4}px))` }}
            >
              {section.title}
            </div>
            {section.frames.map((frame) => {
              const x = section.x + frame.x;
              const y = section.y + frame.y;
              const shown = isVisible({ ...frame, x, y });
              const label = labelOf ? labelOf(frame.page) : frame.page.label;
              const busy = writing?.has(frame.page.rel) ?? false;
              return (
                <div key={frame.page.rel} className="design-board-frame-wrap" style={{ left: x, top: y, width: frame.width }} role="group" aria-label={label} aria-busy={busy || undefined} onDoubleClick={() => onFocus(frame.page.rel)}>
                  <div className="design-board-frame-head" style={{ width: frame.width * view.zoom, transform: `scale(${1 / view.zoom}) translateY(-100%)` }}>
                    <span className="design-board-frame-label" title={frame.page.rel}>
                      {label}
                    </span>
                    {/* Too narrow on screen for the buttons: the label alone (double-click the frame opens it). */}
                    {frame.width * view.zoom >= HEAD_BUTTONS_MIN && (
                      <>
                        <button className="button ghost" aria-label={`Present ${label}`} onClick={() => onPresent(frame.page.rel)}>
                          <Play size={16} strokeWidth={1.75} aria-hidden />
                        </button>
                        <button className="button ghost" aria-label={`Open ${label}`} onClick={() => onFocus(frame.page.rel)}>
                          <Maximize2 size={16} strokeWidth={1.75} aria-hidden />
                        </button>
                      </>
                    )}
                  </div>
                  <div className={`design-board-frame${busy ? " writing" : ""}`} style={busy ? ({ "--z": view.zoom } as CSSProperties) : undefined}>
                    {/* The agent is writing this page: it wears the send button's beam, kept a steady size on screen. */}
                    {busy && <Beam edge={Math.round(28 / view.zoom)} />}
                    {shown ? (
                      <iframe
                        key={`${frame.page.rel}-${counts.current.get(frame.page.rel) ?? 0}-${manual}`}
                        className="design-frame"
                        sandbox="allow-scripts"
                        src={frame.page.url}
                        title={`Design: ${frame.page.rel}`}
                        style={{ width: frame.width, height: frame.height }}
                        // An artboard is a screen, not a window: hide the page's scrollbars as the device frame does.
                        onLoad={(e) => e.currentTarget.contentWindow?.postMessage({ source: "cubiq-canvas", type: "device-chrome", on: true }, "*")}
                      />
                    ) : (
                      <div className="design-board-placeholder" style={{ width: frame.width, height: frame.height }}>
                        {label}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="design-board-zoom">
        <button className="icon-button" aria-label="Zoom out" onClick={() => step(1 / 1.2)}>
          −
        </button>
        <span className="design-board-zoom-value">{Math.round(clampZoom(view.zoom) * 100)}%</span>
        <button className="icon-button" aria-label="Zoom in" onClick={() => step(1.2)}>
          +
        </button>
        <button className="button ghost" onClick={fit}>
          Fit
        </button>
      </div>
    </div>
  );
}
