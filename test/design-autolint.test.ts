import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_LINT_MAX, autoFixPrompt, autoLintNote, changedPages, lintWidth, parseAllows, styleAllows, withoutAllowed, type PageLint } from "../src/main/design/autolint";
import { LINT_MAX, type LintFinding, type LintResult } from "../src/main/design/lint";
import { tempDir } from "./helpers";

const page = (rel: string, findings: LintFinding[]): PageLint => ({ rel, result: { findings, skipped: [], scanned: 10 } });
const slop = (selector: string, detail = "eyebrow label above a heading"): LintFinding => ({ rule: "slop", selector, detail });

describe("changedPages", () => {
  it("lists the pages written since, newest first, capped; never system files or other folders", () => {
    const root = tempDir();
    mkdirSync(join(root, "system"), { recursive: true });
    const at = (rel: string, seconds: number) => {
      writeFileSync(join(root, rel), "<p>x</p>");
      utimesSync(join(root, rel), seconds, seconds);
    };
    at("index.html", 2000);
    at("about.html", 3000);
    at("old.html", 500);
    at("pricing.html", 2500);
    at("variant-a.html", 1500);
    at("system/tokens.css", 4000);
    const rels = (pages: { rel: string }[]) => pages.map((p) => p.rel);
    expect(rels(changedPages(root, 1000 * 1000))).toEqual(["about.html", "pricing.html", "index.html"]);
    expect(rels(changedPages(root, 1000 * 1000, new Map(), 5))).toEqual(["about.html", "pricing.html", "index.html", "variant-a.html"]);
    // A page already linted as it is now is skipped; once written again it counts.
    expect(rels(changedPages(root, 1000 * 1000, new Map([["about.html", 3000 * 1000]])))).toEqual(["pricing.html", "index.html", "variant-a.html"]);
    expect(rels(changedPages(root, 1000 * 1000, new Map([["about.html", 2999 * 1000]])))).toEqual(["about.html", "pricing.html", "index.html"]);
    expect(changedPages(join(root, "missing"), 0)).toEqual([]);
  });
});

describe("lintWidth", () => {
  it("lints a phone page at 390 and anything else at 1440", () => {
    const root = tempDir();
    writeFileSync(join(root, "app.html"), '<meta name="cubiq-device" content="mobile"><p>x</p>');
    writeFileSync(join(root, "index.html"), "<p>x</p>");
    expect(lintWidth(root, "app.html")).toBe(390);
    expect(lintWidth(root, "index.html")).toBe(1440);
    expect(lintWidth(root, "gone.html")).toBe(1440);
  });
});

describe("autoLintNote", () => {
  it("says contrast, targets and slop findings worst first, once across pages, and leaves spacing and color to design_lint", () => {
    const nav = { rule: "targets" as const, selector: "nav a", detail: "32×20, under 44×44" };
    const { text } = autoLintNote(
      "designs/abcd1234",
      [
        page("index.html", [slop("p.kicker"), { rule: "spacing", selector: "p", detail: "13px" }, nav]),
        page("about.html", [nav, { rule: "contrast", selector: "small", detail: "2.1:1, needs 4.5:1" }, { rule: "color", selector: "a", detail: "#123456" }]),
      ],
      new Set(),
    );
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      "- about.html [contrast] small: 2.1:1, needs 4.5:1",
      "- index.html [targets] nav a: 32×20, under 44×44",
      "- index.html [slop] p.kicker: eyebrow label above a heading",
    ]);
    expect(text).toContain("designs/abcd1234");
  });

  it("says nothing new: an empty text when every finding was already said or the pages are clean", () => {
    const first = autoLintNote("d", [page("index.html", [slop("p.kicker")])], new Set());
    expect(first.text).not.toBe("");
    expect(autoLintNote("d", [page("index.html", [slop("p.kicker")])], first.said).text).toBe("");
    expect(autoLintNote("d", [page("index.html", [])], new Set()).text).toBe("");
  });

  it("says a fixed finding again when it comes back, and one cut by the cap on a later run", () => {
    const first = autoLintNote("d", [page("index.html", [slop("p.kicker")])], new Set());
    const fixed = autoLintNote("d", [page("index.html", [])], first.said);
    expect(fixed.said.size).toBe(0);
    expect(autoLintNote("d", [page("index.html", [slop("p.kicker")])], fixed.said).text).toContain("p.kicker");

    const many = Array.from({ length: AUTO_LINT_MAX + 3 }, (_, i) => slop(`.card-${i}`));
    const capped = autoLintNote("d", [page("index.html", many)], new Set());
    expect(capped.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(AUTO_LINT_MAX);
    expect(capped.text).toContain("… 3 more; run design_lint to see them.");
    const later = autoLintNote("d", [page("index.html", many)], capped.said);
    expect(later.text.split("\n").filter((l) => l.startsWith("- "))).toEqual([".card-12", ".card-13", ".card-14"].map((s) => `- index.html [slop] ${s}: eyebrow label above a heading`));
  });

  it("stays within design_lint's own output cap", () => {
    expect(AUTO_LINT_MAX).toBeLessThanOrEqual(LINT_MAX);
  });

  it("asks for a fix round only for a new contrast or targets finding", () => {
    const contrast = { rule: "contrast" as const, selector: "p.muted", detail: "2.1:1 on #fff" };
    expect(autoLintNote("d", [page("index.html", [slop("p.kicker")])], new Set()).fix).toBe(false);
    const fresh = autoLintNote("d", [page("index.html", [contrast])], new Set());
    expect(fresh.fix).toBe(true);
    expect(autoLintNote("d", [page("index.html", [{ rule: "targets" as const, selector: "nav a", detail: "32×20, under 44×44" }])], new Set()).fix).toBe(true);
    // Still there but already said: nothing new, no fix asked.
    const again = autoLintNote("d", [page("index.html", [contrast])], fresh.said);
    expect(again.fix).toBe(false);
    expect(again.text).toBe("");
    expect(autoFixPrompt(fresh.text).startsWith("CubiQ checked the pages you just wrote")).toBe(true);
    expect(autoFixPrompt(fresh.text)).toContain("- index.html [contrast] p.muted: 2.1:1 on #fff");
  });
});

describe("style exemptions", () => {
  const md = [
    "# Neo Brutal",
    "allows: gradient-text",
    "## Rules",
    "- Make structure visible: thick borders, hard offset shadows.",
    "- Lint allows: hard-offset-shadow, `side-stripe`.",
    "Allows: Grid-Background",
    "## Motion",
    "- allows: pulsing-dot",
  ].join("\n");

  it("reads allows lines only under ## Rules", () => {
    expect([...parseAllows(md)].sort()).toEqual(["grid-background", "hard-offset-shadow", "side-stripe"]);
    expect(parseAllows("# x\n## Rules\n- Keep it flat.").size).toBe(0);
  });

  it("drops only the exempted check ids", () => {
    const result: LintResult = {
      scanned: 3,
      skipped: [],
      findings: [
        { rule: "slop", id: "hard-offset-shadow", selector: ".a", detail: "hard offset shadow (no blur)" },
        { rule: "slop", id: "eyebrow", selector: ".b", detail: "eyebrow" },
        { rule: "contrast", selector: ".c", detail: "low contrast" },
      ],
    };
    expect(withoutAllowed(result, parseAllows(md)).findings.map((f) => f.selector)).toEqual([".b", ".c"]);
    expect(withoutAllowed(result, new Set())).toBe(result);
  });

  it("reads a design folder's system/DESIGN.md and is empty without one", () => {
    const root = tempDir();
    expect(styleAllows(root).size).toBe(0);
    mkdirSync(join(root, "system"));
    writeFileSync(join(root, "system", "DESIGN.md"), md);
    expect(styleAllows(root).has("hard-offset-shadow")).toBe(true);
  });
});
