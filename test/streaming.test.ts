import { describe, expect, it, vi } from "vitest";
import { memoizeByHash, parseBlocks, splitStreamingTail } from "../src/renderer/src/streaming";

describe("splitStreamingTail", () => {
  it("freezes at the blank line before an unterminated fence", () => {
    const { frozen, tail } = splitStreamingTail("para\n\n```js\nconst a = 1");
    expect(frozen).toBe("para\n\n");
    expect(tail).toBe("```js\nconst a = 1");
    expect(parseBlocks(frozen).some((b) => b.type === "code")).toBe(false);
  });

  it("freezes a complete fence and leaves the trailing paragraph as tail", () => {
    const { frozen, tail } = splitStreamingTail("```js\nx\n```\npara");
    expect(frozen).toBe("```js\nx\n```\n");
    expect(parseBlocks(frozen)[0]?.type).toBe("code");
    expect(tail).toBe("para");
  });

  it("yields an empty frozen half when there is no boundary yet", () => {
    expect(splitStreamingTail("no boundary yet")).toEqual({ frozen: "", tail: "no boundary yet" });
  });

  it("always keeps frozen + tail equal to the input", () => {
    for (const text of ["hello", "a\n\nb", "```js\nx```", "\r\n", "para\n\n```js\nconst a = 1"]) {
      const { frozen, tail } = splitStreamingTail(text);
      expect(frozen + tail).toBe(text);
    }
  });
});

describe("memoizeByHash", () => {
  it("parses a shared frozen prefix only once across growing text", () => {
    const spy = vi.fn(parseBlocks);
    const first = splitStreamingTail("p1\n\np2 grow").frozen;
    const second = splitStreamingTail("p1\n\np2 growing").frozen;
    memoizeByHash(first, spy);
    memoizeByHash(second, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
