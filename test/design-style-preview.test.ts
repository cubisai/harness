import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseStylePreviewUrl,
  previewTokensCss,
  renderSpecimen,
  serveStylePreview,
  stylePreviewCsp,
  type StylePreviewDeps,
} from "../src/main/design/style-preview";
import type { DesignSystemInfo } from "../src/main/design/systems";
import { tempDir } from "./helpers";

/** A temp style library with one styled system, one plain system and the shared specimen. */
function setup(): { deps: StylePreviewDeps } {
  const base = tempDir();
  const specimen = join(base, "_specimen.html");
  writeFileSync(specimen, '<!doctype html><html data-platform="{{platform}}" data-theme="{{theme}}"><title>{{name}}</title><p>{{description}}</p></html>');

  const dir = join(base, "styles", "swiss-grid");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  const tokens = join(dir, "tokens.css");
  writeFileSync(tokens, "@media (prefers-color-scheme: dark) {\n  :root { --color-bg: #000; }\n}\n");
  const ownFont = join(dir, "fonts", "own.woff2");
  writeFileSync(ownFont, Buffer.from([1, 2, 3]));

  const listedFont = join(base, "design-fonts", "inter.woff2");
  mkdirSync(dirname(listedFont), { recursive: true });
  writeFileSync(listedFont, Buffer.from([4, 5, 6]));

  const system = (name: string, extra: Partial<DesignSystemInfo & { platform?: string }> = {}): DesignSystemInfo & { platform?: string } => ({
    id: "style:swiss-grid",
    name,
    description: `About ${name}`,
    swatches: [],
    source: "style",
    designMd: join(dir, "DESIGN.md"),
    tokensCss: tokens,
    fontFiles: [listedFont],
    platform: "web",
    ...extra,
  });
  const systems: Record<string, DesignSystemInfo & { platform?: string }> = {
    "style:swiss-grid": system("Swiss <Grid>"),
    "style:plain": system("Plain", { id: "style:plain", tokensCss: undefined }),
  };

  return {
    deps: {
      system: (_projectId, id) => systems[id] ?? null,
      specimen,
    },
  };
}

describe("parseStylePreviewUrl", () => {
  it("accepts the page, tokens and fonts, with a theme and a decoded system id", () => {
    expect(parseStylePreviewUrl("cubiq-style://p/proj/style%3Aswiss-grid/index.html?theme=dark")).toEqual({
      projectId: "proj",
      systemId: "style:swiss-grid",
      file: "index.html",
      theme: "dark",
    });
    expect(parseStylePreviewUrl("cubiq-style://p/_/swiss/tokens.css?theme=light")).toEqual({
      projectId: null,
      systemId: "swiss",
      file: "tokens.css",
      theme: "light",
    });
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/fonts/x.woff2")).toEqual({
      projectId: "p1",
      systemId: "s1",
      file: "fonts/x.woff2",
      theme: null,
    });
    expect(parseStylePreviewUrl("CUBIQ-STYLE://p/p1/s1/index.html")).not.toBeNull();
  });

  it("rejects other schemes and hosts, traversal, unsupported files and missing ones", () => {
    expect(parseStylePreviewUrl("https://p/p1/s1/index.html")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://q/p1/s1/index.html")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/../index.html")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/fonts/../a.woff2")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/fonts/a.ttf")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/fonts/sub/a.woff2")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/DESIGN.md")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/index.md")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1/")).toBeNull();
    expect(parseStylePreviewUrl("cubiq-style://p/p1/s1")).toBeNull();
  });
});

describe("previewTokensCss", () => {
  const css = "@media (prefers-color-scheme: dark) { :root { --color-bg: #000; } }";

  it("forces the dark block on for dark and off for light, and leaves null alone", () => {
    expect(previewTokensCss(css, "dark")).toBe("@media all { :root { --color-bg: #000; } }");
    expect(previewTokensCss(css, "light")).toBe("@media not all { :root { --color-bg: #000; } }");
    expect(previewTokensCss(css, null)).toBe(css);
  });
});

describe("renderSpecimen", () => {
  it("escapes the values and writes deck or page for the platform", () => {
    const template = '<div data-platform="{{platform}}">{{name}}|{{description}}|{{theme}}</div>';
    expect(renderSpecimen(template, { name: `<b>"x"&'`, description: "a & b", platform: "deck", theme: "dark" })).toBe(
      '<div data-platform="deck">&lt;b&gt;&quot;x&quot;&amp;&#39;|a &amp; b|dark</div>',
    );
    expect(renderSpecimen(template, { name: "n", description: "d", platform: "mobile", theme: "light" })).toContain('data-platform="page"');
  });
});

describe("serveStylePreview", () => {
  it("serves the specimen with the escaped name and the preview headers", async () => {
    const { deps } = setup();
    const res = serveStylePreview("cubiq-style://p/proj/style%3Aswiss-grid/index.html?theme=dark", deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe(stylePreviewCsp());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await res.text();
    expect(text).toContain("Swiss &lt;Grid&gt;");
    expect(text).toContain('data-platform="page"');
    expect(text).toContain('data-theme="dark"');
  });

  it("serves tokens.css with the dark query rewritten", async () => {
    const { deps } = setup();
    const res = serveStylePreview("cubiq-style://p/proj/style%3Aswiss-grid/tokens.css?theme=dark", deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("@media all");
    expect(text).not.toContain("@media (prefers-color-scheme: dark)");
  });

  it("serves a font from the system's font list and one from its own fonts folder", async () => {
    const { deps } = setup();
    const listed = serveStylePreview("cubiq-style://p/proj/style%3Aswiss-grid/fonts/inter.woff2", deps);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Content-Type")).toBe("font/woff2");
    expect(Array.from(new Uint8Array(await listed.arrayBuffer()))).toEqual([4, 5, 6]);

    const own = serveStylePreview("cubiq-style://p/proj/style%3Aswiss-grid/fonts/own.woff2", deps);
    expect(own.status).toBe(200);
    expect(Array.from(new Uint8Array(await own.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("404s an unknown system, one without tokens.css, and an unlisted font", () => {
    const { deps } = setup();
    expect(serveStylePreview("cubiq-style://p/proj/nope/index.html", deps).status).toBe(404);
    expect(serveStylePreview("cubiq-style://p/proj/style%3Aplain/index.html", deps).status).toBe(404);
    expect(serveStylePreview("cubiq-style://p/proj/style%3Aswiss-grid/fonts/missing.woff2", deps).status).toBe(404);
  });
});
