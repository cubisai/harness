import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { elapsed, verbFor, WaitingLine } from "../src/renderer/src/components/WaitingLine";
import { CATCH_UP_MS, commonPrefix, MIN_CPS, nextReveal } from "../src/renderer/src/smooth";

describe("nextReveal", () => {
  it("shows a big burst within a second, not all at once", () => {
    let shown = 0;
    let t = 0;
    for (; shown < 2000; t += 16) shown = nextReveal(shown, 2000, 16);
    expect(t).toBeLessThan(1000);
    expect(t).toBeGreaterThan(CATCH_UP_MS);
    expect(nextReveal(0, 2000, 16)).toBeLessThan(2000); // not all at once
  });

  it("keeps a slow stream moving at MIN_CPS or better", () => {
    expect(nextReveal(0, 10, 1000)).toBe(10);
    expect(nextReveal(0, 1000, 100)).toBeGreaterThanOrEqual((MIN_CPS * 100) / 1000);
  });

  it("never passes the target and always moves at least one character", () => {
    expect(nextReveal(5, 5, 16)).toBe(5);
    expect(nextReveal(4, 5, 0)).toBe(5);
  });

  it("resumes a rewritten stream from what still matches", () => {
    expect(commonPrefix("Hello wor", "Hello there")).toBe(6);
    expect(commonPrefix("abc", "abcdef")).toBe(3);
  });
});

describe("WaitingLine", () => {
  it("reads like Claude Code's: glyph, verb, time, tokens, how to stop", () => {
    const html = renderToStaticMarkup(<WaitingLine startedAt={1_000_000} now={1_000_000 + 83_000} outputTokens={1234} />);
    expect(html).toContain(`${verbFor(1_000_000)}…`);
    expect(html).toContain("1m 23s · ↓ 1.2k tokens · esc to interrupt");
  });

  it("leaves tokens out until there are some", () => {
    expect(renderToStaticMarkup(<WaitingLine startedAt={0} now={5_000} outputTokens={null} />)).toContain("(5s · esc to interrupt)");
    expect(elapsed(-10)).toBe("0s");
  });
});
