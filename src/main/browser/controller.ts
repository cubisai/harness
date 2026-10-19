import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import { webContents as allWebContents } from "electron";
import type { BrowserLogEntry, DevicePreset } from "../../shared/types";
import { PICK_BINDING, type PickedElement, describePick, selectorFor, startPicker } from "./picker";
import { hasWait, NO_LOGS, NO_NEW_LOGS, staleRefMessage, waitNote, waitUntil, type RefPrint, type SnapshotOptions, type WaitFor } from "./backend";
import { collectPage, formatSnapshot, type PageSnapshot } from "./snapshot";
import { isAllowedUrl, normalizeUrl } from "./url";

export { isAllowedUrl } from "./url";

const MAX_LOGS = 200;
/** How many refs' kind and name are remembered, to explain a stale one. */
const MAX_PRINTS = 2000;

export type LogEntry = BrowserLogEntry;

/** The non-desktop viewports browser_open can emulate. */
export const DEVICE_PRESETS: Record<Exclude<DevicePreset, "desktop">, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
};

/**
 * Drives the browser pane's <webview> for the agent, through the Chrome
 * DevTools Protocol, so clicks and typing are real input events and console
 * errors and failed requests are captured as they happen.
 */
export class BrowserController {
  private wc: WebContents | null = null;
  private logs: LogEntry[] = [];
  /** Lines shifted off the front of a full buffer, and how far the agent has read (both counted since the page loaded). */
  private dropped = 0;
  private readUpTo = 0;
  /** The next ref number; never reset, so a ref is never handed to a second element. */
  private nextRef = 1;
  private prints = new Map<string, RefPrint>();
  private requests = new Map<string, string>();
  private waiters: ((wc: WebContents) => void)[] = [];
  /** Every screenshot saved this session, oldest first. */
  private shots: string[] = [];
  /** The emulated viewport. */
  device: DevicePreset = "desktop";
  /** True once the renderer's <webview> has attached this session. */
  enabled = false;
  /** The user took the pointer: acting tools refuse until they resume. Reads (snapshot, logs, screenshot) stay allowed. */
  paused = false;

  constructor(
    private requestOpen: (url?: string) => void,
    private screenshotDir: string,
    /** A picked element, described for the message box (null when picking was cancelled). */
    private onPicked: (text: string | null) => void = () => {},
    /** In-band notifications for the renderer: logs, screenshots, and the device. */
    private events: {
      onLog?(entry: LogEntry | null): void;
      onScreenshot?(path: string): void;
      onDevice?(device: DevicePreset): void;
      /** The agent acted in the pane: who is driving, and on what. */
      onAction?(action: "open" | "click" | "type" | "eval", ref: string | undefined, url: string): void;
    } = {},
    /** How long page() waits for the renderer to mount and attach the pane. */
    private opts: { openTimeoutMs?: number } = {},
  ) {}

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  private assertNotPaused(): void {
    if (this.paused) throw new Error("The user took over the browser pane and paused you. Ask them to press Resume in the pane, or carry on without the browser.");
  }

  /** browser_open's path into page(url): the pause check, exposed for the tool layer. */
  assertOpenAllowed(): void {
    this.assertNotPaused();
  }

  /** Announce an agent action (from the tool layer, where the page load happened). */
  announce(action: "open" | "click" | "type" | "eval", ref: string | undefined): void {
    this.events.onAction?.(action, ref, this.wc?.getURL() ?? "");
  }

  attach(webContentsId: number): void {
    const wc = allWebContents.fromId(webContentsId);
    if (!wc || wc === this.wc) return;
    this.detach();
    this.wc = wc;
    this.enabled = true;
    this.resetLogs();
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

  /** Append a log line, cap the buffer, and tell the renderer. */
  private push(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.shift();
      this.dropped++;
    }
    this.events.onLog?.(entry);
  }

  private resetLogs(): void {
    this.logs = [];
    this.dropped = 0;
    this.readUpTo = 0;
    this.events.onLog?.(null);
  }

  private onCdp(method: string, params: Record<string, unknown>): void {
    if (method === "Runtime.bindingCalled" && params.name === PICK_BINDING) {
      void this.finishPick(String(params.payload));
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type);
      if (type !== "error" && type !== "warning" && type !== "assert") return;
      const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
      const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
      if (text.includes("Electron Security Warning")) return; // Electron's own dev-only notice, not the page's
      this.push({ level: type === "warning" ? "warning" : "error", text: `console.${type}: ${text}` });
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      this.push({ level: "error", text: `uncaught: ${d?.exception?.description ?? d?.text ?? "exception"}` });
    } else if (method === "Network.requestWillBeSent") {
      const req = params.request as { url?: string; method?: string } | undefined;
      this.requests.set(String(params.requestId), `${req?.method ?? "GET"} ${req?.url ?? ""}`);
      if (this.requests.size > 500) this.requests.delete(this.requests.keys().next().value!);
    } else if (method === "Network.responseReceived") {
      const res = params.response as { status?: number; url?: string } | undefined;
      if (res?.status && res.status >= 400) {
        this.push({ level: "network", text: `${res.status} ${this.requests.get(String(params.requestId)) ?? res.url}` });
      }
    } else if (method === "Network.loadingFailed") {
      if (params.canceled) return;
      this.push({ level: "network", text: `failed (${String(params.errorText)}) ${this.requests.get(String(params.requestId)) ?? ""}` });
    }
  }

  /** Emulate a viewport in the pane; "desktop" clears any override. */
  async setDevice(preset: DevicePreset): Promise<void> {
    const wc = await this.page();
    if (preset === "desktop") await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    else await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", DEVICE_PRESETS[preset]);
    this.device = preset;
    this.events.onDevice?.(preset);
  }

  /** The pane's page, opening the pane first if needed. */
  async page(url?: string): Promise<WebContents> {
    if (this.wc && !this.wc.isDestroyed()) {
      if (url) await this.navigate(url);
      return this.wc;
    }
    const attached = new Promise<WebContents>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The browser pane didn't open.")), this.opts.openTimeoutMs ?? 15_000);
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

  /** Make sure the pane is mounted, opening it if the user hasn't, and let its first load settle. */
  async ensureOpen(): Promise<void> {
    if (this.wc && !this.wc.isDestroyed()) return;
    const wc = await this.page();
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

  async navigate(input: string): Promise<void> {
    const url = normalizeUrl(input);
    if (!isAllowedUrl(url)) throw new Error(`Not allowed in the browser pane: ${url}`);
    const wc = this.wc;
    if (!wc) throw new Error("The browser pane isn't open.");
    this.resetLogs();
    try {
      await wc.loadURL(url);
    } catch (err) {
      // A failed load still leaves an error page; report it rather than throw.
      this.push({ level: "network", text: `navigation failed: ${err instanceof Error ? err.message : String(err)}` });
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

  async snapshot(opts?: SnapshotOptions): Promise<string> {
    const wc = await this.page();
    return formatSnapshot(await this.collect(wc, opts), opts);
  }

  /** Run collectPage in the page, carrying the ref counter on and remembering what each ref points at. */
  private async collect(wc: WebContents, opts?: SnapshotOptions): Promise<PageSnapshot> {
    const snap = await this.evaluate<PageSnapshot>(wc, `(${collectPage.toString()})(400, ${this.nextRef}, ${JSON.stringify(opts?.selector ?? null)}, ${Boolean(opts?.interactive)})`);
    if (snap.next) this.nextRef = Math.max(this.nextRef, snap.next);
    for (const node of snap.nodes) {
      if (!node.ref) continue;
      this.prints.delete(node.ref);
      this.prints.set(node.ref, { kind: node.kind, name: node.name });
      if (this.prints.size > MAX_PRINTS) this.prints.delete(this.prints.keys().next().value!);
    }
    return snap;
  }

  private async locate(wc: WebContents, ref: string): Promise<{ x: number; y: number; label: string }> {
    const found = await this.evaluate<{ x: number; y: number; label: string; hidden?: boolean } | null>(
      wc,
      `(() => {
        const el = document.querySelector('[data-unskilled-ref="${ref.replace(/[^a-z0-9]/gi, "")}"]');
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.tagName).toString().trim().slice(0, 60);
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label, hidden: r.width === 0 && r.height === 0 };
      })()`,
    );
    if (found?.hidden) throw new Error(`${ref} is on the page but hidden now. Take a new browser_snapshot.`);
    if (!found) {
      // Gone: look at the page as it is now and name the likely replacement, without acting on it.
      const print = this.prints.get(ref);
      const matches = print ? (await this.collect(wc)).nodes.filter((n) => n.ref && n.kind === print.kind && n.name === print.name).map((n) => n.ref!) : [];
      throw new Error(staleRefMessage(ref, print, matches));
    }
    return found;
  }

  /** Wait in the pane until the condition holds or its budget runs out; the note for the action's result. */
  async waitFor(wait: WaitFor): Promise<string> {
    const wc = await this.page();
    const r = await waitUntil((expression) => this.evaluate(wc, expression), wait);
    return waitNote(wait, r, wc.getURL());
  }

  /** After an action: the agent's own condition when it gave one, else a short fixed settle. Returns the wait note, or "". */
  private async settle(wc: WebContents, wait?: WaitFor): Promise<string> {
    if (hasWait(wait)) return this.waitFor(wait);
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
    return "";
  }

  /** A brief ring over the element's rect, so the user sees what the agent just acted on. Cosmetic: never fails an action. */
  private async highlight(wc: WebContents, ref: string): Promise<void> {
    try {
      // The same lookup locate() uses: the ref is a data-unskilled-ref attribute.
      await this.evaluate(
        wc,
        `(() => {
          const el = document.querySelector('[data-unskilled-ref="${ref.replace(/[^a-z0-9]/gi, "")}"]');
          if (!el) return;
          const r = el.getBoundingClientRect();
          const ring = document.createElement("div");
          ring.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0a84ff;border-radius:4px;box-shadow:0 0 0 4px rgba(10,132,255,.25);transition:opacity .6s;"
            + "left:" + (r.left - 2) + "px;top:" + (r.top - 2) + "px;width:" + r.width + "px;height:" + r.height + "px";
          document.body.appendChild(ring);
          setTimeout(() => { ring.style.opacity = "0"; setTimeout(() => ring.remove(), 600); }, 900);
        })()`,
      );
    } catch {
      // A highlight is cosmetic; the action already happened.
    }
  }

  async click(ref: string, wait?: WaitFor): Promise<string> {
    this.assertNotPaused();
    const wc = await this.page();
    const { x, y, label } = await this.locate(wc, ref);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    const note = await this.settle(wc, wait);
    void this.highlight(wc, ref);
    this.events.onAction?.("click", ref, wc.getURL());
    return `Clicked ${ref} ("${label}"). Now at ${wc.getURL()}${note ? `\n${note}` : ""}`;
  }

  async type(ref: string, text: string, submit: boolean, wait?: WaitFor): Promise<string> {
    this.assertNotPaused();
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
    const note = await this.settle(wc, wait);
    void this.highlight(wc, ref);
    this.events.onAction?.("type", ref, wc.getURL());
    return `Typed into ${ref}${submit ? " and pressed Enter" : ""}. Now at ${wc.getURL()}${note ? `\n${note}` : ""}`;
  }

  async evaluateForAgent(expression: string): Promise<string> {
    this.assertNotPaused();
    const wc = await this.page();
    const value = await this.evaluate<unknown>(wc, expression);
    this.events.onAction?.("eval", undefined, wc.getURL());
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text === undefined ? "undefined" : text.length > 4000 ? `${text.slice(0, 4000)}… (truncated)` : text;
  }

  /** The page's log lines since it loaded, or with newOnly only those since the agent's last read. */
  async readLogs(clear: boolean, newOnly = false): Promise<string> {
    await this.page();
    const from = newOnly ? Math.max(0, this.readUpTo - this.dropped) : 0;
    const lines = this.logs.slice(from).map((l) => `[${l.level}] ${l.text}`);
    this.readUpTo = this.dropped + this.logs.length;
    if (clear) this.resetLogs();
    return lines.length ? lines.join("\n") : newOnly ? NO_NEW_LOGS : NO_LOGS;
  }

  /** The console buffer for the user's console tab: a copy that never clears it. */
  logsView(): LogEntry[] {
    return [...this.logs];
  }

  /** Let the user click an element in the pane; the result arrives through onPicked. */
  async startPick(): Promise<void> {
    const wc = await this.page();
    await this.evaluate(wc, `(${startPicker.toString()})(${JSON.stringify(PICK_BINDING)}, ${selectorFor.toString()})`);
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
        path = join(this.screenshotDir, `element-${new Date().toISOString().replace(/[:.]/g, "-")}.png`.toLowerCase());
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
    const path = join(this.screenshotDir, `browser-${new Date().toISOString().replace(/[:.]/g, "-")}.png`.toLowerCase());
    writeFileSync(path, png);
    this.shots.push(path);
    this.events.onScreenshot?.(path);
    return { path, png };
  }

  /** The screenshots saved this session, oldest first. */
  listScreenshots(): string[] {
    return [...this.shots];
  }
}
