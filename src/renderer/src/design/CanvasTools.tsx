import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { MessageSquarePlus, MousePointer2, Pencil, Redo2, Trash2, Undo2 } from "lucide-react";

export type CanvasTool = "select" | "draw" | "comment";
export type Stroke = { x: number; y: number }[];

const TOOLS: { id: CanvasTool; label: string; key: string; Icon: typeof Pencil }[] = [
  { id: "select", label: "Select", key: "V", Icon: MousePointer2 },
  { id: "draw", label: "Draw", key: "D", Icon: Pencil },
  { id: "comment", label: "Comment", key: "C", Icon: MessageSquarePlus },
];

/** The tool a bare key picks, outside any text field. */
export function toolForKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey?: boolean }): CanvasTool | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const k = e.key.toLowerCase();
  return k === "v" ? "select" : k === "d" ? "draw" : k === "c" ? "comment" : null;
}

/** The box around all the strokes, grown by `pad`, or null with nothing drawn. */
export function strokeBounds(strokes: Stroke[], pad = 0): { x: number; y: number; width: number; height: number } | null {
  const points = strokes.flat();
  if (!points.length) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/** The message a drawing sends; the image goes with it as a reference. */
export function drawMessage(note: string, near: string | null): string {
  const lines = [`I drew on the page${near ? `, around ${near}` : ""}. The attached image shows my marks.`];
  if (note.trim()) lines.push(note.trim());
  else lines.push("Work out what the marks are asking for, and fix it.");
  return lines.join("\n");
}

/** The tools at the stage's top-left, drawn at a fixed size whatever the page's scale. */
export function CanvasToolsPill({ tool, onTool }: { tool: CanvasTool; onTool: (t: CanvasTool) => void }) {
  return (
    <div className="studio-tools" role="toolbar" aria-label="Canvas tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={`icon-button${tool === t.id ? " active" : ""}`} aria-pressed={tool === t.id} aria-label={t.label} aria-keyshortcuts={t.key} title={`${t.label} (${t.key})`} onClick={() => onTool(t.id)}>
          <t.Icon size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/** Freehand marks over the stage and the dock under them. `onSend` gets the strokes in the layer's own pixels. */
export function DrawLayer({ busy, capturing, onSend, onCancel }: { busy: string | null; capturing: boolean; onSend: (strokes: Stroke[], note: string) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undone, setUndone] = useState<Stroke[]>([]);
  const [note, setNote] = useState("");
  const live = useRef<Stroke | null>(null);

  const paint = (all: Stroke[]) => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * ratio);
    const h = Math.round(c.clientHeight * ratio);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, c.clientWidth, c.clientHeight);
    g.strokeStyle = getComputedStyle(c).color;
    g.lineWidth = 3;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const s of all) {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (s.length === 1 && s[0]) g.lineTo(s[0].x + 0.1, s[0].y);
      g.stroke();
    }
  };
  useEffect(() => paint(strokes), [strokes]);
  useEffect(() => {
    const onResize = () => paint(strokes);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  const point = (e: ReactPointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const undo = () => {
    const last = strokes[strokes.length - 1];
    if (!last) return;
    setStrokes(strokes.slice(0, -1));
    setUndone([...undone, last]);
  };
  const redo = () => {
    const last = undone[undone.length - 1];
    if (!last) return;
    setUndone(undone.slice(0, -1));
    setStrokes([...strokes, last]);
  };
  // ⌘Z belongs to the strokes while drawing, not to the page.
  const keys = useRef({ undo, redo });
  keys.current = { undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      (e.shiftKey ? keys.current.redo : keys.current.undo)();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <canvas
        ref={canvas}
        className="studio-draw"
        aria-label="Draw on the page"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          live.current = [point(e)];
          setUndone([]);
        }}
        onPointerMove={(e) => {
          if (!live.current) return;
          live.current.push(point(e));
          paint([...strokes, live.current]);
        }}
        onPointerUp={() => {
          if (live.current) setStrokes([...strokes, live.current]);
          live.current = null;
        }}
      />
      {!capturing && (
        <form
          className="studio-draw-dock"
          onSubmit={(e) => {
            e.preventDefault();
            if (strokes.length && !busy) onSend(strokes, note);
          }}
        >
          <input
            autoFocus
            className="studio-pill-input"
            aria-label="A note for the agent"
            placeholder="Circle what's wrong, add a note for the agent…"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onCancel();
              }
            }}
          />
          <button type="button" className="icon-button" aria-label="Undo the last stroke" title="Undo (⌘Z)" disabled={!strokes.length} onClick={undo}>
            <Undo2 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Redo the stroke" title="Redo (⇧⌘Z)" disabled={!undone.length} onClick={redo}>
            <Redo2 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="icon-button" aria-label="Clear the drawing" title="Clear" disabled={!strokes.length} onClick={() => setStrokes([])}>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="button ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" title={busy ?? (strokes.length ? "Send the drawing to the agent" : "Draw something first")} disabled={!strokes.length || busy !== null}>
            Send
          </button>
        </form>
      )}
    </>
  );
}
