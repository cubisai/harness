import { describe, expect, it } from "vitest";
import { COMPARE_MAX, compareCells, pageOptions, sameEntry } from "../src/renderer/src/design/pages";
import type { DesignEntry } from "../src/shared/types";

const pages = (...rels: string[]): DesignEntry["pages"] => rels.map((rel) => ({ rel, url: `cubiq-design://d/t1/${rel}` }));
const entry = (rel: string, list: DesignEntry["pages"], handoff = false): DesignEntry => ({ dir: "designs/t1", rel, url: `cubiq-design://d/t1/${rel}`, pages: list, handoff });

describe("design page switcher and compare view", () => {
  it("labels variants as options and keeps pages by file name", () => {
    expect(pageOptions(pages("index.html", "pricing.html", "variant-dense-hero.html"))).toEqual([
      { value: "index.html", label: "index.html" },
      { value: "pricing.html", label: "pricing.html" },
      { value: "variant-dense-hero.html", label: "Option Dense hero", detail: "variant-dense-hero.html" },
    ]);
  });

  it("compares the current index with its variants, never other pages, at most four", () => {
    expect(compareCells(pages("index.html", "pricing.html", "variant-a.html")).map((c) => [c.rel, c.label, c.variant])).toEqual([
      ["index.html", "Current", false],
      ["variant-a.html", "Option A", true],
    ]);
    expect(compareCells(pages("index.html", "variant-a.html", "variant-b.html", "variant-c.html", "variant-d.html"))).toHaveLength(COMPARE_MAX);
    // Two variants without an index still compare.
    expect(compareCells(pages("variant-a.html", "variant-b.html")).map((c) => c.label)).toEqual(["Option A", "Option B"]);
  });

  it("has nothing to compare with fewer than two candidates", () => {
    expect(compareCells(pages("index.html", "pricing.html"))).toEqual([]);
    expect(compareCells(pages("variant-a.html"))).toEqual([]);
    expect(compareCells([])).toEqual([]);
  });

  it("treats an entry as unchanged only when its page and page list are the same", () => {
    const a = entry("index.html", pages("index.html"));
    expect(sameEntry(a, entry("index.html", pages("index.html")))).toBe(true);
    expect(sameEntry(a, entry("index.html", pages("index.html", "variant-a.html")))).toBe(false);
    expect(sameEntry(a, entry("pricing.html", pages("index.html")))).toBe(false);
    // A handoff appearing beside the pages is a change (the Build in code button follows it).
    expect(sameEntry(a, entry("index.html", pages("index.html"), true))).toBe(false);
    expect(sameEntry(null, null)).toBe(true);
    expect(sameEntry(a, null)).toBe(false);
  });
});
