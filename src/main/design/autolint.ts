import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listDesignPages, pageDevice } from "./pages";
import type { DesignDetect } from "../../shared/types";
import { LINT_MAX, type LintFinding, type LintResult, type LintRule } from "./lint";

/** The rules the automatic lint reports, worst first; spacing and color stay with design_lint. */
export const AUTO_LINT_RULES: readonly LintRule[] = ["contrast", "targets", "slop"];

/** The rules that, found new at the end of a design turn, earn one automatic fix round right away. */
export const AUTO_FIX_RULES: readonly LintRule[] = ["contrast", "targets"];

/** The most findings one automatic note carries (well under design_lint's own cap). */
export const AUTO_LINT_MAX = 12;

/** The most pages one automatic run lints. */
export const AUTO_LINT_PAGES = 3;

/** How long a turn waits for the last turn's automatic lint before going without it. */
export const AUTO_LINT_WAIT_MS = 5000;

/**
 * The slop check ids a design system's DESIGN.md exempts: each `allows: a, b`
 * (or `Lint allows: a, b`) line in its `## Rules` section, bullet or plain, lowercased.
 * A style that means its offset shadows or grid paper says so here, so the lint
 * never argues with it.
 */
export function parseAllows(designMd: string): Set<string> {
  const allows = new Set<string>();
  let inRules = false;
  for (const line of designMd.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inRules = heading[1]!.toLowerCase() === "rules";
      continue;
    }
    if (!inRules) continue;
    const hit = /^\s*(?:[-*]\s+)?(?:lint\s+)?allows:\s*(.+)$/i.exec(line);
    if (!hit) continue;
    for (const id of hit[1]!.split(",")) {
      const clean = id.trim().replace(/[.`]+$/g, "").replace(/^`/, "").toLowerCase();
      if (/^[a-z0-9-]+$/.test(clean)) allows.add(clean);
    }
  }
  return allows;
}

/** The exemptions of the design system in place in a design folder (`system/DESIGN.md`); empty when there is none. Never throws. */
export function styleAllows(root: string): Set<string> {
  try {
    return parseAllows(readFileSync(join(root, "system", "DESIGN.md"), "utf8"));
  } catch {
    return new Set();
  }
}

/** Detect's pins: the auto-lint rules' findings grouped per element, worst rule first; body and html findings apart. */
export function detectPins(result: LintResult): DesignDetect {
  const pins: DesignDetect["pins"] = [];
  const page: string[] = [];
  const bySelector = new Map<string, string[]>();
  let total = 0;
  for (const rule of AUTO_LINT_RULES) {
    for (const f of result.findings) {
      if (f.rule !== rule) continue;
      total += 1;
      if (/^(?:html|body|:root)$/.test(f.selector)) {
        if (page.length < 3 && !page.includes(f.detail)) page.push(f.detail);
        continue;
      }
      let details = bySelector.get(f.selector);
      if (!details) {
        if (pins.length >= 40) continue;
        details = [];
        bySelector.set(f.selector, details);
        pins.push({ n: pins.length + 1, selector: f.selector, details });
      }
      if (details.length < 3 && !details.includes(f.detail)) details.push(f.detail);
    }
  }
  return { pins, page, total };
}

/** `result` without the slop findings whose check id `allows` names. */
export function withoutAllowed(result: LintResult, allows: ReadonlySet<string>): LintResult {
  if (allows.size === 0) return result;
  return { ...result, findings: result.findings.filter((f) => !(f.id && allows.has(f.id))) };
}

/** One page's lint result. */
export interface PageLint {
  rel: string;
  result: LintResult;
}

/**
 * The pages a turn wrote: the design folder's pages modified at or after
 * `since` and not already linted as they are now (`linted` maps a page to the
 * mtime it was last linted at), newest first, at most `max`. Never throws.
 */
export function changedPages(root: string, since: number, linted: ReadonlyMap<string, number> = new Map(), max = AUTO_LINT_PAGES): { rel: string; mtime: number }[] {
  const hits: { rel: string; mtime: number }[] = [];
  for (const rel of listDesignPages(root)) {
    try {
      const mtime = statSync(join(root, rel)).mtimeMs;
      if (mtime >= since && linted.get(rel) !== mtime) hits.push({ rel, mtime });
    } catch {
      // Gone since it was listed.
    }
  }
  return hits.sort((a, b) => b.mtime - a.mtime).slice(0, max);
}

/** The width a page is linted at: a phone page at 390, anything else at 1440. */
export function lintWidth(root: string, rel: string): number {
  try {
    return pageDevice(readFileSync(join(root, rel), "utf8")) === "mobile" ? 390 : 1440;
  } catch {
    return 1440;
  }
}

const keyOf = (f: LintFinding): string => `${f.rule}|${f.selector}|${f.detail}`;

/**
 * The automatic lint note for the next turn, plus what it has now said.
 * Only `AUTO_LINT_RULES` count; a finding repeated across pages (a shared nav)
 * shows once; a finding already said (in `said`) and still there isn't said
 * again. `said` for the next run is what is still there of the old plus what
 * this note shows, so a finding cut by the cap is said later, and one that was
 * fixed and comes back is said again. `text` is "" when nothing is new.
 * `fix` is true when a shown finding is one of `AUTO_FIX_RULES`.
 */
export function autoLintNote(dir: string, pages: PageLint[], said: ReadonlySet<string>): { text: string; said: Set<string>; fix: boolean } {
  const fresh: { rel: string; finding: LintFinding }[] = [];
  const present = new Set<string>();
  for (const rule of AUTO_LINT_RULES) {
    for (const { rel, result } of pages) {
      for (const finding of result.findings) {
        if (finding.rule !== rule) continue;
        const key = keyOf(finding);
        if (present.has(key)) continue;
        present.add(key);
        if (!said.has(key)) fresh.push({ rel, finding });
      }
    }
  }
  const next = new Set([...said].filter((k) => present.has(k)));
  if (fresh.length === 0) return { text: "", said: next, fix: false };
  const shown = fresh.slice(0, Math.min(AUTO_LINT_MAX, LINT_MAX));
  for (const { finding } of shown) next.add(keyOf(finding));
  const lines = shown.map(({ rel, finding }) => `- ${rel} [${finding.rule}] ${finding.selector}: ${finding.detail}`);
  const rest = fresh.length - shown.length;
  if (rest > 0) lines.push(`… ${rest} more; run design_lint to see them.`);
  const text = `\n\n(CubiQ: an automatic design_lint of ${dir} after your last edits found these; fix the ones that are real, leave deliberate choices:\n${lines.join("\n")}\n)`;
  return { text, said: next, fix: shown.some(({ finding }) => AUTO_FIX_RULES.includes(finding.rule)) };
}

/** The one automatic fix round's prompt: the note's findings, asked for now. */
export function autoFixPrompt(note: string): string {
  return `CubiQ checked the pages you just wrote and found contrast or tap-target problems. Fix them now in one pass, then stop; CubiQ won't ask again this turn.${note}`;
}
