import { describe, expect, it } from "vitest";
import { listVariantSets, resolveVariantSet, retargetRules } from "../src/main/design/variants";

const page = (body: string) => `<!doctype html>\n<html>\n<head>\n<style>body { margin: 0 }</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;

const set = `  <style data-cubiq-variants="hero">
    @scope ([data-cubiq-variant="hero-1"]) { :scope > .hero { padding: 64px } :scope .title { font-size: 72px } }
    @scope ([data-cubiq-variant="hero-2"]) { :scope > .hero { display: grid } }
    @scope ([data-cubiq-variant="hero-3"]) { .title { color: var(--accent) } }
    @keyframes rise { from { opacity: 0 } }
  </style>
  <div data-cubiq-variant="hero-0" hidden>
    <section class="hero" data-agent-id="hero"><h1 class="title">Old</h1></section>
  </div>
  <div data-cubiq-variant="hero-1">
    <section class="hero" data-agent-id="hero"><h1 class="title">One</h1></section>
  </div>
  <div data-cubiq-variant="hero-2" hidden>
    <section data-agent-id="hero"><h1>Two</h1><p>Sub</p></section>
  </div>
  <div data-cubiq-variant="hero-3" hidden>
    <section class="hero" data-agent-id="hero"><img src="a.png" alt=""><h1 class="title">Three</h1></section>
  </div>
  <footer>Keep me</footer>`;

describe("listVariantSets", () => {
  it("finds a well-formed set and counts its variants", () => {
    expect(listVariantSets(page(set))).toEqual([{ set: "hero", count: 3, malformed: null }]);
    expect(listVariantSets(page("<p>No variants</p>"))).toEqual([]);
  });

  it("names what's wrong with a malformed set", () => {
    expect(listVariantSets(page(set.replace(/<div data-cubiq-variant="hero-0" hidden>[\s\S]*?<\/div>\n/, "")))[0]!.malformed).toBe("the original (variant 0) is missing");
    expect(listVariantSets(page(set.replace("<h1>Two</h1><p>Sub</p></section>", "<h1>Two</h1></section><p>Loose</p>")))[0]!.malformed).toBe("variant 2 must hold exactly one element");
    expect(listVariantSets(page(set.replace('<div data-cubiq-variant="hero-3"', '<div data-cubiq-variant="hero-2"')))[0]!.malformed).toBe("variant 2 appears twice");
    expect(listVariantSets(page(set.replace('<div data-cubiq-variant="hero-2"', '<div data-cubiq-variant="hero-5"')))[0]!.malformed).toBe("variant 2 is missing");
  });
});

describe("resolveVariantSet", () => {
  it("keeps the chosen variant in place, moves its rules onto it, and drops the rest", () => {
    const out = resolveVariantSet(page(set), "hero", 1);
    expect(out).not.toContain("data-cubiq-variant");
    expect(out).toContain('<section class="hero cq-hero" data-agent-id="hero"><h1 class="title">One</h1></section>');
    expect(out).not.toContain(">Old<");
    expect(out).not.toContain(">Two<");
    expect(out).not.toContain(">Three<");
    expect(out).toContain("@scope (.cq-hero) { :scope:is(.hero) { padding: 64px } :is(:scope:is(.title), :scope .title) { font-size: 72px } }");
    // Shared rules stay; the other variants' rules go.
    expect(out).toContain("@keyframes rise");
    expect(out).not.toContain("display: grid");
    expect(out).not.toContain("var(--accent)");
    expect(out).toContain("<footer>Keep me</footer>");
    expect(out).toContain("<style>body { margin: 0 }</style>");
  });

  it("discards back to the original with no leftover rules or class", () => {
    const out = resolveVariantSet(page(set), "hero", null);
    expect(out).toContain('<section class="hero" data-agent-id="hero"><h1 class="title">Old</h1></section>');
    expect(out).not.toContain("data-cubiq-variant");
    expect(out).not.toContain("<style data-cubiq-variants");
    expect(out).not.toContain("@keyframes rise");
    expect(out).not.toContain("cq-hero");
  });

  it("adds a class attribute when the kept element has none, and skips it when the variant has no rules", () => {
    const out = resolveVariantSet(page(set.replace('@scope ([data-cubiq-variant="hero-2"]) { :scope > .hero { display: grid } }', '@scope ([data-cubiq-variant="hero-2"]) { :scope > section { gap: 8px } }')), "hero", 2);
    expect(out).toContain('<section data-agent-id="hero" class="cq-hero"><h1>Two</h1><p>Sub</p></section>');
    expect(out).toContain("@scope (.cq-hero) { :scope:is(section) { gap: 8px } }");
    const bare = resolveVariantSet(page(set.replace(/<style data-cubiq-variants="hero">[\s\S]*?<\/style>\n/, "")), "hero", 3);
    expect(bare).toContain('<section class="hero" data-agent-id="hero"><img src="a.png" alt=""><h1 class="title">Three</h1></section>');
    expect(bare).not.toContain("cq-hero");
  });

  it("refuses to keep a variant from a malformed set, but still discards to an intact original", () => {
    const broken = page(set.replace("<h1>Two</h1><p>Sub</p></section>", "<h1>Two</h1></section><p>Loose</p>"));
    expect(() => resolveVariantSet(broken, "hero", 1)).toThrow("The variants came back malformed: variant 2 must hold exactly one element.");
    expect(resolveVariantSet(broken, "hero", null)).toContain(">Old<");
    expect(() => resolveVariantSet(page(set), "hero", 4)).toThrow("There is no variant 4.");
    expect(() => resolveVariantSet(page(set), "nope", 1)).toThrow("no longer on the page");
    expect(() => resolveVariantSet(page(set), "Bad-Set", 1)).toThrow("Not a variant set.");
  });

  it("isn't fooled by a div or a marker inside a script or a comment", () => {
    const tricky = set.replace("<h1 class=\"title\">One</h1>", "<h1 class=\"title\">One</h1><script>const s = '<div>'; // </div></script><!-- </div> -->");
    expect(listVariantSets(page(tricky))[0]!.malformed).toBeNull();
    expect(resolveVariantSet(page(tricky), "hero", 1)).toContain("<!-- </div> --></section>");
  });
});

describe("retargetRules", () => {
  it("moves child and descendant :scope rules onto the element, inside @media too, and leaves the rest", () => {
    expect(retargetRules(":scope > .card .title { color: red }")).toBe(":scope:is(.card) .title { color: red }");
    expect(retargetRules(":scope .cta:hover { color: red }")).toBe(":is(:scope:is(.cta:hover), :scope .cta:hover) { color: red }");
    expect(retargetRules("@media (max-width: 600px) { :scope > .card { gap: 4px } }")).toBe("@media (max-width: 600px) { :scope:is(.card) { gap: 4px } }");
    expect(retargetRules(".title { content: '{' }")).toBe(".title { content: '{' }");
    expect(retargetRules("@keyframes x { from { opacity: 0 } }")).toBe("@keyframes x { from { opacity: 0 } }");
  });
});
