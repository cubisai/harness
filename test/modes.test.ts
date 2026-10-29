import { describe, expect, it } from "vitest";
import { MODE_ORDER, nextMode } from "../src/renderer/src/modes";

describe("nextMode", () => {
  it("cycles ask → auto-edit → plan → full", () => {
    expect(MODE_ORDER).toEqual(["ask", "auto-edit", "plan", "full"]);
    expect(nextMode("ask")).toBe("auto-edit");
    expect(nextMode("auto-edit")).toBe("plan");
    expect(nextMode("plan")).toBe("full");
  });

  it("wraps full back to ask", () => {
    expect(nextMode("full")).toBe("ask");
  });
});
