// What the agent's browser tools drive: the visible pane (BrowserController) or
// a headless session (AgentBrowserBackend). Both speak the same text: snapshots
// with `[eN]` refs, one-line action results, `[level] text` logs.

import type { DevicePreset } from "../../shared/types";
import type { BrowserController } from "./controller";

export interface BrowserBackend {
  readonly kind: "visible" | "headless";
  /** Ready to act: the pane opened (visible), nothing to do until the first open (headless). */
  ensureOpen(): Promise<void>;
  /** Load a URL, emulating a device first when given. */
  open(url: string, device?: DevicePreset): Promise<void>;
  snapshot(): Promise<string>;
  click(ref: string): Promise<string>;
  type(ref: string, text: string, submit: boolean): Promise<string>;
  evaluate(expression: string): Promise<string>;
  logs(clear: boolean): Promise<string>;
  screenshot(): Promise<{ path: string; png: Buffer }>;
  close?(): Promise<void>;
}

/** The visible pane as a backend: the same calls the tools made on the controller directly. */
export function visibleBackend(c: BrowserController): BrowserBackend {
  return {
    kind: "visible",
    ensureOpen: () => c.ensureOpen(),
    open: async (url, device) => {
      c.assertOpenAllowed();
      if (device) await c.setDevice(device);
      await c.page(url);
      c.announce("open", undefined);
    },
    snapshot: () => c.snapshot(),
    click: (ref) => c.click(ref),
    type: (ref, text, submit) => c.type(ref, text, submit),
    evaluate: (expression) => c.evaluateForAgent(expression),
    logs: (clear) => c.readLogs(clear),
    screenshot: () => c.screenshot(),
  };
}

/** A backend as given, or the visible pane's controller wrapped as one. */
export function asBackend(b: BrowserBackend | BrowserController): BrowserBackend {
  return "kind" in b && (b.kind === "visible" || b.kind === "headless") ? (b as BrowserBackend) : visibleBackend(b as BrowserController);
}
