import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { webContents as allWebContents } from "electron";
import { PICK_BINDING, type PickedElement, describePick, startPicker } from "./picker";
import { collectPage, formatSnapshot, type PageSnapshot } from "./snapshot";
import { isAllowedUrl, normalizeUrl } from "./url";

export { isAllowedUrl } from "./url";

const MAX_LOGS = 200;

export interface LogEntry {
  level: "error" | "warning" | "network";
  text: string;
}

/**
 * Drives the browser pane's <webview> for the agent, through the Chrome
 * DevTools Protocol, so clicks and typing are real input events and console
 * errors and failed requests are captured as they happen.
 */
export class BrowserController {
  private wc: WebContents | null = null;
  private logs: LogEntry[] = [];
  private requests = new Map<string, string>();
  private waiters: ((wc: WebContents) => void)[] = [];
  /** True once the user has opened the pane this session: only then do the agent's browser tools exist. */
  enabled = false;

  constructor(
    private requestOpen: (url?: string) => void,
    private screenshotDir: string,
    /** A picked element, described for the message box (null when picking was cancelled). */
    private onPicked: (text: string | null) => void = () => {},
  ) {}

  attach(webContentsId: number): void {
    const wc = allWebContents.fromId(webContentsId);
    if (!wc || wc === this.wc) return;
    this.detach();
    this.wc = wc;
    this.enabled = true;
    this.logs = [];
    try {
      wc.debugger.attach("1.3");
    } catch {
      // Already attached (e.g. DevTools open): events still arrive.
    }
    wc.debugger.on("message", (_e, method, params) => this.onCdp(method, params as Record<string, unknown>));
    void wc.debugger.sendCommand("Runtime.enable").catch(() => {});
    void wc.debugger.sendCommand("Network.enable").catch(() => {});
    void wc.debugger.sendCommand("Log.enable").catch(() => {});
    // Typing needs a focused page; the pane may be behind another window, or hidden.
    void wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    void wc.debugger.sendCommand("Runtime.addBinding", { name: PICK_BINDING }).catch(() => {});
    wc.setWindowOpenHandler(({ url }) => {
      // Popups open in the pane itself, so the agent never loses the page.
      if (isAllowedUrl(url)) void wc.loadURL(url);
      return { action: "deny" };
    });
    wc.once("destroyed", () => {
      if (this.wc === wc) this.wc = null;
    });
    for (const w of this.waiters.splice(0)) w(wc);
  }

  detach(): void {
    if (this.wc && !this.wc.isDestroyed()) {
      try {
        this.wc.debugger.detach();
      } catch {
        // not attached
      }
    }
    this.wc = null;
  }

  private onCdp(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.bindingCalled" && params.name === PICK_BINDING) {
      void this.finishPick(String(params.payload));
      return;
    }
    const push = (entry: LogEntry) => {
      this.logs.push(entry);
      if (this.logs.length > MAX_LOGS) this.logs.shift();
    };
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type);
      if (type !== "error" && type !== "warning" && type !== "assert") return;
      const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
      if (text.includes("Electron Security Warning")) return; // Electron's own dev-only notice, not the page's
      push({ level: type === "warning" ? "warning" : "error", text: `console.${type}: ${text}` });
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      push({ level: "error", text: `uncaught: ${d?.exception?.description ?? d?.text ?? "exception"}` });
    } else if (method === "Network.requestWillBeSent") {
      const req = params.request as { url?: string; method?: string } | undefined;
      this.requests.set(String(params.requestId), `${req?.method ?? "GET"} ${req?.url ?? ""}`);
      if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value!);
    } else if (method === "Network.responseReceived") {
      const res = params.response as { status?: number; url?: string } | undefined;
      if (res?.status && res.status >= 400) {
        push({ level: "network", text: `${res.status} ${this.requests.get(String(params.requestId)) ?? res.url}` });
      }
    } else if (method === "Network.loadingFailed") {
      if (params.canceled) return;
      push({ level: "network", text: `failed (${String(params.errorText)}) ${this.requests.get(String(params.requestId)) ?? ""}` });
    }
  }

  /** The pane's page, opening the pane first if needed. */
  async page(url?: string): Promise<WebContents> {
    if (this.wc && !this.wc.isDestroyed()) {
      if (url) await this.navigate(url);
      return this.wc;
    }
    const attached = new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The browser pane didn't open.")), 15_000);
      this.waiters.push((wc) => {
        clearTimeout(timer);
        resolve(wc);
      });
    });
    this.requestOpen(url);
    const wc = await attached;
    if (url && wc.getURL() !== url) await this.navigate(url);
    return wc;
  }

  async navigate(input: string): Promise<void> {
    const url = normalizeUrl(input);
    if (!isAllowedUrl(url)) throw new Error(`Not allowed in the browser pane: ${url}`);
    const wc = this.wc;
    if (!wc) throw new Error("The browser pane isn't open.");
    this.logs = [];
    try {
      await wc.loadURL(url);
    } catch (err) {
      // A failed load still leaves an error page; report it rather than throw.
      this.logs.push({ level: "network", text: `navigation failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async evaluate<T>(wc: WebContents, expression: string): Promise<T> {
    const res = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluation failed");
    }
    return res.result?.value as T;
  }

  async snapshot(): Promise<string> {
    const wc = await this.page();
    const snap = await this.evaluate<PageSnapshot>(wc, `(${collectPage.toString()})(400)`);
    return formatSnapshot(snap);
  }

  private async locate(wc: WebContents, ref: string): Promise<{ x: number; y: number; label: string }> {
    const found = await this.evaluate<{ x: number; y: number; label: string } | null>(
      wc,
      `(() => {
        const el = document.querySelector('[data-unskilled-ref="${ref.replace(/[^a-z0-9]/gi, "")}"]');
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.tagName).toString().trim().slice(0, 60);
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label };
      })()`,
    );
    if (!found) throw new Error(`No element ${ref} on the page. Take a new browser_snapshot; refs change when the page does.`);
    return found;
  }

  private async settle(wc: WebContents): Promise<void> {
    // Let navigation or re-rendering triggered by the action start and finish.
    await new Promise((r) => setTimeout(r, 250));
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        wc.once("did-stop-loading", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async click(ref: string): Promise<string> {
    const wc = await this.page();
    const { x, y, label } = await this.locate(wc, ref);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await this.settle(wc);
    return `Clicked ${ref} ("${label}"). Now at ${wc.getURL()}`;
  }

  async type(ref: string, text: string, submit: boolean): Promise<string> {
    const wc = await this.page();
    await this.locate(wc, ref);
    const sel = `document.querySelector('[data-unskilled-ref="${ref.replace(/[^a-z0-9]/gi, "")}"]')`;
    await this.evaluate(wc, `(() => { const el = ${sel}; el.focus(); if (el.select) el.select(); })()`);
    // Real text input first, so key-driven widgets see it; if the page didn't
    // take it (an unfocused window drops it), set the value the way a
    // framework-controlled field expects: native setter, then input/change.
    await wc.debugger.sendCommand("Input.insertText", { text });
    await this.evaluate(
      wc,
      `(() => {
        const el = ${sel};
        const current = el.isContentEditable ? el.textContent : el.value;
        if (current === ${JSON.stringify(text)}) return;
        if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
        else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(text)});
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
    if (submit) {
      await this.evaluate(
        wc,
        `(() => {
          const el = ${sel};
          const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
          const go = el.dispatchEvent(new KeyboardEvent("keydown", opts));
          el.dispatchEvent(new KeyboardEvent("keyup", opts));
          if (go && el.form) el.form.requestSubmit();
        })()`,
      );
    }
    await this.settle(wc);
    return `Typed into ${ref}${submit ? " and pressed Enter" : ""}. Now at ${wc.getURL()}`;
  }

  async evaluateForAgent(expression: string): Promise<string> {
    const wc = await this.page();
    const value = await this.evaluate<unknown>(wc, expression);
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text === undefined ? "undefined" : text.length > 4000 ? `${text.slice(0, 4000)}… (truncated)` : text;
  }

  async readLogs(clear: boolean): Promise<string> {
    await this.page();
    const lines = this.logs.map((l) => `[${l.level}] ${l.text}`);
    if (clear) this.logs = [];
    return lines.length ? lines.join("\n") : "No console errors, warnings, or failed requests since the last page load.";
  }

  /** Let the user click an element in the pane; the result arrives through onPicked. */
  async startPick(): Promise<void> {
    const wc = await this.page();
    await this.evaluate(wc, `(${startPicker.toString()})(${JSON.stringify(PICK_BINDING)})`);
    wc.focus();
  }

  private pickWaiters: ((text: string | null) => void)[] = [];

  /** Resolves with the next pick's description (for the smoke test). */
  nextPick(): Promise<string | null> {
    return new Promise((resolve) => this.pickWaiters.push(resolve));
  }

  private emitPick(text: string | null): void {
    this.onPicked(text);
    for (const w of this.pickWaiters.splice(0)) w(text);
  }

  private async finishPick(payload: string): Promise<void> {
    const picked = JSON.parse(payload) as PickedElement | null;
    const wc = this.wc;
    if (!picked || !wc) {
      this.emitPick(null);
      return;
    }
    let path: string | undefined;
    try {
      const r = picked.rect;
      if (r.width >= 1 && r.height >= 1) {
        const image = await wc.capturePage({
          x: Math.max(0, Math.floor(r.x)),
          y: Math.max(0, Math.floor(r.y)),
          width: Math.ceil(r.width),
          height: Math.ceil(r.height),
        });
        mkdirSync(this.screenshotDir, { recursive: true });
        path = join(this.screenshotDir, `element-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
        writeFileSync(path, image.toPNG());
      }
    } catch {
      // A screenshot is a bonus; the description still goes through.
    }
    this.emitPick(describePick(picked, wc.getURL(), path));
  }

  async screenshot(): Promise<{ path: string; png: Buffer }> {
    const wc = await this.page();
    const image = await wc.capturePage();
    const png = image.toPNG();
    mkdirSync(this.screenshotDir, { recursive: true });
    const path = join(this.screenshotDir, `browser-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(path, png);
    return { path, png };
  }
}
