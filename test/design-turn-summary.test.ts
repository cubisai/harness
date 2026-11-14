import { describe, expect, it } from "vitest";
import { lineDelta, partCounts, turnParts, turnTitle, turnVersion } from "../src/renderer/src/design/turn-summary";

const v = (version: number, turnSeq: number) => ({ version, turnSeq, sha256: "", bytes: 0, createdAt: 0 });

describe("turnVersion", () => {
  it("is the first version under the turn, with the one before it", () => {
    const list = [v(1, 0), v(2, 0), v(3, 5), v(4, 5), v(5, 9)];
    expect(turnVersion(list, 5)).toEqual({ version: 3, previous: 2 });
    expect(turnVersion(list, 0)).toEqual({ version: 1, previous: null });
    expect(turnVersion(list, 7)).toBeNull();
  });
});

describe("lineDelta", () => {
  it("counts added and removed lines, ignoring moves and blank lines", () => {
    expect(lineDelta("a\nb\nc", "c\na\nd\n\n")).toEqual({ added: 1, removed: 1 });
    expect(lineDelta(null, "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("a\na", "a")).toEqual({ added: 0, removed: 1 });
  });
});

describe("turnParts", () => {
  const before = '<main data-ui="stack"><button data-ui="button">A</button></main>';
  const after = '<main data-ui="stack"><div data-ui=stat-card></div><button data-ui="button">A</button><button data-ui="button">B</button></main>';
  it("lists each part once in page order, named from the kit, marking new ones", () => {
    expect(partCounts(after)).toEqual(new Map([["stack", 1], ["stat-card", 1], ["button", 2]]));
    expect(turnParts(before, after, { button: "Button" })).toEqual([
      { ui: "stack", name: "Stack", count: 1, fresh: false },
      { ui: "stat-card", name: "Stat Card", count: 1, fresh: true },
      { ui: "button", name: "Button", count: 2, fresh: false },
    ]);
    expect(turnParts(null, after, {}).every((p) => p.fresh)).toBe(true);
  });

  it("titles a first page by parts and a later one by reuse", () => {
    const parts = turnParts(before, after, {});
    expect(turnTitle(parts, "MUI", false)).toBe("Built from MUI · 2 reused · 1 new");
    expect(turnTitle(parts.slice(0, 1), null, true)).toBe("Built from your kit · 1 part");
    expect(turnTitle(parts.filter((p) => !p.fresh), "MUI", false)).toBe("Built from MUI · 2 reused");
  });
});
