import { describe, expect, it } from "vitest";
import { affectedPages, useStore } from "../src/renderer/src/store";
import { bumpArtboardCounts } from "../src/renderer/src/design/Board";

describe("affectedPages", () => {
  it("reloads everything when the paths are unknown", () => {
    expect(affectedPages(undefined, ["a.html", "b.html"])).toBe("all");
  });

  it("returns only the changed pages, and nothing for an html file that isn't one", () => {
    expect(affectedPages(["a.html"], ["a.html", "b.html"])).toEqual(["a.html"]);
    expect(affectedPages(["sub/x.html"], ["a.html", "sub/x.html"])).toEqual(["sub/x.html"]);
    expect(affectedPages(["other.html"], ["a.html", "b.html"])).toEqual([]);
  });

  it("reloads everything when a shared asset changed", () => {
    expect(affectedPages(["styles.css"], ["a.html", "b.html"])).toBe("all");
    expect(affectedPages(["app.js"], ["a.html"])).toBe("all");
    expect(affectedPages(["assets/logo.png"], ["a.html"])).toBe("all");
  });
});

describe("bumpArtboardCounts", () => {
  const keys = (counts: Map<string, number>, pages: string[]) => pages.map((rel) => `${rel}-${counts.get(rel) ?? 0}-0`);

  it("increments only the artboard a page change affects", () => {
    const first = bumpArtboardCounts(new Map(), ["a.html", "b.html"], { paths: ["a.html"] });
    expect(keys(first, ["a.html", "b.html"])).toEqual(["a.html-1-0", "b.html-0-0"]);
    const second = bumpArtboardCounts(first, ["a.html", "b.html"], { paths: ["a.html"] });
    expect(keys(second, ["a.html", "b.html"])).toEqual(["a.html-2-0", "b.html-0-0"]);
  });

  it("increments every artboard when a shared asset changed", () => {
    const counts = bumpArtboardCounts(new Map(), ["a.html", "b.html"], { paths: ["styles.css"] });
    expect(keys(counts, ["a.html", "b.html"])).toEqual(["a.html-1-0", "b.html-1-0"]);
  });

  it("leaves the counts alone for an html file that isn't a page", () => {
    const counts = bumpArtboardCounts(new Map(), ["a.html", "b.html"], { paths: ["notes.html"] });
    expect(keys(counts, ["a.html", "b.html"])).toEqual(["a.html-0-0", "b.html-0-0"]);
  });
});

describe("store design changes", () => {
  it("bumps designReload and records the change's paths", () => {
    useStore.setState({ designReload: {}, designChange: {} });
    useStore.getState().apply({ type: "design-changed", threadId: "t", paths: ["a.html"] });
    expect(useStore.getState().designReload).toEqual({ t: 1 });
    expect(useStore.getState().designChange).toEqual({ t: { n: 1, paths: ["a.html"] } });
    useStore.getState().apply({ type: "design-changed", threadId: "t" });
    expect(useStore.getState().designReload).toEqual({ t: 2 });
    expect(useStore.getState().designChange).toEqual({ t: { n: 2, paths: null } });
  });
});
