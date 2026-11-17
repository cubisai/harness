import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groundPage, groundingSummary, tokenNamesIn } from "../src/main/design/grounding";
import { parseKitManifest, type KitManifest } from "../src/main/design/kit-schema";

const FOUNDATION = join(process.cwd(), "resources", "design-kits", "foundation");
const KITS = [FOUNDATION, ...readdirSync(join(process.cwd(), "design-kits", "kits")).filter((k) => !k.startsWith(".")).map((k) => join(process.cwd(), "design-kits", "kits", k))];

const manifestOf = (dir: string): KitManifest => {
  const parsed = parseKitManifest(readFileSync(join(dir, "components.json"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.manifest;
};
const foundation = (): KitManifest => manifestOf(FOUNDATION);

describe("kit grounding", () => {
  it("passes every kit's own snippets and blocks as written", () => {
    for (const dir of KITS) {
      const m = manifestOf(dir);
      for (const c of m.components) expect(groundPage(`<body>${c.snippet}</body>`, m).findings, `${m.kitId} ${c.ui}`).toEqual([]);
      let blocks: string[] = [];
      try {
        blocks = readdirSync(join(dir, "blocks")).filter((f) => f.endsWith(".html"));
      } catch {
        // No blocks.
      }
      for (const b of blocks) expect(groundPage(readFileSync(join(dir, "blocks", b), "utf8"), m).findings, `${m.kitId} ${b}`).toEqual([]);
    }
  });

  it("leaves plain HTML, scripts, svg and page CSS on its own classes alone", () => {
    const g = groundPage('<html><head><style>.hero{background:var(--color-accent)}</style></head><body><div class="hero"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>Hi</p></div><script>1</script></body></html>', foundation());
    expect(g.findings).toEqual([]);
    expect(g.elements).toBe(2);
    expect(g.parts).toBe(0);
    expect(groundingSummary(g, "Foundation")).toMatch(/^Kit: no Foundation parts on this page \(2 elements\)/);
  });

  it("flags a redraw only for a declared part and a look property, not for placement", () => {
    const m = foundation();
    const css = (rule: string) => groundPage(`<style>${rule}</style><button data-ui="button">Go</button>`, m).findings.map((f) => f.id);
    expect(css('[data-ui="button"] { border-radius: 0 }')).toEqual(["redraw-part"]);
    expect(css('.bar [data-ui="button"] { margin-left: auto }')).toEqual([]);
    expect(css('[data-ui="mystery"] { color: var(--color-accent) }')).toEqual([]);
    expect(css('/* [data-ui="button"] { color: red } */')).toEqual([]);
  });

  it("counts what sits inside a part as covered: a table's cells are the kit's too", () => {
    const g = groundPage('<body><table data-ui="table"><tr><td>1</td><td>2</td></tr></table><div class="x"><p>Hi</p></div></body>', foundation());
    // The parser adds the table's <tbody>: table, tbody, tr and both cells are covered; the div and its p are not.
    expect([g.elements, g.parts, g.covered]).toEqual([7, 1, 5]);
    expect(groundingSummary(g, "Foundation")).toBe("Kit: 71% of 7 elements are in Foundation parts (1 part: table×1).");
    const low = groundPage(`<body><p data-ui="text">A</p>${"<div><span>x</span></div>".repeat(4)}</body>`, foundation());
    expect(groundingSummary(low, "Foundation")).toMatch(/^Kit: 11% of 9 elements .* Most of the page is hand-built/);
  });

  it("names hand-built twins of the kit's parts, by class, BEM root or alias", () => {
    const m = foundation();
    const g = groundPage('<body><span class="tag">New</span><span class="tag">Hot</span><div class="stat__n">42</div><div class="meter"></div><div class="card"><h3 class="card__title">x</h3></div></body>', m);
    // The card's BEM child is that same card, not a second one.
    expect(g.findings.map((f) => f.detail.split(" is built")[0])).toEqual(["span.tag ×2", "div.stat__n", "div.meter", "div.card"]);
    expect(g.findings[0]!.detail).toContain('use data-ui="badge"');
    // Inside a part, on layout or type names, the deck's slide frame and a plain link: no twin.
    const quiet = groundPage('<body><div data-ui="card"><span class="tag">a</span></div><div class="stack"><p class="text">t</p><a class="link">l</a><div class="bar">search</div></div><section class="slide"><div data-ui="slide"></div></section></body>', m);
    expect(quiet.findings).toEqual([]);
    // A layout part holds anything: a hand-built tag inside a stack is still a twin.
    expect(groundPage('<body><div data-ui="stack"><span class="tag">a</span></div></body>', m).findings.map((f) => f.id)).toEqual(["hand-built-part"]);
  });

  it("caps each kind of finding so a page full of one mistake stays readable", () => {
    const html = Array.from({ length: 20 }, (_, i) => `<div data-ui="made-up-${i}"></div>`).join("");
    expect(groundPage(html, foundation()).findings).toHaveLength(8);
  });
});

describe("page CSS in grounding", () => {
  const page = (style: string) => `<html><head><style>${style}</style></head><body><button data-ui="button">Go</button></body></html>`;
  const ids = (g: ReturnType<typeof groundPage>) => g.findings.map((f) => f.id);

  it("checks the page's own stylesheet like its inline style", () => {
    const g = groundPage(page(""), foundation(), `[data-ui="button"] { background: var(--color-accent); }`);
    expect(ids(g)).toContain("redraw-part");
  });

  it("flags literal colours outside :root and var() fallbacks", () => {
    expect(ids(groundPage(page(".hero { color: #123456; }"), foundation()))).toContain("literal-color");
    expect(ids(groundPage(page(".hero { background: rgb(1 2 3); }"), foundation()))).toContain("literal-color");
    expect(ids(groundPage(page(":root { --brand: #123456; } .hero { color: var(--brand, #fff); }"), foundation()))).not.toContain("literal-color");
  });

  it("flags named colours in colour properties only", () => {
    expect(ids(groundPage(page(".hero { background: white; }"), foundation()))).toContain("literal-color");
    expect(ids(groundPage(page(".hero { border: 1px solid black; }"), foundation()))).toContain("literal-color");
    expect(ids(groundPage(page(".hero { color: var(--color-text, white); }"), foundation()))).not.toContain("literal-color");
    expect(ids(groundPage(page(".hero { background: transparent; color: currentColor; }"), foundation()))).not.toContain("literal-color");
    expect(ids(groundPage(page(".hero { background: url(white.png) no-repeat; }"), foundation()))).not.toContain("literal-color");
    expect(ids(groundPage(page('.hero { font-family: "Red Hat Display"; animation-name: white; }'), foundation()))).not.toContain("literal-color");
  });

  it("flags a new colour token on :root, not a re-set theme token or an alias of one", () => {
    const theme = tokenNamesIn(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"));
    expect(theme.has("--color-accent")).toBe(true);
    const at = (style: string, css = "") => ids(groundPage(page(style), foundation(), css, theme));
    expect(at(":root { --color-carbon: #1d1d1b; }")).toEqual(["page-token"]);
    expect(at("", "@layer page { :root { --ink: rgb(1 2 3); } }")).toEqual(["page-token"]);
    expect(at(":root { --color-accent: #123456; --ink: var(--color-text); --wash: color-mix(in oklab, var(--color-accent) 20%, transparent); }")).toEqual([]);
    expect(at(":root { --space-hero: 96px; }")).toEqual([]);
    expect(at(":root { color: #333; }")).toEqual(["literal-color"]);
    // Without the theme's names (a flat style), :root stays unchecked as before.
    expect(ids(groundPage(page(":root { --color-carbon: #1d1d1b; }"), foundation()))).toEqual([]);
  });

  it("treats a custom property in any rule as a token once the theme's names are known", () => {
    const theme = tokenNamesIn(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"));
    const at = (style: string) => ids(groundPage(page(style), foundation(), "", theme));
    expect(at(".deck { --deck-carbon: #1d1d1b; }")).toEqual(["page-token"]);
    expect(at(".deck { --deck-ink: var(--color-text); color: var(--deck-ink); }")).toEqual([]);
    expect(at(".deck { --deck-ink: var(--color-text); color: #111; }")).toEqual(["literal-color"]);
  });

  it("flags inline SVG painted with literal colours, not a kit picture part", () => {
    const svg = (attrs: string) => ids(groundPage(`<body><svg viewBox="0 0 2 2"><rect ${attrs} width="2" height="2"/></svg></body>`, foundation()));
    expect(svg('fill="#1d1d1b"')).toEqual(["literal-color"]);
    expect(svg('stroke="rgb(1 2 3)"')).toEqual(["literal-color"]);
    expect(svg('fill="var(--color-accent)" stroke="currentColor"')).toEqual([]);
    expect(ids(groundPage('<body><div data-ui="qr-code" role="img"><svg viewBox="0 0 2 2"><path fill="#09090B" d="M0 0h1v1h-1z"/></svg></div></body>', foundation()))).not.toContain("literal-color");
  });

  it("flags a deck page that doesn't load deck.js", () => {
    const slide = (t: string) => `<section class="slide"><div data-ui="slide"><h1 data-ui="heading" data-level="1">${t}</h1></div></section>`;
    const deck = (scripts: string) => `<html><body><main class="deck">${slide("A")}${slide("B")}</main>${scripts}</body></html>`;
    expect(ids(groundPage(deck('<script src="system/ui.js"></script>'), foundation()))).toEqual(["deck-runtime"]);
    expect(ids(groundPage(deck('<script src="deck.js?v=2"></script>'), foundation()))).toEqual([]);
    expect(ids(groundPage(slide("A"), foundation()))).toEqual([]);
  });

  it("flags deck slides without the kit's slide body", () => {
    const g = groundPage('<section class="slide"><div data-ui="slide"><p data-ui="text">A</p></div></section><section class="slide slide--band"><div class="head"><h2>B</h2></div></section>', foundation());
    expect(ids(g)).toEqual(["slide-body"]);
    expect(g.findings[0]!.detail).toMatch(/^1 of 2 slides has no Foundation slide body inside/);
  });

  it("flags element rules that recolour kit parts, not ones that leave parts out", () => {
    expect(ids(groundPage(page("button, input { font: inherit; color: inherit; }"), foundation()))).toContain("element-recolor");
    expect(ids(groundPage(page("@layer page { a:hover { color: var(--color-accent); } }"), foundation()))).toContain("element-recolor");
    expect(ids(groundPage(page(":is(button, input):not([data-ui], [data-ui] *) { color: inherit; }"), foundation()))).not.toContain("element-recolor");
    expect(ids(groundPage(page(".cta button { color: var(--color-text); } button, input { font: inherit; }"), foundation()))).not.toContain("element-recolor");
  });

  it("keeps the design-build scaffolds clean", () => {
    const dir = join(process.cwd(), "resources", "skills", "design-build", "assets");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
      expect(groundPage(readFileSync(join(dir, f), "utf8"), foundation(), readFileSync(join(dir, "deck.css"), "utf8"), tokenNamesIn(readFileSync(join(FOUNDATION, "tokens.css"), "utf8"))).findings, f).toEqual([]);
    }
  });
});
