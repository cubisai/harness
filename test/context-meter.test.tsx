import { describe, expect, it } from "vitest";
import { contextMeterText, fmt } from "../src/renderer/src/components/Meters";

describe("fmt", () => {
  it("formats small counts and keeps one decimal below ten thousand", () => {
    expect(fmt(999)).toBe("999");
    expect(fmt(8200)).toBe("8.2k");
    expect(fmt(40000)).toBe("40k");
    expect(fmt(200000)).toBe("200k");
  });

  it("drops a trailing .0 on millions", () => {
    expect(fmt(1000000)).toBe("1M");
    expect(fmt(1500000)).toBe("1.5M");
    expect(fmt(2000000)).toBe("2M");
  });
});

describe("contextMeterText", () => {
  it("shows used of window when the size is known", () => {
    expect(contextMeterText(40000, 1000000)).toBe("40k / 1M");
    expect(contextMeterText(200000, 200000)).toBe("200k / 200k");
  });

  it("shows just the used count when the size is unknown", () => {
    expect(contextMeterText(8200, null)).toBe("8.2k context");
  });

  it("renders nothing without a context input", () => {
    expect(contextMeterText(null, 1000000)).toBeNull();
    expect(contextMeterText(undefined, null)).toBeNull();
  });
});
