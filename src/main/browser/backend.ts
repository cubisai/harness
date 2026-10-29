// What the agent's browser tools drive: the visible pane (BrowserController) or
// a headless session (AgentBrowserBackend). Both speak the same text: snapshots
// with `[eN]` refs, one-line action results, `[level] text` logs.

import type { DevicePreset } from "../../shared/types";
import type { BrowserController } from "./controller";

/** A readiness condition an action waits for (P5.4): every given part must hold. */
export interface WaitFor {
  /** The page URL contains this. */
  url?: string;
  /** A visible element matches this CSS selector. */
  selector?: string;
  /** The page's visible text contains this. */
  text?: string;
  /** Give up after this long; default WAIT_DEFAULT_MS, at most WAIT_MAX_MS. */
  timeoutMs?: number;
}

/** A narrower snapshot: one part of the page, or only what can be acted on. */
export interface SnapshotOptions {
  selector?: string;
  interactive?: boolean;
}

export interface BrowserBackend {
  readonly kind: "visible" | "headless";
  /** Ready to act: the pane opened (visible), nothing to do until the first open (headless). */
  ensureOpen(): Promise<void>;
  /** Load a URL, emulating a device first when given; returns the wait note ("" without a wait). */
  open(url: string, device?: DevicePreset, wait?: WaitFor): Promise<string>;
  snapshot(opts?: SnapshotOptions): Promise<string>;
  click(ref: string, wait?: WaitFor): Promise<string>;
  type(ref: string, text: string, submit: boolean, wait?: WaitFor): Promise<string>;
  evaluate(expression: string): Promise<string>;
  /** Evaluate a read-only expression for the harness itself (not the agent): no takeover check, no action announced; the raw value. */
  query(expression: string): Promise<unknown>;
  /** Logs since the page loaded, or only those since the last read with newOnly. */
  logs(clear: boolean, newOnly?: boolean): Promise<string>;
  screenshot(): Promise<{ path: string; png: Buffer }>;
  close?(): Promise<void>;
}

export const WAIT_DEFAULT_MS = 5_000;
export const WAIT_MAX_MS = 30_000;
export const NO_LOGS = "No console errors, warnings, or failed requests since the last page load.";
export const NO_NEW_LOGS = "No new console errors, warnings, or failed requests since the last read.";

/** Whether a wait names anything to wait for. */
export const hasWait = (w: WaitFor | undefined): w is WaitFor => Boolean(w && (w.url || w.selector || w.text));

/** The wait's time budget in ms, clamped. */
export const waitBudget = (w: WaitFor): number => Math.min(WAIT_MAX_MS, Math.max(100, w.timeoutMs ?? WAIT_DEFAULT_MS));

/** An in-page expression: a promise of true once every part of the condition holds, false at the deadline. Polls every 100 ms. */
export function waitScript(w: WaitFor, ms: number): string {
  const checks: string[] = [];
  if (w.url) checks.push(`location.href.includes(${JSON.stringify(w.url)})`);
  if (w.selector) checks.push(`(() => { const el = document.querySelector(${JSON.stringify(w.selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  if (w.text) checks.push(`(document.body ? document.body.innerText : "").includes(${JSON.stringify(w.text)})`);
  const cond = checks.join(" && ") || "true";
  return `new Promise((done) => { const end = Date.now() + ${Math.round(ms)}; const tick = () => { let ok = false; try { ok = ${cond}; } catch (e) {} if (ok) done(true); else if (Date.now() >= end) done(false); else setTimeout(tick, 100); }; tick(); })`;
}

/** "URL contains "/dash" and text "Saved"": the condition as the agent wrote it. */
export function describeWait(w: WaitFor): string {
  return [w.url ? `URL contains "${w.url}"` : "", w.selector ? `"${w.selector}" visible` : "", w.text ? `text "${w.text}"` : ""].filter(Boolean).join(" and ");
}

/**
 * Wait in the page until the condition holds or its budget runs out. A navigation
 * mid-wait destroys the page's context and fails the evaluation; that's retried
 * on the new page until the deadline, so a redirect is waited through.
 */
export async function waitUntil(evaluate: (expression: string) => Promise<unknown>, w: WaitFor, now: () => number = Date.now): Promise<{ met: boolean; ms: number }> {
  const start = now();
  const deadline = start + waitBudget(w);
  for (;;) {
    const left = deadline - now();
    if (left <= 0) return { met: false, ms: now() - start };
    try {
      const r = await evaluate(waitScript(w, left));
      if (r === true || r === "true") return { met: true, ms: now() - start };
    } catch {
      // The page navigated mid-wait; try again on the new one.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The line an action's result gains from its wait: how long it took, or that it never held and where the page is. */
export function waitNote(w: WaitFor, r: { met: boolean; ms: number }, url: string): string {
  if (r.met) return `Waited ${r.ms} ms for ${describeWait(w)}.`;
  return `Waited ${(waitBudget(w) / 1000).toFixed(1)} s for ${describeWait(w)}: not met. Now at ${url}. Take a browser_snapshot to see the page.`;
}

/** The lines a narrowed snapshot adds under its URL line, so the agent knows the page isn't all there. */
export function scopeLines(opts: SnapshotOptions | undefined): string[] {
  return [opts?.selector ? `Scope: ${opts.selector}` : "", opts?.interactive ? "(interactive elements only)" : ""].filter(Boolean);
}

/** What a ref pointed at when it was handed out, to recognise it again. */
export interface RefPrint {
  kind: string;
  name: string;
}

/**
 * The error for a ref that's no longer on the page. With what it pointed at and
 * the current page's refs of the same kind and name, it names the likely
 * replacement instead of acting on it: the agent confirms the target.
 */
export function staleRefMessage(ref: string, print: RefPrint | undefined, matches: string[]): string {
  if (!print) return `No element ${ref} on the page. Take a new browser_snapshot; refs change when the page does.`;
  const what = `${print.kind} "${print.name}"`;
  if (matches.length === 1) return `${ref} (${what}) is no longer on the page. The page now has ${what} as [${matches[0]}]; use that ref if it's the one you meant.`;
  if (matches.length > 1) return `${ref} (${what}) is no longer on the page. The page now has ${matches.length} matches: ${matches.map((m) => `[${m}]`).join(", ")}. Take a browser_snapshot to pick one.`;
  return `${ref} (${what}) is no longer on the page. Take a new browser_snapshot.`;
}

/** The visible pane as a backend: the same calls the tools made on the controller directly. */
export function visibleBackend(c: BrowserController): BrowserBackend {
  return {
    kind: "visible",
    ensureOpen: () => c.ensureOpen(),
    open: async (url, device, wait) => {
      c.assertOpenAllowed();
      if (device) await c.setDevice(device);
      await c.page(url);
      c.announce("open", undefined);
      return hasWait(wait) ? c.waitFor(wait) : "";
    },
    snapshot: (opts) => c.snapshot(opts),
    click: (ref, wait) => c.click(ref, wait),
    type: (ref, text, submit, wait) => c.type(ref, text, submit, wait),
    evaluate: (expression) => c.evaluateForAgent(expression),
    query: (expression) => c.query(expression),
    logs: (clear, newOnly) => c.readLogs(clear, newOnly),
    screenshot: () => c.screenshot(),
  };
}

/** A backend as given, or the visible pane's controller wrapped as one. */
export function asBackend(b: BrowserBackend | BrowserController): BrowserBackend {
  return "kind" in b && (b.kind === "visible" || b.kind === "headless") ? (b as BrowserBackend) : visibleBackend(b as BrowserController);
}
