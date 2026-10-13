import { describe, expect, it } from "vitest";
import { nextOptionIndex } from "../src/renderer/src/option-keys";

describe("nextOptionIndex", () => {
  it("steps with the arrows and wraps at both ends", () => {
    expect(nextOptionIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextOptionIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextOptionIndex("ArrowUp", 1, 3)).toBe(0);
    expect(nextOptionIndex("ArrowUp", 0, 3)).toBe(2);
  });

  it("starts from the first (down) or last (up) option when none has focus", () => {
    expect(nextOptionIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextOptionIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("jumps with Home and End", () => {
    expect(nextOptionIndex("Home", 2, 3)).toBe(0);
    expect(nextOptionIndex("End", 0, 3)).toBe(2);
  });

  it("ignores other keys and empty lists", () => {
    expect(nextOptionIndex("Enter", 1, 3)).toBeNull();
    expect(nextOptionIndex("a", 1, 3)).toBeNull();
    expect(nextOptionIndex("ArrowDown", -1, 0)).toBeNull();
  });
});
