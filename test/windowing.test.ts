import { describe, expect, it } from "vitest";
import { computeWindow, ESTIMATE_PX, OVERSCAN_PX, WINDOW_MIN_SEGMENTS } from "../src/renderer/src/windowing";

const uniform = (n: number, px = 100): number[] => Array.from({ length: n }, () => px);

/** before + the rendered rows + after must equal the whole scroll height. */
const covered = (heights: number[], w: { start: number; end: number; before: number; after: number }) =>
  w.before + heights.slice(w.start, w.end).reduce((a, b) => a + b, 0) + w.after;

describe("computeWindow", () => {
  it("renders the whole list when the viewport and overscan hold it", () => {
    expect(computeWindow(uniform(5, 100), 0, 600)).toEqual({ start: 0, end: 5, before: 0, after: 0 });
  });

  it("renders the top, middle and bottom of a uniform list", () => {
    const h = uniform(10, 100);
    expect(computeWindow(h, 0, 100, 0)).toEqual({ start: 0, end: 1, before: 0, after: 900 });
    expect(computeWindow(h, 450, 100, 0)).toEqual({ start: 4, end: 6, before: 400, after: 400 });
    expect(computeWindow(h, 900, 100, 0)).toEqual({ start: 9, end: 10, before: 900, after: 0 });
  });

  it("keeps the overscan rows on either side mounted", () => {
    expect(computeWindow(uniform(10, 100), 500, 100, 200)).toEqual({ start: 3, end: 8, before: 300, after: 200 });
  });

  it("tracks varied heights", () => {
    // Runs: [0,50) [50,250) [250,300) [300,500) [500,550) [550,750).
    const h = [50, 200, 50, 200, 50, 200];
    expect(computeWindow(h, 250, 100, 0)).toEqual({ start: 2, end: 4, before: 250, after: 250 });
  });

  it("uses an estimate for unknown heights and still covers the content", () => {
    const h = uniform(300, ESTIMATE_PX);
    const w = computeWindow(h, 12_000, 800);
    expect(covered(h, w)).toBe(h.length * ESTIMATE_PX);
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(h.length);
  });

  it("is empty for no heights", () => {
    expect(computeWindow([], 0, 100)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });

  it("always mounts at least one row, clamped at both ends", () => {
    const h = uniform(4, 100);
    expect(computeWindow(h, -500, 100, 0)).toEqual({ start: 0, end: 1, before: 0, after: 300 });
    expect(computeWindow(h, 10_000, 100, 0)).toEqual({ start: 3, end: 4, before: 300, after: 0 });
    expect(computeWindow([100], 10_000, 100, 0)).toEqual({ start: 0, end: 1, before: 0, after: 0 });
  });

  it("keeps the spacers and the mounted rows equal to the total, everywhere", () => {
    const lists = [uniform(1), uniform(7, 30), uniform(3, 400), [12, 0, 240, 7, 90, 1200]];
    for (const h of lists) {
      for (const scrollTop of [0, 50, 300, 9999]) {
        const w = computeWindow(h, scrollTop, 120, 0);
        expect(covered(h, w)).toBe(h.reduce((a, b) => a + b, 0));
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.end).toBeGreaterThanOrEqual(w.start + 1);
        expect(w.end).toBeLessThanOrEqual(h.length);
      }
    }
  });

  it("exports the documented knobs", () => {
    expect(WINDOW_MIN_SEGMENTS).toBe(200);
    expect(ESTIMATE_PX).toBe(120);
    expect(OVERSCAN_PX).toBe(1200);
  });
});
