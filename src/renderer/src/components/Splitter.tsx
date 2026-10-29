import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { dragReducer, splitterKeys, splitterReset, splitterValue, type DragState, type SplitterState } from "../splitter";

/**
 * A draggable, keyboard-operable divider between panes. The geometry lives in
 * splitter.ts; this is only the glue: pointer capture, DOM classes and the
 * on-screen class names.
 */
export function Splitter(props: {
  orientation: "vertical" | "horizontal";
  controls: string;
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  collapsed: boolean;
  invert?: boolean;
  className?: string;
  style?: CSSProperties;
  onChange(value: number, collapsed: boolean): void;
  onCommit(value: number, collapsed: boolean): void;
}) {
  const { orientation, controls, label, value, min, max, defaultValue, collapsed, invert, className, style, onChange, onCommit } = props;
  const state: SplitterState = { value, min, max, collapsed, defaultValue, invert };
  const drag = useRef<DragState | null>(null);
  // Vertical dividers drag on X; horizontal ones (the terminal drawer) on Y.
  const axis = (e: { clientX: number; clientY: number }) => (orientation === "vertical" ? e.clientX : e.clientY);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = splitterKeys(state, e.key);
    if (next === state) return;
    e.preventDefault();
    onChange(next.value, next.collapsed);
    onCommit(next.value, next.collapsed);
  };

  const onDoubleClick = () => {
    const next = splitterReset(state);
    onChange(next.value, next.collapsed);
    onCommit(next.value, next.collapsed);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { state: next } = dragReducer({ dragging: false, startX: 0, startValue: value, value, min, max, invert }, { type: "down", x: axis(e) });
    drag.current = next;
    document.body.classList.add("resizing");
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current?.dragging) return;
    const { state: next } = dragReducer(current, { type: "move", x: axis(e) });
    drag.current = next;
    onChange(next.value, false);
  };

  const onPointerUp = () => {
    document.body.classList.remove("resizing");
    const current = drag.current;
    if (!current) return;
    const { state: next, persist } = dragReducer(current, { type: "up" });
    drag.current = next.dragging ? next : null;
    if (persist !== null) onCommit(persist, false);
  };

  const onPointerCancel = () => {
    drag.current = null;
    document.body.classList.remove("resizing");
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-controls={controls}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={splitterValue(state)}
      className={`splitter splitter-${orientation}${className ? " " + className : ""}`}
      style={style}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  );
}
