/// <reference lib="dom" />
import type { PickedElement } from "../browser/picker";

/** Messages the design page sends up to the canvas. */
export type BridgeMessage =
  | { source: "cubiq-design"; type: "ready"; path?: string }
  | { source: "cubiq-design"; type: "scroll"; x: number; y: number }
  | { source: "cubiq-design"; type: "picked"; element: PickedElement }
  | { source: "cubiq-design"; type: "pick-cancel" };

/** Messages the canvas sends down into the design page. */
export type CanvasMessage =
  | { source: "cubiq-canvas"; type: "restore-scroll"; x: number; y: number }
  | { source: "cubiq-canvas"; type: "pick"; on: boolean };

/**
 * The canvas bridge injected into a design page: scroll reporting, scroll
 * restore, and element picking. Runs inside the page (serialized with
 * toString), so it must not reference anything outside its own parameters.
 */
export function designBridge(selectorFor: (el: Element) => string): void {
  const post = (type: string, data?: Record<string, unknown>): void => {
    parent.postMessage({ source: "cubiq-design", type, ...(data ?? {}) }, "*");
  };

  const announceReady = (): void => post("ready", { path: location.pathname });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  else announceReady();

  // Scroll: at most one report per 100 ms, with a trailing report for the last position.
  let scrollAt = 0;
  let scrollTimer: number | null = null;
  const emitScroll = (): void => {
    scrollTimer = null;
    scrollAt = Date.now();
    post("scroll", { x: scrollX, y: scrollY });
  };
  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer !== null) return;
      const wait = 100 - (Date.now() - scrollAt);
      if (wait <= 0) emitScroll();
      else scrollTimer = window.setTimeout(emitScroll, wait);
    },
    true,
  );

  // Pick mode, mirroring the browser pane's picker but reporting through postMessage.
  let stopPick: (() => void) | null = null;
  const startPick = (): void => {
    stopPick?.();
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0B0D10;outline:1px solid #F7F8FA;background:rgba(11,13,16,.06);border-radius:3px;display:none";
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,Menlo,monospace;background:#0B0D10;color:#F7F8FA;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    document.documentElement.append(box, tip);

    let current: Element | null = null;
    const onMove = (e: MouseEvent): void => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      tip.textContent = selectorFor(el);
      Object.assign(tip.style, { display: "block", left: `${Math.max(4, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
    };
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent): void => {
      swallow(e);
      const el = current;
      stop();
      if (!el) return;
      const r = el.getBoundingClientRect();
      const element: PickedElement = {
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        html: el.outerHTML.slice(0, 1200),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      };
      post("picked", { element });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      swallow(e);
      stop();
      post("pick-cancel");
    };
    const stop = (): void => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("mouseup", swallow, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      tip.remove();
      if (stopPick === stop) stopPick = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("mouseup", swallow, true);
    document.addEventListener("keydown", onKey, true);
    stopPick = stop;
  };

  // Commands from the canvas.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return;
    const data = event.data as { source?: unknown; type?: unknown; x?: unknown; y?: unknown; on?: unknown } | null;
    if (!data || data.source !== "cubiq-canvas") return;
    if (data.type === "restore-scroll") {
      const x = typeof data.x === "number" ? data.x : 0;
      const y = typeof data.y === "number" ? data.y : 0;
      const restore = (): void => window.scrollTo(x, y);
      restore();
      if (document.readyState === "loading") window.addEventListener("load", restore, { once: true });
    } else if (data.type === "pick") {
      if (data.on) startPick();
      else stopPick?.();
    }
  });
}

/** The bridge as one script body, embedding the page-side selector helper. */
export function bridgeScript(selectorFor: (el: Element) => string): string {
  return `(${designBridge.toString()})(${selectorFor.toString()});`;
}
