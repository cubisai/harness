import { describe, expect, it } from "vitest";
import { textHash } from "../src/shared/text-hash";

describe("textHash", () => {
  it("is stable, and tells apart texts that differ by one character or in length", () => {
    expect(textHash("<p>a</p>")).toBe(textHash("<p>a</p>"));
    expect(textHash("<p>a</p>")).not.toBe(textHash("<p>b</p>"));
    expect(textHash("")).not.toBe(textHash(" "));
    expect(textHash("<p>a</p>")).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
