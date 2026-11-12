import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groundPage, groundingSummary } from "../src/main/design/grounding";
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

  it("flags element rules that recolour kit parts, not ones that leave parts out", () => {
    expect(ids(groundPage(page("button, input { font: inherit; color: inherit; }"), foundation()))).toContain("element-recolor");
    expect(ids(groundPage(page("@layer page { a:hover { color: var(--color-accent); } }"), foundation()))).toContain("element-recolor");
    expect(ids(groundPage(page(":is(button, input):not([data-ui], [data-ui] *) { color: inherit; }"), foundation()))).not.toContain("element-recolor");
    expect(ids(groundPage(page(".cta button { color: var(--color-text); } button, input { font: inherit; }"), foundation()))).not.toContain("element-recolor");
  });

  it("keeps the design-build scaffolds clean", () => {
    const dir = join(process.cwd(), "resources", "skills", "design-build", "assets");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
      expect(groundPage(readFileSync(join(dir, f), "utf8"), foundation()).findings.filter((x) => x.id === "element-recolor" || x.id === "literal-color"), f).toEqual([]);
    }
  });
});
