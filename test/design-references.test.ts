import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getReference,
  REFERENCE_NOT_DOWNLOADED,
  REFERENCE_NOTICE,
  REFERENCE_TEXT_MAX,
  referenceFacets,
  searchReferences,
  type ReferenceSource,
} from "../src/main/design/references";
import {
  REFERENCE_ORIGIN,
  ReferenceStore,
  referenceUrl,
  type ReferenceIndexEntry,
  type ReferenceManifest,
  type ReferenceVariant,
} from "../src/main/design/references-store";
import { DESIGN_REFERENCE_GET_TOOL, DESIGN_REFERENCE_SEARCH_TOOL, designTools, type DesignToolDeps } from "../src/main/design/tools";
import { tempDir } from "./helpers";

const FILE_SHA = "b".repeat(64);

/** Four synthetic sites, never real GradientDeck content. */
const INDEX: ReferenceIndexEntry[] = [
  {
    slug: "acme-pay",
    name: "Acme Pay",
    nickname: "Calm green checkout",
    industry: "fintech",
    theme: "light",
    host: "acme.test",
    colors: [{ name: "Forest", hex: "#0b7443" }],
    fonts: ["Inter"],
  },
  {
    slug: "night-owl",
    name: "Night Owl",
    nickname: "Dark trading desk",
    industry: "ai",
    theme: "dark",
    host: "night.test",
    colors: [{ name: "Ink", hex: "#111111" }],
    fonts: ["Mono"],
  },
  {
    slug: "paper-co",
    name: "Paper Co",
    industry: "media",
    theme: "light",
    host: "paper.test",
    colors: [{ name: "Cream", hex: "#faf3e0" }],
    fonts: ["Serif"],
  },
  {
    slug: "solo",
    name: "Solo",
    theme: "mixed",
    colors: [{ name: "Blue", hex: "#123456" }],
  },
];

const MANIFEST: ReferenceManifest = {
  version: 1,
  source: "https://ui.gradientdeck.com",
  fetchedAt: "2026-11-11T00:00:00.000Z",
  index: { sha256: "a".repeat(64), bytes: 10 },
  files: {
    "acme-pay": { compact: { sha256: FILE_SHA, bytes: 10 }, extended: { sha256: FILE_SHA, bytes: 10 } },
    "night-owl": { compact: { sha256: FILE_SHA, bytes: 10 }, extended: { sha256: FILE_SHA, bytes: 10 } },
    "paper-co": { compact: { sha256: FILE_SHA, bytes: 10 }, extended: { sha256: FILE_SHA, bytes: 10 } },
    solo: { extended: { sha256: FILE_SHA, bytes: 10 } },
  },
  missing: [],
};

/** A short synthetic document with the headings the tools look for, plus a heading inside a fence. */
function markdown(slug: string): string {
  return [
    `# ${slug}`,
    "",
    "## Tokens — Colors",
    "",
    "- Forest #0b7443",
    "",
    "```css",
    "## not a heading",
    ".thing { color: #0b7443; }",
    "```",
    "",
    "## Typography",
    "",
    "Inter for body text.",
    "",
    "### Type Scale",
    "",
    "- 16 / 1.5",
    "",
    "## Components",
    "",
    "- Button",
    "",
  ].join("\n");
}

const TEXTS = new Map<string, string>();
for (const entry of INDEX) {
  for (const variant of ["compact", "extended"] as ReferenceVariant[]) {
    if (MANIFEST.files[entry.slug]?.[variant]) TEXTS.set(`${entry.slug}:${variant}`, markdown(entry.slug));
  }
}

function makeSource(): ReferenceSource {
  return {
    index: () => INDEX,
    manifest: () => MANIFEST,
    read: (slug, variant) => TEXTS.get(`${slug}:${variant}`) ?? null,
  };
}

/** The first result line, or an empty string when there is none. */
function firstResult(text: string): string {
  return text.split("\n").find((line) => line.startsWith("- ")) ?? "";
}

/** The cursor the More line carries, asserting there is one. */
function cursorOf(text: string): string {
  const line = text.split("\n").find((item) => item.startsWith("More: cursor "));
  if (!line) throw new Error("no cursor in the search text");
  return line.slice("More: cursor ".length);
}

/** A fetch that serves one response and records nothing else. */
function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  }) as typeof fetch;
}

describe("design references", () => {
  it("lists the totals, themes and industries with no arguments", () => {
    const text = searchReferences(makeSource(), {});
    expect(text.split("\n")[0]).toBe("4 design references. Themes: light 2, dark 1, mixed 1.");
    expect(text).toContain("Industries: ai 1, fintech 1, media 1, other 1");
    expect(text).toContain("Search with query");

    const facets = referenceFacets(makeSource());
    expect(facets.total).toBe(4);
    expect(facets.themes).toEqual({ light: 2, dark: 1, mixed: 1 });
    expect(facets.industries).toEqual([
      ["ai", 1],
      ["fintech", 1],
      ["media", 1],
      ["other", 1],
    ]);
  });

  it("ranks a partial or exact name first and finds a colour hex", () => {
    const source = makeSource();
    expect(firstResult(searchReferences(source, { query: "acme" }))).toContain("- acme-pay:");
    expect(firstResult(searchReferences(source, { query: "Acme Pay" }))).toContain("- acme-pay:");
    expect(searchReferences(source, { query: "#0b7443" })).toContain("- acme-pay:");
  });

  it("filters by theme and industry and refuses an unknown industry", () => {
    const source = makeSource();

    const dark = searchReferences(source, { theme: "dark" });
    expect(dark).toContain("- night-owl:");
    expect(dark).not.toContain("- acme-pay:");

    const fintech = searchReferences(source, { industry: "FinTech" });
    expect(fintech).toContain("- acme-pay:");
    expect(fintech).not.toContain("- night-owl:");

    expect(() => searchReferences(source, { industry: "space" })).toThrow(
      "Unknown industry. Call design_reference_search with no arguments to list them.",
    );
  });

  it("pages with a scoped cursor and refuses stale ones", () => {
    const source = makeSource();
    const first = searchReferences(source, { theme: "light", limit: 1 });
    expect(first.split("\n")[0]).toBe("2 matches.");
    expect(first).toContain("- acme-pay:");
    const cursor = cursorOf(first);

    const second = searchReferences(source, { theme: "light", limit: 1, cursor });
    expect(second.split("\n")[0]).toBe("2 matches, from 2.");
    expect(second).toContain("- paper-co:");
    expect(second).not.toContain("More: cursor");

    const stale = "Invalid or stale cursor. Repeat the search without a cursor.";
    expect(() => searchReferences(source, { theme: "light", cursor: "nope!" })).toThrow(stale);
    expect(() => searchReferences(source, { theme: "light", query: "paper", cursor })).toThrow(stale);
  });

  it("reads a reference and one section of it, ignoring headings in fences", () => {
    const source = makeSource();
    const full = getReference(source, { slug: "acme-pay" });
    expect(full.split("\n")[0]).toBe(REFERENCE_NOTICE);
    expect(full.split("\n")[1]).toContain(`Source: ${referenceUrl("acme-pay", "compact")}`);
    expect(full.split("\n")[1]).toContain("2026-11-11");
    expect(full).toContain("## Tokens — Colors");

    const colors = getReference(source, { slug: "acme-pay", section: "Colors" });
    expect(colors).toContain("## Tokens — Colors");
    expect(colors).toContain("Forest #0b7443");
    expect(colors).toContain("## not a heading");
    expect(colors).not.toContain("## Typography");
    expect(colors).not.toContain("Inter for body text");

    const typography = getReference(source, { slug: "acme-pay", section: "Typography" });
    expect(typography).toContain("## Typography");
    expect(typography).toContain("### Type Scale");

    expect(() => getReference(source, { slug: "acme-pay", section: "Nope" })).toThrow(
      'No section "Nope". Sections: Tokens — Colors; Typography; Components.',
    );
    expect(() => getReference(source, { slug: "acme-pay", section: "not a heading" })).toThrow(/No section/);
  });

  it("falls back to the extended variant for a site without a compact one", () => {
    const source = makeSource();
    const text = getReference(source, { slug: "solo" });
    expect(text).toContain("The compact version isn't downloaded; this is the extended one.");
    expect(text).toContain(referenceUrl("solo", "extended"));
    expect(() => getReference(source, { slug: "solo", variant: "compact" })).toThrow(
      "The compact version of solo isn't downloaded. Available: extended.",
    );
  });

  it("refuses unknown slugs and files that fail their check", () => {
    const source = makeSource();
    expect(() => getReference(source, { slug: "../etc" })).toThrow("Unknown reference. Use a slug from design_reference_search.");
    expect(() => getReference(source, { slug: "nope" })).toThrow("Unknown reference. Use a slug from design_reference_search.");

    const broken: ReferenceSource = { ...source, read: () => null };
    expect(() => getReference(broken, { slug: "acme-pay" })).toThrow(
      "That reference failed its integrity check. The user can re-download references in Settings → Design.",
    );
  });

  it("cuts a very long reference and points at its sections", () => {
    const source = makeSource();
    const long = "## Tokens — Colors\n\n" + `${"x".repeat(60)}\n`.repeat(500);
    const big: ReferenceSource = { ...source, read: () => long };

    const text = getReference(big, { slug: "acme-pay" });
    expect(text).toContain(`…cut at ${REFERENCE_TEXT_MAX} characters.`);
    expect(text).toContain("Sections: Tokens — Colors.");
    expect(text.length).toBeLessThan(REFERENCE_TEXT_MAX + 1000);
  });

  it("says references aren't downloaded when there is no manifest", () => {
    const source: ReferenceSource = { index: () => INDEX, manifest: () => null, read: () => null };
    expect(searchReferences(source, {})).toBe(REFERENCE_NOT_DOWNLOADED);
    expect(getReference(source, { slug: "acme-pay" })).toBe(REFERENCE_NOT_DOWNLOADED);
  });
});

describe("design reference tools", () => {
  it("offers the two reference tools only when a source is given", async () => {
    const source = makeSource();
    const withRefs = designTools({ kitIndex: () => "", references: source } as unknown as DesignToolDeps, "t");
    const names = withRefs.map((tool) => tool.name);
    expect(names).toContain(DESIGN_REFERENCE_SEARCH_TOOL);
    expect(names).toContain(DESIGN_REFERENCE_GET_TOOL);

    const search = withRefs.find((tool) => tool.name === DESIGN_REFERENCE_SEARCH_TOOL);
    const get = withRefs.find((tool) => tool.name === DESIGN_REFERENCE_GET_TOOL);
    if (!search || !get) throw new Error("the reference tools are missing");
    expect(search.autoAllow).toBe(true);
    expect(get.autoAllow).toBe(true);
    expect((await search.run({})).text).toContain("4 design references");
    expect((await get.run({ slug: "acme-pay" })).text).toContain(REFERENCE_NOTICE);

    const plain = designTools({ kitIndex: () => "" } as unknown as DesignToolDeps, "t");
    expect(plain.map((tool) => tool.name)).not.toContain(DESIGN_REFERENCE_SEARCH_TOOL);
    expect(plain.map((tool) => tool.name)).not.toContain(DESIGN_REFERENCE_GET_TOOL);
    expect(withRefs.every((tool) => Object.values(tool.input).every((schema) => !(schema instanceof z.ZodRecord)))).toBe(true);
  });
});

describe("ReferenceStore caching", () => {
  it("returns the same parsed index and manifest until the set changes", async () => {
    const root = join(tempDir(), "refs");
    const store = new ReferenceStore(root);
    const libraryUrl = `${REFERENCE_ORIGIN}/library.json`;
    const index = JSON.stringify([{ slug: "alpha", name: "Alpha", theme: "light", colors: [] }]);
    const body = markdown("alpha");
    const fetch = fakeFetch((url) => {
      if (url === libraryUrl) return new Response(index);
      if (url === referenceUrl("alpha", "compact") || url === referenceUrl("alpha", "extended")) return new Response(body);
      return new Response(null, { status: 404 });
    });

    await store.download({ fetch });
    const indexOnce = store.index();
    expect(indexOnce).toHaveLength(1);
    expect(store.index()).toBe(indexOnce);

    const manifestOnce = store.manifest();
    expect(manifestOnce).not.toBeNull();
    expect(store.manifest()).toBe(manifestOnce);

    store.remove();
    expect(store.index()).toEqual([]);
  });
});
