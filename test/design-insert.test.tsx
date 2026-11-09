import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { childGap, gapChoice, type GapLevel } from "../src/main/design/bridge";
import { listVariantSets, resolveVariantSet } from "../src/main/design/variants";
import { insertMessage } from "../src/renderer/src/design/variants";
import { NO_MARKS, readBridgeMessage, type InsertGap } from "../src/renderer/src/design/frame";

const noop = () => {};
const level = (x: number, y: number, width: number, height: number, over: Partial<GapLevel> = {}): GapLevel => ({ rect: { x, y, width, height }, row: false, siblings: true, ...over });

describe("gapChoice", () => {
  // A heading (innermost) inside a card inside a section, all stacked in columns.
  const chain = [level(40, 120, 300, 40), level(20, 100, 340, 200), level(0, 0, 800, 400)];

  it("takes a section boundary over the text inside it when the pointer is near that edge", () => {
    expect(gapChoice(chain, 200, 396)).toEqual({ level: 2, position: "after" });
    expect(gapChoice(chain, 200, 4)).toEqual({ level: 2, position: "before" });
  });

  it("otherwise uses the innermost level with siblings, by the pointer's half", () => {
    expect(gapChoice(chain, 200, 130)).toEqual({ level: 0, position: "before" });
    expect(gapChoice(chain, 200, 152)).toEqual({ level: 0, position: "after" });
    // A heading alone in its card: the card is the first level with siblings.
    const lone = [level(40, 120, 300, 40, { siblings: false }), ...chain.slice(1)];
    expect(gapChoice(lone, 200, 230)).toEqual({ level: 1, position: "after" });
  });

  it("works along the row for blocks that sit side by side", () => {
    const cards = [level(100, 50, 200, 300, { row: true })];
    expect(gapChoice(cards, 120, 200)).toEqual({ level: 0, position: "before" });
    expect(gapChoice(cards, 296, 200)).toEqual({ level: 0, position: "after" });
  });

  it("finds no gap where nothing has a sibling", () => {
    expect(gapChoice([level(0, 0, 800, 400, { siblings: false })], 10, 10)).toBeNull();
    expect(gapChoice([], 10, 10)).toBeNull();
  });
});

describe("childGap", () => {
  // Two sections stacked in a wrapper with a 30px gap between them (y 0–388 and 418–800).
  const kids = [level(24, 0, 676, 388), level(24, 418, 676, 382)];

  it("takes the nearest child's edge when the pointer is in the space between children", () => {
    expect(childGap(kids, 300, 400)).toEqual({ index: 0, position: "after" });
    expect(childGap(kids, 300, 410)).toEqual({ index: 1, position: "before" });
  });

  it("leaves it to the ancestor chain when the pointer is over a child or far from all of them", () => {
    expect(childGap(kids, 300, 200)).toBeNull();
    expect(childGap(kids, 300, 900)).toBeNull();
    expect(childGap([], 0, 0)).toBeNull();
  });

  it("works along the row for cards side by side", () => {
    const cards = [level(0, 0, 200, 300, { row: true }), level(224, 0, 200, 300, { row: true })];
    expect(childGap(cards, 206, 150)).toEqual({ index: 0, position: "after" });
    expect(childGap(cards, 218, 150)).toEqual({ index: 1, position: "before" });
  });
});

const anchor = { selector: "main > section:nth-of-type(2)", tag: "section", text: "Pricing", html: "<section>…</section>", rect: { x: 0, y: 0, width: 960, height: 400 }, path: [], id: "pricing" };

describe("insert messages", () => {
  it("reads a picked gap and its line from the bridge, and nothing malformed", () => {
    const gap = { position: "after", anchor, size: { width: 960, height: 400 } };
    expect(readBridgeMessage({ source: "cubiq-design", type: "gap", gap })).toEqual({ type: "gap", gap });
    expect(readBridgeMessage({ source: "cubiq-design", type: "gap", gap: null })).toEqual({ type: "gap", gap: null });
    expect(readBridgeMessage({ source: "cubiq-design", type: "gap", gap: { ...gap, position: "inside" } })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "gap", gap: { ...gap, anchor: { tag: "p" } } })).toBeNull();
    expect(readBridgeMessage({ source: "cubiq-design", type: "gap-rect", rect: { x: 0, y: 400, width: 960, height: 0 } })).toEqual({ type: "gap-rect", rect: { x: 0, y: 400, width: 960, height: 0 } });
    expect(readBridgeMessage({ source: "cubiq-design", type: "insert-cancel" })).toEqual({ type: "insert-cancel" });
  });

  it("asks for 3 new blocks beside the anchor and keeps the anchor itself as it is", () => {
    const gap: InsertGap = { position: "after", anchor, size: { width: 960, height: 400 } };
    const text = insertMessage("design-1/index.html", gap, "  a testimonials strip  ");
    expect(text.split("\n")[0]).toBe("Insert 3 variants of a new block after the selected element.");
    expect(text).toContain("\na testimonials strip\n");
    expect(text).toContain('Selected in design-1/index.html: <section> data-agent-id="pricing" · selector `main > section:nth-of-type(2)` · 960px wide.');
    expect(text).toContain("Leave it unchanged: write the set right after it, with an empty original.");
    expect(text).not.toContain("change only");
  });
});

describe("resolve tidies the kept style block", () => {
  it("drops the dropped variants' comments and a copied wrapper rule, keeping the kept variant's own", () => {
    const html = `<main>
  <style data-cubiq-variants="goals">
    [data-cubiq-variant]{display:contents}

    /* 1: layout */
    @scope ([data-cubiq-variant="goals-1"]) { :scope > .g { display: grid } }

    /* 2: colour */
    @scope ([data-cubiq-variant="goals-2"]) { :scope > .g { color: red } }

    /* 3: hierarchy */
    @scope ([data-cubiq-variant="goals-3"]) { :scope > .g { font-size: 3rem } }
  </style>
  <div data-cubiq-variant="goals-0" hidden></div>
  <div data-cubiq-variant="goals-1"><div class="g">One</div></div>
  <div data-cubiq-variant="goals-2" hidden><div class="g">Two</div></div>
  <div data-cubiq-variant="goals-3" hidden><div class="g">Three</div></div>
</main>`;
    expect(resolveVariantSet(html, "goals", 2)).toBe(`<main>
  <style>/* 2: colour */
    @scope (.cq-goals) { :scope:is(.g) { color: red } }</style>
  <div class="g cq-goals">Two</div>
</main>`);
  });
});

describe("an inserted set", () => {
  const page = (body: string) => `<!doctype html>\n<html>\n<body>\n<main>\n  <section data-agent-id="pricing">Pricing</section>\n${body}\n  <footer>Keep me</footer>\n</main>\n</body>\n</html>\n`;
  const set = `  <style data-cubiq-variants="quotes">@scope ([data-cubiq-variant="quotes-1"]) { :scope > .q { padding: 24px } }</style>
  <div data-cubiq-variant="quotes-0" hidden></div>
  <div data-cubiq-variant="quotes-1"><aside class="q" data-agent-id="quotes">One</aside></div>
  <div data-cubiq-variant="quotes-2" hidden><aside data-agent-id="quotes">Two</aside></div>
  <div data-cubiq-variant="quotes-3" hidden><aside data-agent-id="quotes">Three</aside></div>`;

  it("is well formed with an empty original", () => {
    expect(listVariantSets(page(set))).toEqual([{ set: "quotes", count: 3, malformed: null }]);
  });

  it("keeps the chosen block beside the anchor on Accept", () => {
    const out = resolveVariantSet(page(set), "quotes", 1);
    expect(out).toContain('<section data-agent-id="pricing">Pricing</section>\n  <style>@scope (.cq-quotes) { :scope:is(.q) { padding: 24px } }</style>\n  <aside class="q cq-quotes" data-agent-id="quotes">One</aside>\n  <footer>');
    expect(out).not.toContain("data-cubiq-variant");
    expect(out).toContain("@scope (.cq-quotes)");
  });

  it("leaves the page as it was before the insert on ×", () => {
    expect(resolveVariantSet(page(set), "quotes", null)).toBe(page("").replace("\n\n", "\n"));
  });

  it("leaves no extra blank line when the agent spaced the set out", () => {
    const before = `<main>\n  <section>Pricing</section>\n\n  <footer>Keep me</footer>\n</main>\n`;
    const after = before.replace("\n\n", `\n\n${set}\n\n`);
    expect(resolveVariantSet(after, "quotes", null)).toBe(before);
  });
});
