import { memo, useEffect, useRef, useState, type CSSProperties } from "react";

/** The slider's dot grid: columns × rows of 6px cells, wider than any track so the fill only ever clips it. */
const DOT_COLS = 48;
const DOT_ROWS = 3;

/**
 * Each dot's own blink (delay, length, peak), from a fixed pseudo-random
 * sequence: the dots flicker out of step like fireflies, and the pattern
 * doesn't reshuffle on every render.
 */
const DOTS: CSSProperties[] = Array.from({ length: DOT_COLS * DOT_ROWS }, (_, i) => {
  const r = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { "--d": `${(-r(1) * 6).toFixed(2)}s`, "--t": `${(3 + r(2) * 4).toFixed(2)}s`, "--peak": (0.55 + r(3) * 0.45).toFixed(2) } as CSSProperties;
});

/** The dot grid, drawn once: moving the slider slides a cover over it instead of re-rendering every dot. */
const EffortDots = memo(function EffortDots() {
  return (
    <div className="effort-dots">
      {DOTS.map((style, i) => (
        <i key={i} style={style} />
      ))}
    </div>
  );
});

/**
 * A row of stops as one slider (DESIGN.md §7.3): Thinking and Context in the model picker, Text size in Settings.
 * A native range input lies over the drawn track, so drag, arrow keys and
 * screen readers just work; the pick is sent once the drag or key press ends,
 * not at every stop. `index` is the committed stop, `hotFrom` the first stop
 * whose dots glow green.
 */
export function StepSlider({
  name,
  ariaLabel,
  labels,
  index,
  label,
  ends,
  hotFrom = Infinity,
  title,
  reset,
  onPick,
}: {
  /** The heading over the slider; leave it out where a row label already names it (Settings). */
  name?: string;
  ariaLabel: string;
  labels: string[];
  index: number;
  /** The head's reading while nothing is being dragged. */
  label: string;
  ends: [string, string];
  hotFrom?: number;
  title?: string;
  reset?: { title: string; onReset(): void };
  onPick(index: number): void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // A drag follows the pointer closely; a tap or a key press glides.
  const [dragging, setDragging] = useState(false);
  const pressX = useRef<number | null>(null);
  const value = draft ?? index;
  const last = Math.max(1, labels.length - 1);
  const hot = labels.length > 1 && value >= hotFrom;
  const shown = draft === null ? label : (labels[value] ?? "");
  // The knob holds the picked stop until the new value comes back, so it never flicks back to the old one in between.
  useEffect(() => setDraft(null), [index]);
  const commit = () => {
    if (draft === null) return;
    if (draft === index || labels[draft] === undefined) setDraft(null);
    else onPick(draft);
  };
  const release = () => {
    pressX.current = null;
    setDragging(false);
    commit();
  };
  return (
    <div className={`effort${hot ? " hot" : ""}${dragging ? " dragging" : ""}`} style={{ "--p": value / last } as CSSProperties} title={title}>
      <div className="effort-head">
        {name ? <span className="model-group">{name}</span> : <span className="grow" />}
        <span className="effort-level">{shown}</span>
        {reset && (
          <button className="effort-reset" title={reset.title} onClick={reset.onReset}>
            Reset
          </button>
        )}
      </div>
      <div className="effort-ends" aria-hidden="true">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
      <div className="effort-control">
        <input
          type="range"
          className="effort-slider"
          min={0}
          max={labels.length - 1}
          step={1}
          value={value}
          aria-label={ariaLabel}
          aria-valuetext={shown}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerDown={(e) => {
            pressX.current = e.clientX;
          }}
          onPointerMove={(e) => {
            if (!dragging && e.buttons && pressX.current !== null && Math.abs(e.clientX - pressX.current) > 3) setDragging(true);
          }}
          onPointerUp={release}
          onKeyUp={commit}
          onBlur={release}
        />
        <div className="effort-track" aria-hidden="true">
          <EffortDots />
          <div className="effort-rail">
            <div className="effort-cover" />
          </div>
          <div className="effort-rail">
            <div className="effort-knob" />
          </div>
        </div>
      </div>
    </div>
  );
}
