import { useEffect, useRef } from "react";

/** One pen stroke: points as fractions (0..1) of the overlay's own box, so a drawing survives zoom and resize. */
export type Stroke = { x: number; y: number }[];

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** A stroke as an SVG-style path ("M x y L x y …") in the box's own pixels, one decimal. */
export function strokeToPath(stroke: Stroke, width: number, height: number): string {
  return stroke.map((p, i) => `${i === 0 ? "M" : "L"} ${round1(p.x * width)} ${round1(p.y * height)}`).join(" ");
}

/** The pen colour: the danger token, read once; "red" only if the token is missing. */
function inkColor(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "red";
}

/**
 * A pen drawn over the frame. It fills its parent and keeps whatever the user draws as fractions of its box, so the
 * strokes stay put through zoom, scrolling and resizing; the caller owns them and gets the finished ones on lift.
 */
export function DrawOverlay({ strokes, onStrokes }: { strokes: Stroke[]; onStrokes: (next: Stroke[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The stroke under the pointer, and the caller's strokes, as refs so the paint loop is never stale.
  const current = useRef<Stroke | null>(null);
  const list = useRef(strokes);
  list.current = strokes;
  const onDone = useRef(onStrokes);
  onDone.current = onStrokes;
  const color = useRef("");

  const paint = () => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    // Draw in CSS pixels; the backing store is DPR-scaled so the lines stay crisp.
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (!color.current) color.current = inkColor();
    ctx.strokeStyle = color.current;
    for (const stroke of current.current ? [...list.current, current.current] : list.current) {
      if (stroke.length < 2) continue;
      ctx.beginPath();
      stroke.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
      ctx.stroke();
    }
  };
  // The resize observer is set up once; this keeps it painting the latest strokes.
  const repaint = useRef(paint);
  repaint.current = paint;

  // The backing store follows the box (at the display's pixel ratio), and a resize repaints everything.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      repaint.current();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    return () => ro.disconnect();
  }, []);

  // A change to the strokes from above (undo, clear, a new shape) redraws them all.
  useEffect(() => {
    repaint.current();
  }, [strokes]);

  const at = (el: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.width ? (clientX - r.left) / r.width : 0, y: r.height ? (clientY - r.top) / r.height : 0 };
  };

  return (
    <canvas
      ref={ref}
      className="design-draw"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        current.current = [at(e.currentTarget, e.clientX, e.clientY)];
        repaint.current();
      }}
      onPointerMove={(e) => {
        const stroke = current.current;
        if (!stroke) return;
        stroke.push(at(e.currentTarget, e.clientX, e.clientY));
        repaint.current();
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        const stroke = current.current;
        current.current = null;
        if (stroke && stroke.length >= 2) onDone.current([...list.current, stroke]);
        else repaint.current();
      }}
      onPointerCancel={() => {
        current.current = null;
        repaint.current();
      }}
    />
  );
}
