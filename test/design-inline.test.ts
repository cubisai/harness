import { describe, expect, it } from "vitest";
import { dataUri, inlineCss, inlineDesign, resolveRef, type ReadRel } from "../src/main/design/inline";

/** An in-memory design root: strings are UTF-8, Buffers are binary. */
function store(files: Record<string, string | Buffer>): ReadRel {
  return (rel) => {
    if (!(rel in files)) return null;
    const value = files[rel]!;
    return typeof value === "string" ? Buffer.from(value, "utf-8") : Buffer.from(value);
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe("resolveRef", () => {
  it("resolves a relative ref against the containing file", () => {
    expect(resolveRef("css/site.css", "../img/a.png")).toBe("img/a.png");
    expect(resolveRef("pages/a.html", "../img/x.png")).toBe("img/x.png");
    expect(resolveRef("index.html", "assets/app.js")).toBe("assets/app.js");
    expect(resolveRef("index.html", "./a.css")).toBe("a.css");
  });

  it("strips query and hash", () => {
    expect(resolveRef("index.html", "a.css?v=2")).toBe("a.css");
    expect(resolveRef("css/site.css", "../img/a.png#x")).toBe("img/a.png");
  });

  it("leaves external, absolute, and empty refs untouched", () => {
    expect(resolveRef("index.html", "")).toBeNull();
    expect(resolveRef("index.html", "#frag")).toBeNull();
    expect(resolveRef("index.html", "/abs.png")).toBeNull();
    expect(resolveRef("index.html", "//cdn/x.js")).toBeNull();
    expect(resolveRef("index.html", "https://x/a.css")).toBeNull();
    expect(resolveRef("index.html", "data:image/png;base64,AA")).toBeNull();
    expect(resolveRef("index.html", "mailto:a@b.c")).toBeNull();
  });

  it("rejects refs that escape above the design root", () => {
    expect(resolveRef("index.html", "../outside.png")).toBeNull();
    expect(resolveRef("index.html", "../..")).toBeNull();
    expect(resolveRef("a/b.html", "../../x.png")).toBeNull();
  });
});

describe("dataUri", () => {
  it("builds a base64 data URI without the charset suffix", () => {
    expect(dataUri("a.png", Buffer.from("abc"))).toBe("data:image/png;base64,YWJj");
    expect(dataUri("a.css", Buffer.from("abc"))).toBe("data:text/css;base64,YWJj");
  });
});

describe("inlineCss", () => {
  it("inlines both @import forms and wraps a media list", () => {
    const files = { "a.css": '@import "b.css";\n@import url("c.css") screen;', "b.css": "b{}", "c.css": "c{}" };
    expect(inlineCss(files["a.css"]!, "a.css", store(files))).toBe("b{}\n@media screen { c{} }");
  });

  it("inlines imports nested two levels deep", () => {
    const files = { "a.css": '@import "b.css";', "b.css": '@import "c.css";', "c.css": "c{}" };
    expect(inlineCss(files["a.css"]!, "a.css", store(files))).toBe("c{}");
  });

  it("does not hang on a cycle", () => {
    const files = { "a.css": '@import "b.css";', "b.css": '@import "a.css";' };
    expect(() => inlineCss(files["a.css"]!, "a.css", store(files))).not.toThrow();
    expect(inlineCss(files["a.css"]!, "a.css", store(files))).toBe("");
  });

  it("leaves an unresolvable import unchanged", () => {
    const files = { "a.css": '@import "missing.css";' };
    expect(inlineCss(files["a.css"]!, "a.css", store(files))).toBe('@import "missing.css";');
  });

  it("inlines url() relative to the stylesheet's own folder", () => {
    const files = { "css/site.css": "body{background:url(../img/a.png)}", "img/a.png": PNG };
    const out = inlineCss(files["css/site.css"]!, "css/site.css", store(files));
    expect(out).toContain('url("data:image/png;base64,');
    expect(out).not.toContain("img/a.png");
  });
});

describe("inlineDesign", () => {
  it("inlines a linked stylesheet, keeping media", () => {
    const files = { "index.html": '<link rel="stylesheet" href="css/site.css" media="print">', "css/site.css": "body{color:red}" };
    expect(inlineDesign(files["index.html"]!, "index.html", store(files))).toBe('<style media="print">body{color:red}</style>');
  });

  it("inlines a linked stylesheet with no media", () => {
    const files = { "index.html": '<link rel="stylesheet" href="a.css">', "a.css": "body{}" };
    expect(inlineDesign(files["index.html"]!, "index.html", store(files))).toBe("<style>body{}</style>");
  });

  it("strips the query when resolving a link href", () => {
    const files = { "index.html": '<link rel="stylesheet" href="a.css?v=2">', "a.css": "a{}" };
    expect(inlineDesign(files["index.html"]!, "index.html", store(files))).toBe("<style>a{}</style>");
  });

  it("inlines a script, keeps type=module, and escapes a closing script tag", () => {
    const files = { "index.html": '<script type="module" src="app.js"></script>', "app.js": 'const s = "</script>";' };
    const out = inlineDesign(files["index.html"]!, "index.html", store(files));
    expect(out).toBe('<script type="module">const s = "<\\/script>";</script>');
  });

  it("inlines image, source, video poster, and icon assets", () => {
    const files = {
      "index.html":
        '<img src="img/a.png" srcset="img/b.png 1x, img/c.png 2x">' +
        '<source src="img/d.png"><video poster="img/e.png"></video>' +
        '<link rel="icon" href="favicon.svg">',
      "img/a.png": PNG,
      "img/b.png": PNG,
      "img/c.png": PNG,
      "img/d.png": PNG,
      "img/e.png": PNG,
      "favicon.svg": "<svg/>",
    };
    const out = inlineDesign(files["index.html"]!, "index.html", store(files));
    expect(out).toContain('src="data:image/png;base64,');
    expect(out).toContain('srcset="data:image/png;base64,');
    expect(out).not.toContain("img/c.png");
    expect(out).toContain('poster="data:image/png;base64,');
    expect(out).toContain('href="data:image/svg+xml;base64,');
  });

  it("only inlines input type=image", () => {
    const files = {
      "index.html": '<input type="text" src="img/a.png"><input type="image" src="img/b.png">',
      "img/a.png": PNG,
      "img/b.png": PNG,
    };
    const out = inlineDesign(files["index.html"]!, "index.html", store(files));
    expect(out).toContain('type="text" src="img/a.png"');
    expect(out).toContain('type="image" src="data:image/png;base64,');
  });

  it("inlines url() in a style attribute", () => {
    const files = { "index.html": '<div style="background:url(img/x.png)"></div>', "img/x.png": PNG };
    const out = inlineDesign(files["index.html"]!, "index.html", store(files));
    expect(out).toContain('style="background:url("data:image/png;base64,');
    expect(out).not.toContain("img/x.png");
  });

  it("inlines url() inside a <style> block", () => {
    const files = { "index.html": "<style>body{background:url(img/x.png)}</style>", "img/x.png": PNG };
    const out = inlineDesign(files["index.html"]!, "index.html", store(files));
    expect(out).toContain('url("data:image/png;base64,');
    expect(out).not.toContain("img/x.png");
  });

  it("resolves refs from an html file in a subfolder", () => {
    const files = { "pages/a.html": '<img src="../img/x.png">', "img/x.png": PNG };
    const out = inlineDesign(files["pages/a.html"]!, "pages/a.html", store(files));
    expect(out).toContain('src="data:image/png;base64,');
  });

  it("leaves external, absolute, data, escaping, missing, and fragment refs unchanged", () => {
    const html =
      '<link rel="stylesheet" href="https://x/a.css">' +
      '<script src="//cdn/x.js"></script>' +
      '<img src="data:image/png;base64,AAAA">' +
      '<img src="/abs.png">' +
      '<img src="../outside.png">' +
      '<img src="nope.png">' +
      '<a href="#frag">x</a>';
    expect(inlineDesign(html, "index.html", store({}))).toBe(html);
  });

  it("does not throw on malformed html", () => {
    expect(() => inlineDesign("<div><span>", "index.html", store({}))).not.toThrow();
  });
});
