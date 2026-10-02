// The app's own zoom (Settings › Appearance › Text size, ⌘= / ⌘− / ⌘0): pure math, shared by main and renderer.

/** The text sizes Settings offers, as page zoom factors. */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4] as const;

export function isZoom(v: unknown): v is number {
  return typeof v === "number" && (ZOOM_STEPS as readonly number[]).includes(v);
}

/** One step bigger (1) or smaller (-1) from `zoom`, clamped to the ends; 0 resets to 100%. */
export function stepZoom(zoom: number, dir: -1 | 0 | 1): number {
  if (dir === 0) return 1;
  // The nearest step, so a value from an older build still steps sensibly.
  let i = 0;
  ZOOM_STEPS.forEach((z, j) => {
    if (Math.abs(z - zoom) < Math.abs(ZOOM_STEPS[i]! - zoom)) i = j;
  });
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))]!;
}

/** The macOS traffic lights (14px tall, drawn unzoomed) centred on the 46px header (22.5px: its 1px bottom hairline sits below the centre) as `zoom` scales it. */
export function trafficLightPosition(zoom: number): { x: number; y: number } {
  return { x: 16, y: Math.round(22.5 * zoom - 7) };
}

/** The zoom shortcut a key press means, if any: ⌘ on macOS, Ctrl elsewhere; = or + bigger, − smaller, 0 reset. */
export function zoomKey(input: { key: string; meta: boolean; control: boolean; alt: boolean }, mac: boolean): -1 | 0 | 1 | null {
  if (input.alt || !(mac ? input.meta : input.control)) return null;
  if (input.key === "=" || input.key === "+") return 1;
  if (input.key === "-" || input.key === "_") return -1;
  if (input.key === "0") return 0;
  return null;
}
