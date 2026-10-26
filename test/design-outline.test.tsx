import { describe, expect, it } from "vitest";
import { selectorFor } from "../src/main/browser/picker";
import { bridgeScript, outlineOf, type OutlineNode } from "../src/main/design/bridge";
import { isSelectedNode } from "../src/renderer/src/design/ElementsTree";
import { readBridgeMessage } from "../src/renderer/src/design/frame";

/** A minimal fake element: only the DOM surface outlineOf touches. */
interface Fake {
  tagName: string;
  attrs: Record<string, string>;
  children: Fake[];
  childNodes: unknown[];
}

/** Build a fake element castable to `Element`. */
function make(tag: string, init: Partial<Pick<Fake, "attrs" | "children" | "childNodes">> = {}): Fake {
  const el: Fake = { tagName: tag.toUpperCase(), attrs: init.attrs ?? {}, children: init.children ?? [], childNodes: init.childNodes ?? [] };
  const dom = el as unknown as Record<string, unknown>;
  dom.getAttribute = (name: string): string | null => el.attrs[name] ?? null;
  return el;
}

const asElement = (f: Fake): Element => f as unknown as Element;

/** A text child node for a fake element's `childNodes`. */
const text = (value: string): unknown => ({ nodeType: 3, textContent: value });

/** A selector for tests: a `data-sel` attribute, else the lowercased tag. */
const sel = (el: Element): string => {
  const fake = el as unknown as Fake;
  return fake.attrs["data-sel"] ?? fake.tagName.toLowerCase();
};

describe("outlineOf", () => {
  it("returns the root's children in pre-order with their depths", () => {
    const body = make("body", { children: [make("header", { children: [make("h1")] }), make("main", { children: [make("p")] })] });
    expect(outlineOf(asElement(body), sel)).toEqual([
      { tag: "header", cls: "", selector: "header", label: "", depth: 0 },
      { tag: "h1", cls: "", selector: "h1", label: "", depth: 1 },
      { tag: "main", cls: "", selector: "main", label: "", depth: 0 },
      { tag: "p", cls: "", selector: "p", label: "", depth: 1 },
    ]);
  });

  it("skips script, style and the other non-visual tags", () => {
    const body = make("body", { children: [make("script"), make("style"), make("link"), make("meta"), make("noscript"), make("template"), make("br"), make("div")] });
    expect(outlineOf(asElement(body), sel).map((n) => n.tag)).toEqual(["div"]);
  });

  it("stops at depth 8", () => {
    let deepest = make("span");
    for (let i = 0; i < 12; i++) deepest = make("div", { children: [deepest] });
    const body = make("body", { children: [deepest] });
    expect(outlineOf(asElement(body), sel).map((n) => n.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("stops once 400 nodes are collected", () => {
    const body = make("body", { children: Array.from({ length: 450 }, () => make("div")) });
    expect(outlineOf(asElement(body), sel)).toHaveLength(400);
  });

  it("keeps a valid data-agent-id and drops an invalid one", () => {
    const body = make("body", { children: [make("div", { attrs: { "data-agent-id": "hero_1" } }), make("div", { attrs: { "data-agent-id": "Bad Id!" } })] });
    expect(outlineOf(asElement(body), sel).map((n) => n.id)).toEqual(["hero_1", undefined]);
  });

  it("uses the first two classes joined by dots", () => {
    const body = make("body", { children: [make("div", { attrs: { class: "card" } }), make("div", { attrs: { class: "a b c" } }), make("div")] });
    expect(outlineOf(asElement(body), sel).map((n) => n.cls)).toEqual(["card", "a.b", ""]);
  });

  it("labels with only the element's own direct text, collapsed and capped at 40 characters", () => {
    const child = make("span", { childNodes: [text("ignored")] });
    const body = make("body", { children: [make("p", { children: [child], childNodes: [text("  hello   world  "), child] }), make("p", { childNodes: [text("x".repeat(60))] })] });
    expect(outlineOf(asElement(body), sel).map((n) => n.label)).toEqual(["hello world", "ignored", "x".repeat(40)]);
  });

  it("labels an element with no own text by its aria-label, alt, title or placeholder", () => {
    const body = make("body", {
      children: [
        make("button", { attrs: { "aria-label": "Close" } }),
        make("img", { attrs: { alt: "Team photo" } }),
        make("input", { attrs: { placeholder: "Email" } }),
        make("div", { attrs: { title: "Tip" } }),
        make("p", { attrs: { "aria-label": "ignored" }, childNodes: [text("Own text")] }),
      ],
    });
    expect(outlineOf(asElement(body), sel).map((n) => n.label)).toEqual(["Close", "Team photo", "Email", "Tip", "Own text"]);
  });

  it("reports an svg as one layer, without its paths", () => {
    const body = make("body", {
      children: [make("svg", { children: [make("g", { children: [make("path")] }), make("circle")] }), make("p")],
    });
    expect(outlineOf(asElement(body), sel).map((n) => n.tag)).toEqual(["svg", "p"]);
  });
});

/** A wire outline node, easy to override per case. */
const node = (over: Partial<OutlineNode> = {}): Record<string, unknown> => ({ tag: "div", cls: "", selector: "div", label: "", depth: 0, ...over });

describe("readBridgeMessage outline", () => {
  const read = (nodes: unknown): ReturnType<typeof readBridgeMessage> => readBridgeMessage({ source: "cubiq-design", type: "outline", nodes });

  it("accepts a valid outline, keeping a good id", () => {
    expect(read([node({ id: "hero" }), node({ tag: "span", depth: 2 })])).toEqual({
      type: "outline",
      nodes: [
        { tag: "div", cls: "", selector: "div", label: "", depth: 0, id: "hero" },
        { tag: "span", cls: "", selector: "div", label: "", depth: 2 },
      ],
    });
  });

  it("returns null for a non-array or more than 400 nodes", () => {
    expect(read("nope")).toBeNull();
    expect(read(Array.from({ length: 401 }, () => node()))).toBeNull();
  });

  it("drops a node with a bad tag but keeps the rest", () => {
    expect(read([node(), node({ tag: "DIV!" }), node({ tag: "span" })])).toEqual({
      type: "outline",
      nodes: [
        { tag: "div", cls: "", selector: "div", label: "", depth: 0 },
        { tag: "span", cls: "", selector: "div", label: "", depth: 0 },
      ],
    });
  });

  it("drops a bad id but keeps the node", () => {
    expect(read([node({ id: "Bad Id!" })])).toEqual({ type: "outline", nodes: [{ tag: "div", cls: "", selector: "div", label: "", depth: 0 }] });
  });
});

describe("isSelectedNode", () => {
  const treeNode = (over: Partial<OutlineNode> = {}): OutlineNode => ({ tag: "div", cls: "", selector: "div", label: "", depth: 0, ...over });

  it("matches by id when both have one", () => {
    expect(isSelectedNode(treeNode({ id: "hero", selector: ".a" }), { id: "hero", selector: ".b" })).toBe(true);
  });

  it("matches by selector otherwise, and is false with no selection", () => {
    expect(isSelectedNode(treeNode({ selector: ".a" }), { selector: ".a" })).toBe(true);
    expect(isSelectedNode(treeNode({ selector: ".a" }), { selector: ".b" })).toBe(false);
    expect(isSelectedNode(treeNode(), null)).toBe(false);
  });
});

describe("bridgeScript", () => {
  it("embeds outlineOf and still parses", () => {
    const script = bridgeScript(selectorFor);
    expect(script).toContain("outlineOf");
    expect(() => new Function(script)).not.toThrow();
  });
});
