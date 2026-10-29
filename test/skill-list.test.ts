import { describe, expect, it } from "vitest";
import { skillsOf } from "../src/shared/skill-list";

describe("skillsOf", () => {
  it("prefers the list over the older single skill", () => {
    expect(skillsOf({ skill: "old", skills: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("falls back to the single skill", () => {
    expect(skillsOf({ skill: "a" })).toEqual(["a"]);
  });

  it("is empty when neither is set", () => {
    expect(skillsOf({})).toEqual([]);
  });

  it("drops duplicates and blanks, keeping order", () => {
    expect(skillsOf({ skills: ["b", "a", "b", " ", ""] })).toEqual(["b", "a"]);
  });

  it("ignores an empty list and uses the single skill", () => {
    expect(skillsOf({ skill: "a", skills: [] })).toEqual(["a"]);
  });
});
