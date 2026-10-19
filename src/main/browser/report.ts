/// <reference lib="dom" />
/**
 * P5.5b: browser_report — check the current page against assertions and return
 * a structured, evidence-backed report: each check's pass/fail and the actual
 * value it saw, the console/network log since the page loaded, and an optional
 * screenshot. Pure helpers plus one runner over a BrowserBackend.
 *
 * `assertionResults` runs inside the page (serialized with toString, like
 * collectPage), so it must not reference anything outside itself.
 */

import { NO_LOGS, type BrowserBackend } from "./backend";

/** One thing a report checks: exactly one of text | url | selector, with value/count only alongside a selector. */
export type Assertion = {
  label?: string;
  text?: string;
  selector?: string;
  url?: string;
  value?: string;
  count?: number;
};

/** The in-page checker: every assertion in order, never throwing — a bad selector fails only its own check. */
function assertionResults(list: Assertion[]): { pass: boolean; actual: string }[] {
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return list.map((a) => {
    if (a.text !== undefined) {
      const found = (document.body ? document.body.innerText : "").includes(a.text);
      return { pass: found, actual: found ? "found" : "not found" };
    }
    if (a.url !== undefined) {
      const href = location.href;
      return { pass: href.includes(a.url), actual: href };
    }
    const selector = a.selector ?? "";
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      return { pass: false, actual: "invalid selector" };
    }
    const visibleMatches = matches.filter(visible);
    if (a.value !== undefined) {
      const el = matches[0];
      if (!el) return { pass: false, actual: "no element" };
      const raw = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : (el.textContent ?? "");
      const actual = raw.trim();
      return { pass: actual === a.value, actual };
    }
    if (a.count !== undefined) return { pass: visibleMatches.length === a.count, actual: `${visibleMatches.length} visible` };
    return { pass: visibleMatches.length > 0, actual: `${visibleMatches.length} visible` };
  });
}

/** One in-page expression evaluating every assertion, in order; user strings are JSON-stringified, never concatenated raw. */
export function assertionScript(list: Assertion[]): string {
  return `(${assertionResults.toString()})(${JSON.stringify(list)})`;
}

/** The assertion as a short phrase, prefixed by its label when it has one. */
export function describeAssertion(a: Assertion): string {
  const what =
    a.text !== undefined
      ? `text "${a.text}"`
      : a.url !== undefined
        ? `URL contains "${a.url}"`
        : a.value !== undefined
          ? `"${a.selector}" = "${a.value}"`
          : a.count !== undefined
            ? `"${a.selector}" count ${a.count}`
            : `"${a.selector}" visible`;
  return a.label ? `${a.label}: ${what}` : what;
}

/** A report's evidence: where it ran, each check's outcome, and what the page logged. */
export interface ReportResult {
  url: string;
  target: string;
  checks: { assertion: Assertion; pass: boolean; actual: string }[];
  logs: string;
  screenshot: string | null;
}

/** How many log lines a report shows before summarising the rest. */
const LOG_LINES = 10;

/** The report as the agent reads it: a heading, each check, the logs, and the tally. */
export function formatReport(r: ReportResult, title?: string): string {
  const lines = [title ? `Browser report: ${title}` : "Browser report", `Target: ${r.target}`, `URL: ${r.url}`, ""];
  for (const c of r.checks) {
    lines.push(c.pass ? `PASS  ${describeAssertion(c.assertion)}` : `FAIL  ${describeAssertion(c.assertion)} — actual: ${c.actual}`);
  }
  lines.push("");
  const logs = r.logs === NO_LOGS ? ["none since the page loaded"] : r.logs.split("\n");
  lines.push(`Logs: ${logs.slice(0, LOG_LINES).join("\n")}`);
  if (logs.length > LOG_LINES) lines.push(`… ${logs.length - LOG_LINES} more`);
  if (r.screenshot) lines.push(`Screenshot: ${r.screenshot}`);
  lines.push(r.checks.length ? `Result: ${r.checks.filter((c) => c.pass).length} of ${r.checks.length} checks passed` : "Result: no checks given");
  return lines.join("\n");
}

/** Gather a report's evidence: URL, each check's outcome, the logs, and an optional screenshot path. */
export async function runReport(b: BrowserBackend, list: Assertion[], opts: { screenshot?: boolean; target: string }): Promise<ReportResult> {
  const url = await b.query("location.href");
  const urlText = typeof url === "string" ? url : "";
  const raw = await b.query(assertionScript(list));
  const answered = Array.isArray(raw) ? (raw as unknown[]) : [];
  const checks = list.map((assertion, i) => {
    const a = answered[i] as { pass?: unknown; actual?: unknown } | undefined;
    const pass = a?.pass;
    if (typeof pass !== "boolean") return { assertion, pass: false, actual: "page didn't answer" };
    return { assertion, pass, actual: String(a?.actual) };
  });
  const logs = await b.logs(false);
  const screenshot = opts.screenshot ? (await b.screenshot()).path : null;
  return { url: urlText, target: opts.target, checks, logs, screenshot };
}
