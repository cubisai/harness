import { useEffect, useRef } from "react";
import { paintedHexColor, pickedColor, toHexColor } from "./contrast";

/**
 * A colour value's swatch that opens the system colour picker; the text input beside it stays for typing a value.
 * `onInput` follows the picker live (a preview or a draft); `onCommit` fires once, when the picker closes. A pick
 * keeps a see-through value's alpha. A value the picker can't show (`var()`, a named colour) stays a plain swatch.
 */
export function ColorSwatch({
  value,
  label,
  disabled = false,
  onInput,
  onCommit,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onInput: (value: string) => void;
  onCommit?: (value: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const hex = toHexColor(value) ?? paintedHexColor(value);
  const pickable = hex !== null && !disabled;
  // React's onChange fires on every drag tick; the native change event fires once, when the picker closes.
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = (): void => latest.current.onCommit?.(pickedColor(el.value, latest.current.value));
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, [pickable]);

  if (!pickable) return <span className="design-inspector-swatch" style={{ background: value }} aria-hidden />;
  return (
    <input
      ref={ref}
      type="color"
      className="design-color-swatch"
      value={hex!}
      aria-label={`Pick ${label}`}
      title="Pick a colour"
      onChange={(e) => onInput(pickedColor(e.target.value, value))}
    />
  );
}
