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
    const g = groundPage('<html><head><style>.hero{background:red}</style></head><body><div class="hero"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>Hi</p></div><script>1</script></body></html>', foundation());
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
    expect(css('[data-ui="mystery"] { color: red }')).toEqual([]);
    expect(css('/* [data-ui="button"] { color: red } */')).toEqual([]);
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
    const deck = (scripts: string) => `<html><body><main class="deck"><section class="slide"><h1>A</h1></section><section class="slide"><h1>B</h1></section></main>${scripts}</body></html>`;
    expect(ids(groundPage(deck('<script src="system/ui.js"></script>'), foundation()))).toEqual(["deck-runtime"]);
    expect(ids(groundPage(deck('<script src="deck.js?v=2"></script>'), foundation()))).toEqual([]);
    expect(ids(groundPage('<section class="slide"><h1>A</h1></section>', foundation()))).toEqual([]);
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
