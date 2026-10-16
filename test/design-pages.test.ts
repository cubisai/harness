import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PAGES, listDesignPages, pageDevice, promoteVariant } from "../src/main/design/pages";
import { isVariant, variantLabel } from "../src/shared/design";
import { tempDir } from "./helpers";

describe("listDesignPages", () => {
  it("puts index first, then pages a-z, then variants a-z", () => {
    const root = tempDir();
    for (const name of ["variant-b.html", "pricing.html", "index.html", "variant-a.html", "about.html"]) {
      writeFileSync(join(root, name), name);
    }
    expect(listDesignPages(root)).toEqual(["index.html", "about.html", "pricing.html", "variant-a.html", "variant-b.html"]);
  });

  it("ignores subfolders, dotfiles and non-html files", () => {
    const root = tempDir();
    mkdirSync(join(root, "system"));
    writeFileSync(join(root, "system", "nested.html"), "x");
    writeFileSync(join(root, ".hidden.html"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(root, "index.html"), "x");
    expect(listDesignPages(root)).toEqual(["index.html"]);
  });

  it("accepts .htm beside .html", () => {
    const root = tempDir();
    writeFileSync(join(root, "legacy.htm"), "x");
    expect(listDesignPages(root)).toEqual(["legacy.htm"]);
  });

  it("caps the listing at MAX_PAGES", () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "x");
    for (let i = 0; i < MAX_PAGES + 5; i++) writeFileSync(join(root, `p${String(i).padStart(2, "0")}.html`), "x");
    const pages = listDesignPages(root);
    expect(pages).toHaveLength(MAX_PAGES);
    expect(pages[0]).toBe("index.html");
  });

  it("is empty for a missing root", () => {
    expect(listDesignPages(join(tempDir(), "missing"))).toEqual([]);
  });
});

describe("promoteVariant", () => {
  it("copies the variant's bytes to index.html and leaves the variant", () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "MAIN");
    writeFileSync(join(root, "variant-a.html"), "VARIANT");
    promoteVariant(root, "variant-a.html", () => {});
    expect(readFileSync(join(root, "index.html"), "utf8")).toBe("VARIANT");
    expect(readFileSync(join(root, "variant-a.html"), "utf8")).toBe("VARIANT");
  });

  it("records index.html twice when one existed, once when it did not", () => {
    const withIndex = tempDir();
    writeFileSync(join(withIndex, "index.html"), "MAIN");
    writeFileSync(join(withIndex, "variant-a.html"), "VARIANT");
    const seen: string[] = [];
    promoteVariant(withIndex, "variant-a.html", (rel) => seen.push(rel));
    expect(seen).toEqual(["index.html", "index.html"]);

    const withoutIndex = tempDir();
    writeFileSync(join(withoutIndex, "variant-a.html"), "VARIANT");
    const only: string[] = [];
    promoteVariant(withoutIndex, "variant-a.html", (rel) => only.push(rel));
    expect(only).toEqual(["index.html"]);
  });

  it("records the OLD page before copying", () => {
    const root = tempDir();
    writeFileSync(join(root, "index.html"), "MAIN");
    writeFileSync(join(root, "variant-a.html"), "VARIANT");
    const contents: string[] = [];
    promoteVariant(root, "variant-a.html", (rel) => {
      if (rel === "index.html") contents.push(readFileSync(join(root, "index.html"), "utf8"));
    });
    expect(contents).toEqual(["MAIN", "VARIANT"]);
  });

  it("throws Not a variant. for a page or a nested path", () => {
    const root = tempDir();
    writeFileSync(join(root, "pricing.html"), "x");
    expect(() => promoteVariant(root, "pricing.html", () => {})).toThrow("Not a variant.");
    expect(() => promoteVariant(root, "../variant-a.html", () => {})).toThrow("Not a variant.");
    expect(() => promoteVariant(root, "sub/variant-a.html", () => {})).toThrow("Not a variant.");
  });

  it("throws No such variant. for a missing variant", () => {
    expect(() => promoteVariant(tempDir(), "variant-z.html", () => {})).toThrow("No such variant.");
  });
});

describe("variants", () => {
  it("recognises a bare variant name only", () => {
    expect(isVariant("variant-a.html")).toBe(true);
    expect(isVariant("variant-dense-hero.html")).toBe(true);
    expect(isVariant("variant-x.htm")).toBe(true);
    expect(isVariant("pricing.html")).toBe(false);
    expect(isVariant("variant-.html")).toBe(false);
    expect(isVariant("sub/variant-a.html")).toBe(false);
    expect(isVariant("../variant-a.html")).toBe(false);
  });

  it("labels a variant in words and leaves anything else alone", () => {
    expect(variantLabel("variant-a.html")).toBe("A");
    expect(variantLabel("variant-dense-hero.html")).toBe("Dense hero");
    expect(variantLabel("pricing.html")).toBe("pricing.html");
  });
});

describe("pageDevice", () => {
  it("reads the cubiq-device meta in either attribute order", () => {
    expect(pageDevice('<head><meta name="cubiq-device" content="mobile"></head>')).toBe("mobile");
    expect(pageDevice("<meta content='tablet' name='cubiq-device'>")).toBe("tablet");
    expect(pageDevice('<meta name="cubiq-device" content="watch">')).toBeNull();
  });
  it("treats a one-screen phone page (status bar + bottom bar, one phone at most, no board) as mobile", () => {
    expect(pageDevice('<div class="status-bar"></div><main class="screen"></main><nav class="tab-bar"></nav>')).toBe("mobile");
    expect(pageDevice('<section class="phone"><div class="status-bar"></div><div class="home-indicator"></div></section>')).toBe("mobile");
    const two = '<section class="phone"><div class="status-bar"></div><div class="home-indicator"></div></section>';
    expect(pageDevice(two + two)).toBeNull();
    expect(pageDevice(`<div class="board">${two}</div>`)).toBeNull();
    expect(pageDevice('<header class="status-bar"></header>')).toBeNull();
  });
});
