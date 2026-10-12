import { describe, expect, it } from "vitest";
import { imageFiles, refLabel, withRefs } from "../src/renderer/src/design/refs";

describe("design reference images in the composer", () => {
  it("keeps only png, jpg, webp and gif files", () => {
    const files = [new File(["x"], "a.png", { type: "image/png" }), new File(["x"], "b.txt", { type: "text/plain" }), new File(["x"], "c.jpg", { type: "image/jpeg" }), new File(["x"], "d.svg", { type: "image/svg+xml" })];
    expect(imageFiles(files).map((f) => f.name)).toEqual(["a.png", "c.jpg"]);
    expect(imageFiles(null)).toEqual([]);
  });

  it("adds one @path line per reference, and says what to do when the message is empty", () => {
    expect(withRefs("make it calmer", [])).toBe("make it calmer");
    expect(withRefs("make it calmer", ["designs/ab/refs/ref-1.png"])).toBe("make it calmer\n\nReference image: @designs/ab/refs/ref-1.png");
    expect(withRefs("", ["designs/ab/refs/ref-1.png", "designs/ab/refs/ref-2.jpg"])).toBe(
      "Design from this reference.\n\nReference image: @designs/ab/refs/ref-1.png\nReference image: @designs/ab/refs/ref-2.jpg",
    );
  });

  it("labels a chip by its number", () => {
    expect(refLabel("designs/ab/refs/ref-12.webp")).toBe("Reference 12");
    expect(refLabel("designs/ab/refs/other.png")).toBe("Reference");
  });
});
