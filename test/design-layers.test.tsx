import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../src/renderer/src/design/frame";
import { ancestorKeys, humanize, layerKind, layerName, layerRows } from "../src/renderer/src/design/layers";

/** A minimal outline node, easy to override per case. */
const n = (over: Partial<OutlineNode>): OutlineNode => ({ tag: "div", cls: "", selector: "div", label: "", depth: 0, ...over });

/** A small outline: header > (h1, nav > a1), then main > p. */
const tree: OutlineNode[] = [
  n({ selector: "header", tag: "header", depth: 0 }),
  n({ selector: "h1", tag: "h1", label: "Notes that think", depth: 1 }),
  n({ selector: "nav", tag: "nav", depth: 1 }),
  n({ selector: "a1", tag: "a", label: "Pricing", depth: 2 }),
  n({ selector: "main", tag: "main", depth: 0 }),
  n({ selector: "p", tag: "p", label: "Hello", depth: 1 }),
];

/** The selectors of the shown rows, for concise assertions. */
const selectors = (nodes: OutlineNode[], collapsed: ReadonlySet<string>, query?: string): string[] =>
  layerRows(nodes, collapsed, query).map((row) => row.node.selector);

describe("humanize", () => {
  it("turns kebab, snake, camel and Pascal spellings into a sentence case name", () => {
    expect(humanize("hero-section")).toBe("Hero section");
    expect(humanize("hero_section")).toBe("Hero section");
    expect(humanize("heroSection")).toBe("Hero section");
    expect(humanize("pricingCard")).toBe("Pricing card");
  });
});

describe("layerKind", () => {
  it("derives the kind from the tag, and makes an unknown tag a group", () => {
    expect(layerKind(n({ tag: "h2" }))).toBe("heading");
    expect(layerKind(n({ tag: "img" }))).toBe("image");
    expect(layerKind(n({ tag: "svg" }))).toBe("vector");
    expect(layerKind(n({ tag: "button" }))).toBe("button");
    expect(layerKind(n({ tag: "a" }))).toBe("link");
    expect(layerKind(n({ tag: "section" }))).toBe("section");
    expect(layerKind(n({ tag: "x-foo" }))).toBe("group");
  });
});

describe("layerName", () => {
  it("prefers a label, then an id, then the first class, then the tag's plain name", () => {
    expect(layerName(n({ label: "Hero", id: "hero-id", cls: "hero-class" }))).toBe("Hero");
    expect(layerName(n({ id: "hero-id", cls: "hero-class" }))).toBe("Hero id");
    expect(layerName(n({ cls: "hero-wrap.dark" }))).toBe("Hero wrap");
    expect(layerName(n({ tag: "h3" }))).toBe("Heading 3");
    expect(layerName(n({ tag: "header" }))).toBe("Header");
    expect(layerName(n({ tag: "div" }))).toBe("Group");
  });
});

describe("layerRows", () => {
  it("shows every row, with hasChildren when the next node is deeper", () => {
    const rows = layerRows(tree, new Set<string>());
    expect(rows.map((row) => row.node.selector)).toEqual(["header", "h1", "nav", "a1", "main", "p"]);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, false, true, false, true, false]);
  });

  it("hides the descendants of a collapsed header", () => {
    expect(selectors(tree, new Set(["header"]))).toEqual(["header", "main", "p"]);
  });

  it("hides only the descendants of a collapsed nav", () => {
    expect(selectors(tree, new Set(["nav"]))).toEqual(["header", "h1", "nav", "main", "p"]);
  });

  it("keys a collapse by id when a node has one", () => {
    const withId = tree.map((node, i) => (i === 0 ? { ...node, id: "hd" } : node));
    expect(selectors(withId, new Set(["hd"]))).toEqual(["header", "main", "p"]);
  });

  it("keeps a match and its ancestors, ignoring collapse", () => {
    expect(selectors(tree, new Set(["header"]), "pricing")).toEqual(["header", "nav", "a1"]);
  });

  it("matches a query case-insensitively", () => {
    expect(selectors(tree, new Set(["header"]), "PRICING")).toEqual(["header", "nav", "a1"]);
  });

  it("returns no rows when nothing matches", () => {
    expect(selectors(tree, new Set(["header"]), "zzz")).toEqual([]);
  });
});

describe("ancestorKeys", () => {
  it("lists the keys of every ancestor, nearest first", () => {
    expect(ancestorKeys(tree, 3)).toEqual(["nav", "header"]);
  });

  it("returns nothing for a root node", () => {
    expect(ancestorKeys(tree, 0)).toEqual([]);
  });
});
