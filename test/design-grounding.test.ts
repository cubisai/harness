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
