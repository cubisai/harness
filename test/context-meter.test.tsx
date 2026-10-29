import { describe, expect, it } from "vitest";
import { breakdownLines, contextMeterText, fmt } from "../src/renderer/src/components/Meters";

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

describe("breakdownLines", () => {
  const breakdown = (rows: { label: string; tokens: number }[], estimated: boolean) =>
    breakdownLines({ kind: "context-breakdown", rows, total: null, estimated });

  it("names the header, marking an estimated breakdown", () => {
    const rows = [{ label: "System prompt", tokens: 4000 }];
    expect(breakdown(rows, false)[1]).toBe("First turn breakdown");
    expect(breakdown(rows, true)[1]).toBe("First turn breakdown (estimated)");
  });

  it("keeps at most six rows between the header and the cache caveat", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ label: `Cat ${i}`, tokens: (i + 1) * 100 }));
    const lines = breakdown(rows, false);
    expect(lines[0]).toBe("");
    // blank + header + six rows + caveat.
    expect(lines).toHaveLength(9);
    expect(lines[2]).toBe("  Cat 7: 800");
    expect(lines[7]).toBe("  Cat 2: 300");
    expect(lines.at(-1)).toBe("The first message writes the prompt cache; switching model or agent pays it again.");
  });

  it("sorts rows by tokens descending", () => {
    const rows = [
      { label: "Small", tokens: 10 },
      { label: "Big", tokens: 9000 },
      { label: "Mid", tokens: 500 },
    ];
    expect(breakdown(rows, false).slice(2, 5)).toEqual(["  Big: 9.0k", "  Mid: 500", "  Small: 10"]);
  });
});
