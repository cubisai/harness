import { describe, expect, it } from "vitest";
import { designChipLabel, designIntent, designPlaceholder, systemChips } from "../src/renderer/src/design/intent";

const where = { page: "Colors", theme: "Default · Light" };

describe("System mode Composer context", () => {
  it("reads Library, the page and the theme", () => {
    expect(systemChips(where, new Set())).toEqual(["Library", "Colors", "Default · Light"]);
  });
  it("drops a removed chip, and all of them without Library", () => {
    expect(systemChips(where, new Set(["Colors"]))).toEqual(["Library", "Default · Light"]);
    expect(systemChips(where, new Set(["Library"]))).toEqual([]);
    expect(systemChips(undefined, new Set())).toEqual([]);
  });
});

describe("design intent on send", () => {
  it("prefers the chip over System mode", () => {
    expect(designIntent({ kind: "new-kit" }, ["Library", "Colors"])).toEqual({ kind: "new-kit" });
    expect(designIntent({ kind: "match-screenshot" }, [])).toEqual({ kind: "match-screenshot" });
    expect(designIntent({ kind: "new-component", selection: "<div/>" }, [])).toEqual({ kind: "new-component", selection: "<div/>" });
    expect(designIntent({ kind: "new-component" }, [])).toEqual({ kind: "new-component" });
  });
  it("sends System mode's place as a system intent within the 200-character cap", () => {
    expect(designIntent(undefined, ["Library", "Colors", "Default · Light"])).toEqual({ kind: "system", where: "Library · Colors · Default · Light" });
    expect((designIntent(undefined, ["Library", "x".repeat(300)]) as { where: string }).where).toHaveLength(200);
    expect(designIntent(undefined, [])).toBeNull();
  });
  it("labels and placeholders", () => {
    expect(designChipLabel({ kind: "new-kit" })).toBe("New kit");
    expect(designPlaceholder({ kind: "match-screenshot" }, [])).toBe("Say what to match…");
    expect(designPlaceholder(undefined, ["Library"])).toBe("Describe a design system change…");
    expect(designPlaceholder(undefined, [])).toBeNull();
  });
});
