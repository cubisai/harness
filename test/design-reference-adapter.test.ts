import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptNote, adaptReference, adaptSummary, CONTRAST_PAIRS, parseReference, type AdaptResult } from "../src/main/design/reference-adapter";
import { contrast, parseHex, toOklch } from "../src/main/design/oklch";
import { parseTokens } from "../src/main/design/tokens";

const BASE = readFileSync(join(__dirname, "../resources/design-kits/foundation/tokens.css"), "utf8");

/** A synthetic reference in GradientDeck's extended shape; every value here is made up. */
function reference(opts: { name?: string; theme?: string; colors: string[]; surfaces?: string[]; typography?: string; radius?: string; elevation?: string; quick?: string }): string {
  return [
    `# ${opts.name ?? "Acme Paper"} — Style Reference`,
    "> a made-up test palette",
    "",
    `**Theme:** ${opts.theme ?? "light"}`,
    "",
    "## Tokens — Colors",
    "",
    "| Name | Value | Token | Role |",
    "|------|-------|-------|------|",
    ...opts.colors,
    "",
    "## Tokens — Typography",
    "",
    opts.typography ??
      [
        "### Söhne — Body, navigation and UI labels across the product · `--font-sohne`",
        "- **Substitute:** Inter",
        "- **Weights:** 400, 500, 700",
        "",
        "### Canela — Display headlines and hero statements · `--font-canela`",
        "- **Substitute:** Playfair Display",
        "- **Weights:** 300",
        "",
        "### Type Scale",
        "",
        "| Role | Family | Weight | Size | Line Height | Letter Spacing | Token |",
        "|------|--------|--------|------|-------------|----------------|-------|",
        "| body | — | — | 17px | 1.5 | -0.17px | `--text-body` |",
        "| heading | — | — | 32px | 1.1 | -0.64px | `--text-heading` |",
        "| display | — | — | 64px | 1.05 | -1.92px | `--text-display` |",
      ].join("\n"),
    "",
    "## Tokens — Spacing & Shapes",
    "",
    "### Border Radius",
    "",
    "| Element | Value |",
    "|---------|-------|",
    ...(opts.radius ? [opts.radius] : ["| buttons | 10px |", "| cards | 20px |", "| tags | 9999px |"]),
    "",
    "### Layout",
    "",
    "- **Page max-width:** 1200px",
    "",
    "## Surfaces",
    "",
    "| Level | Name | Value | Purpose |",
    "|-------|------|-------|---------|",
    ...(opts.surfaces ?? []),
    "",
    "## Elevation",
    "",
    opts.elevation ?? "- **Card:** `rgba(0, 0, 0, 0.08) 0px 2px 6px 0px`\n- **Modal:** `rgba(0, 0, 0, 0.2) 0px 24px 48px 0px`",
    "",
    ...(opts.quick ? ["## Agent Prompt Guide", "", opts.quick, ""] : []),
    "## Imagery",
    "",
    "Photography.",
  ].join("\n");
}

const LIGHT = reference({
  colors: [
    "| Ember | `#e4572e` | `--color-ember` | Primary action color for filled CTA buttons and conversion moments |",
    "| Ink | `#1d1b16` | `--color-ink` | Primary text and headings across the page |",
    "| Cobalt | `#2b59c3` | `--color-cobalt` | Link accent and highlighted words. Do not promote it to the primary CTA color |",
    "| Pebble | `#6b665c` | `--color-pebble` | Secondary text, captions and helper copy |",
    "| Hairline | `#e3ded3` | `--color-hairline` | Hairline borders and dividers between rows |",
    "| Paper | `#fdfcf8` | `--color-paper` | Page canvas behind every section |",
    "| Oat | `#f4f1ea` | `--color-oat` | Card surfaces and section bands |",
  ],
  surfaces: ["| 0 | Canvas | `#fdfcf8` | Page background |", "| 1 | Card | `#f4f1ea` | Cards |"],
});

const DARK = reference({
  name: "Night Lab",
  theme: "dark",
  colors: [
    "| Void | `#050505` | `--color-void` | Page canvas, full-bleed backgrounds |",
    "| Chalk | `#f4f4f0` | `--color-chalk` | Primary text, headlines and pill button borders |",
    "| Volt | `#c8ff3c` | `--color-volt` | Sole accent — a hand-drawn ring around one word; never as fill, never as background |",
    "| Smoke | `#5a5a5a` | `--color-smoke` | Muted secondary text and low-emphasis labels |",
  ],
  surfaces: ["| 0 | Void | `#050505` | Canvas |"],
  elevation: "Elevation is rejected. The system has no shadows; depth comes from photography.",
});

/** Every one of the 17 pairs in both schemes, as failures. */
function contrastFailures(result: AdaptResult): string[] {
  const failures: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    for (const [fg, bg, need] of CONTRAST_PAIRS) {
      const ratio = contrast(parseHex(result[scheme][fg])!, parseHex(result[scheme][bg])!);
      if (ratio < need) failures.push(`${scheme} ${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
  }
  return failures;
}

/** A token's value in :root (light) or the dark media block. */
function token(css: string, name: string, scheme: "light" | "dark" = "light"): string | undefined {
  const found = parseTokens(css).flatMap((group) => group.tokens).find((t) => t.name === name);
  return scheme === "light" ? found?.light : (found?.dark ?? undefined);
}

describe("parseReference", () => {
  it("reads the colour, surface, type, radius and shadow tables", () => {
    const ref = parseReference(LIGHT);
    expect(ref.name).toBe("Acme Paper");
    expect(ref.theme).toBe("light");
    expect(ref.colors.map((c) => c.hex)).toContain("#e4572e");
    expect(ref.surfaces[0]?.hex).toBe("#fdfcf8");
    expect(ref.families.map((f) => f.name)).toEqual(["Söhne", "Canela"]);
    expect(ref.families[0]?.weights).toEqual([400, 500, 700]);
    expect(ref.scale.find((r) => r.role === "display")?.trackingEm).toBeCloseTo(-0.03, 5);
    expect(ref.radii).toContainEqual({ element: "buttons", px: 10 });
    expect(ref.shadows).toHaveLength(2);
    expect(ref.maxWidth).toBe(1200);
  });

  it("reads a quick colour reference written as a bold line", () => {
    const text = reference({
      colors: ["| Ink | `#111111` | `--color-ink` | Body text |", "| Paper | `#ffffff` | `--color-paper` | Canvas |", "| Teal | `#0f8b8d` | `--color-teal` | Decorative |"],
      quick: "**Quick Color Reference**\n- text: #111111\n- background: #ffffff\n- primary action: #0f8b8d (filled action)\n\n1. Not a bullet.",
    });
    expect(parseReference(text).quick.map((q) => q.label)).toEqual(["text", "background", "primary action"]);
    const result = adaptReference({ extended: text }, { baseCss: BASE });
    expect(result.report.roles.primary).toMatchObject({ value: "#0f8b8d", confidence: "role-text" });
  });

  it("reads a compact file, whose headings have no Tokens prefix", () => {
    const compact = LIGHT.replace("## Tokens — Colors", "## Colors")
      .replace("| Name | Value | Token | Role |", "| Name | Value | Role |")
      .replace(/\| `--color-[a-z]+` \|/g, "|");
    const result = adaptReference({ compact }, { baseCss: BASE });
    expect(result.report.roles.primary.value).toBe("#e4572e");
  });
});

describe("adaptReference", () => {
  const light = adaptReference({ extended: LIGHT }, { baseCss: BASE });

  it("assigns roles from the reference's own role prose", () => {
    const { roles } = light.report;
    expect(roles.bg).toMatchObject({ value: "#fdfcf8", confidence: "role-text" });
    expect(roles.surface).toMatchObject({ value: "#f4f1ea", confidence: "role-text" });
    expect(roles.text).toMatchObject({ value: "#1d1b16", from: "Ink", confidence: "role-text" });
    expect(roles.primary).toMatchObject({ value: "#e4572e", from: "Ember", confidence: "role-text" });
    expect(roles["text-muted"].from).toBe("Pebble");
    expect(roles.border.from).toBe("Hairline");
    // A link colour the prose keeps off buttons can still be the accent.
    expect(roles.accent).toMatchObject({ value: "#2b59c3", confidence: "role-text" });
  });

  it("passes all 17 contrast pairs in both schemes, the second one derived", () => {
    expect(contrastFailures(light)).toEqual([]);
    expect(light.report.native).toBe("light");
    expect(light.report.notes).toContain("Dark scheme derived from the light one.");
    expect(toOklch(parseHex(light.dark.bg)!).l).toBeLessThan(0.3);
    expect(toOklch(parseHex(light.dark.text)!).l).toBeGreaterThan(0.75);
  });

  it("writes a full Foundation tokens.css with a dark pair and every Foundation token kept", () => {
    const css = light.tokensCss;
    const names = (text: string) => parseTokens(text).flatMap((g) => g.tokens).map((t) => t.name).sort();
    expect(names(css)).toEqual(names(BASE));
    expect(token(css, "--color-primary")).toBe("#e4572e");
    expect(token(css, "--color-bg", "dark")).toBe(light.dark.bg);
    expect(css).toMatch(/:root\s*\{\s*color-scheme: light;/);
    expect(token(css, "--radius-md")).toBe("10px");
    expect(token(css, "--radius-lg")).toBe("20px");
    expect(token(css, "--text-md")).toBe("17px");
    expect(token(css, "--text-display")).toBe("64px");
    expect(token(css, "--tracking-display")).toBe("-0.030em");
    expect(token(css, "--content-max")).toBe("1200px");
    expect(token(css, "--shadow-3")).toBe("rgba(0, 0, 0, 0.2) 0px 24px 48px 0px");
  });

  it("maps fonts to bundled faces and declares only those", () => {
    expect(light.report.fonts).toEqual([
      { slot: "sans", original: "Söhne", face: "Hanken Grotesk", match: "substituted" },
      { slot: "display", original: "Canela", face: "Bodoni Moda", match: "substituted" },
      { slot: "mono", original: null, face: "system mono", match: "system" },
    ]);
    expect(light.fontFiles).toEqual(["hanken-grotesk.woff2", "bodoni-moda.woff2", "bodoni-moda-italic.woff2"]);
    for (const file of light.fontFiles) expect(existsSync(join(__dirname, "../resources/design-fonts", file))).toBe(true);
    expect(token(light.tokensCss, "--font-display")).toMatch(/^"Bodoni Moda", Georgia/);
    // The reference's own font names never reach the CSS.
    expect(light.tokensCss).not.toMatch(/Söhne|Canela/);
  });

  it("is deterministic", () => {
    expect(adaptReference({ extended: LIGHT }, { baseCss: BASE })).toEqual(light);
  });

  it("ships a dark-native reference dark only, with its accent kept off buttons", () => {
    const dark = adaptReference({ extended: DARK }, { baseCss: BASE });
    expect(dark.report.native).toBe("dark");
    expect(dark.tokensCss).toMatch(/:root\s*\{\s*color-scheme: dark;/);
    expect(dark.tokensCss).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(token(dark.tokensCss, "--color-bg")).toBe("#050505");
    expect(dark.report.roles.accent.value).toBe("#c8ff3c");
    expect(dark.report.roles.primary.value).not.toBe("#c8ff3c");
    expect(token(dark.tokensCss, "--shadow-1")).toBe("none");
    expect(contrastFailures(dark)).toEqual([]);

    const shownLight = adaptReference({ extended: DARK }, { baseCss: BASE, appearance: "light" });
    expect(shownLight.tokensCss).toMatch(/:root\s*\{\s*color-scheme: light;/);
    expect(token(shownLight.tokensCss, "--color-bg", "dark")).toBe("#050505");
    expect(token(shownLight.tokensCss, "--color-bg")).toBe(dark.light.bg);
  });

  it("repairs a failing pair by lightness alone and logs it", () => {
    const text = reference({
      colors: [
        "| Paper | `#ffffff` | `--color-paper` | Page canvas |",
        "| Ink | `#202020` | `--color-ink` | Primary text |",
        "| Haze | `#8f9bb0` | `--color-haze` | Secondary text and captions |",
        "| Sky | `#5aa9ff` | `--color-sky` | Primary CTA buttons |",
      ],
    });
    const result = adaptReference({ extended: text }, { baseCss: BASE });
    const fix = result.report.contrastFixes.find((f) => f.scheme === "light" && f.role === "text-muted");
    expect(fix).toMatchObject({ from: "#8f9bb0", against: "bg", need: 4.5 });
    const before = toOklch(parseHex("#8f9bb0")!);
    const after = toOklch(parseHex(fix!.to)!);
    expect(after.l).toBeLessThan(before.l);
    expect(Math.abs(after.h - before.h)).toBeLessThan(8);
    expect(contrastFailures(result)).toEqual([]);
  });

  it("falls back to the ink for a monochrome palette and to luminance for an unlabelled one", () => {
    const mono = adaptReference(
      { extended: reference({ colors: ["| Paper | `#ffffff` | `--color-p` | Page canvas |", "| Ink | `#111111` | `--color-i` | Primary text |"] }) },
      { baseCss: BASE },
    );
    expect(mono.report.roles.primary).toMatchObject({ value: "#111111", confidence: "derived" });
    expect(contrastFailures(mono)).toEqual([]);

    const unlabelled = adaptReference(
      { extended: reference({ colors: ["| A | `#fbfbfb` | `--a` | — |", "| B | `#141414` | `--b` | — |", "| C | `#d62f7a` | `--c` | — |"] }) },
      { baseCss: BASE },
    );
    expect(unlabelled.report.roles.bg).toMatchObject({ value: "#fbfbfb", confidence: "luminance" });
    expect(unlabelled.report.roles.text).toMatchObject({ value: "#141414", confidence: "luminance" });
    expect(unlabelled.report.roles.primary).toMatchObject({ value: "#d62f7a", confidence: "luminance" });
  });

  it("keeps unsafe reference text out of the CSS", () => {
    const text = reference({
      name: "Evil */ body { color: red } /*",
      colors: ["| Paper | `#ffffff` | `--p` | Page canvas |", "| Ink | `#111111` | `--i` | Primary text |"],
      typography: "### Bad*/Font — Body text everywhere · `--font-bad`\n- **Substitute:** none",
      elevation: "- **Card:** `0 1px 2px red; } body { display: none`",
    });
    const result = adaptReference({ extended: text }, { baseCss: BASE });
    expect(result.tokensCss.match(/\*\//g)?.length).toBe((result.tokensCss.match(/\/\*/g) ?? []).length);
    expect(result.tokensCss).not.toContain("display: none");
    expect(result.tokensCss).not.toContain("Bad");
    expect(() => parseTokens(result.tokensCss)).not.toThrow();
  });

  it("refuses text with no colour table", () => {
    expect(() => adaptReference({ extended: "# Empty — Style Reference\n\nNothing here." }, { baseCss: BASE })).toThrow(/no colour table/);
    expect(() => adaptReference({}, { baseCss: BASE })).toThrow(/No reference text/);
  });

  it("summarises the adaptation for the agent and the Customize panel", () => {
    expect(adaptSummary(light.report)).toMatch(/^Adapted from Acme Paper \(light; dark derived\); fonts substituted: Söhne → Hanken Grotesk, Canela → Bodoni Moda/);
    expect(adaptNote(light.report)).toBe("Adapted from Acme Paper · font substituted");
  });
});

// Optional corpus coverage: supply your own reference directory explicitly.
const CORPUS = process.env.GD_CORPUS ?? "";

describe.skipIf(!CORPUS || !existsSync(CORPUS))("adaptReference over the GradientDeck corpus", () => {
  it("adapts every reference, passes every pair and reads bg/text from the reference", () => {
    const slugs = readdirSync(CORPUS);
    const errors: string[] = [];
    const failures: string[] = [];
    const counts = { bg: 0, text: 0, primary: 0 };
    for (const slug of slugs) {
      const read = (file: string) => (existsSync(join(CORPUS, slug, file)) ? readFileSync(join(CORPUS, slug, file), "utf8") : null);
      try {
        const result = adaptReference({ extended: read("DESIGN.extended.md"), compact: read("DESIGN.md") }, { baseCss: BASE });
        failures.push(...contrastFailures(result).map((f) => `${slug}: ${f}`));
        for (const role of ["bg", "text", "primary"] as const) {
          if (["role-text", "luminance"].includes(result.report.roles[role].confidence)) counts[role]++;
        }
      } catch (err) {
        errors.push(`${slug}: ${(err as Error).message}`);
      }
    }
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
    expect(counts.bg / slugs.length).toBeGreaterThanOrEqual(0.95);
    expect(counts.text / slugs.length).toBeGreaterThanOrEqual(0.95);
    // Monochrome palettes and colours the prose keeps off buttons take the ink as primary, by design.
    expect(counts.primary / slugs.length).toBeGreaterThanOrEqual(0.8);
  }, 120_000);
});
