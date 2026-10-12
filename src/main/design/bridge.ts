/// <reference lib="dom" />

/** The shape a design page element is described as when reported to the canvas. */
export interface DescribedElement {
  id?: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  path: { label: string; selector: string }[];
}

/** A reference the canvas sends down for the design page to resolve back to an element. */
export interface SelectionTarget {
  id?: string;
  selector: string;
  tag: string;
  text: string;
}

/** Messages the design page sends up to the canvas. */
export type BridgeMessage =
  | { source: "cubiq-design"; type: "ready"; path?: string }
  | { source: "cubiq-design"; type: "scroll"; x: number; y: number }
  | { source: "cubiq-design"; type: "selection"; elements: unknown[]; lost: number }
  | { source: "cubiq-design"; type: "pick-cancel" }
  | { source: "cubiq-design"; type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> };

/** Messages the canvas sends down into the design page. */
export type CanvasMessage =
  | { source: "cubiq-canvas"; type: "restore-scroll"; x: number; y: number }
  | { source: "cubiq-canvas"; type: "pick"; on: boolean }
  | { source: "cubiq-canvas"; type: "set-selection"; targets: { id?: string; selector: string; tag: string; text: string }[] }
  | { source: "cubiq-canvas"; type: "clear-selection" }
  | { source: "cubiq-canvas"; type: "set-tweak"; attr?: string; var?: string; value: string };

/** Snap an element to its nearest interactive ancestor, or itself when there is none. */
export function snapTarget(el: Element): Element {
  return el.closest("a, button, [role=button], input, select, textarea, label, summary") ?? el;
}

/** Describe an element for the canvas: identity, selector, text, html, rect and ancestor path. */
export function describeElement(el: Element, selectorFor: (el: Element) => string): DescribedElement {
  const rawId = el.getAttribute("data-agent-id");
  const id = rawId && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rawId) ? rawId : undefined;
  const r = el.getBoundingClientRect();
  const path: { label: string; selector: string }[] = [];
  let cur: Element | null = el.parentElement;
  while (cur && cur.tagName !== "BODY" && cur.tagName !== "HTML" && path.length < 4) {
    const ancestorId = cur.getAttribute("data-agent-id");
    const good = ancestorId && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(ancestorId) ? ancestorId : null;
    const tag = cur.tagName.toLowerCase();
    path.push({ label: good ? `${tag} ${good}` : tag, selector: selectorFor(cur) });
    cur = cur.parentElement;
  }
  path.reverse();
  const described: DescribedElement = {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    text: ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    html: el.outerHTML.slice(0, 1200),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    path,
  };
  if (id) described.id = id;
  return described;
}

/** Resolve a canvas reference back to the element it names, or `null` when it no longer matches. */
export function resolveTarget(doc: Document, target: SelectionTarget): Element | null {
  if (target.id && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(target.id)) {
    const byId = doc.querySelectorAll(`[data-agent-id="${target.id}"]`);
    if (byId.length === 1) return byId[0] ?? null;
  }
  let el: Element | null = null;
  try {
    el = doc.querySelector(target.selector);
  } catch {
    el = null;
  }
  if (!el || el.tagName.toLowerCase() !== target.tag) return null;
  if (target.text !== "") {
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text.startsWith(target.text.slice(0, 80))) return null;
  }
  return el;
}

/**
 * The canvas bridge injected into a design page: scroll reporting, scroll
 * restore, and a persistent element selection. Runs inside the page (serialized
 * with toString), so it must not reference anything outside its own parameters.
 */
export function designBridge(
  selectorFor: (el: Element) => string,
  describeElement: (el: Element, selectorFor: (el: Element) => string) => DescribedElement,
  snapTarget: (el: Element) => Element,
  resolveTarget: (doc: Document, target: SelectionTarget) => Element | null,
): void {
  const post = (type: string, data?: Record<string, unknown>): void => {
    parent.postMessage({ source: "cubiq-design", type, ...(data ?? {}) }, "*");
  };

  const reportTweaks = (): void => {
    const el = document.getElementById("cubiq-tweaks");
    if (!el) return;
    const text = (el.textContent || "").slice(0, 8000);
    const root = document.documentElement;
    const attrs: Record<string, string> = {};
    const names = root.getAttributeNames();
    for (let i = 0; i < names.length && Object.keys(attrs).length < 32; i++) {
      const name = names[i];
      if (name && name.indexOf("data-") === 0) attrs[name] = (root.getAttribute(name) || "").slice(0, 64);
    }
    const vars: Record<string, string> = {};
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const box = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const list = Array.isArray(parsed) ? parsed : Array.isArray(box?.tweaks) ? (box?.tweaks as unknown[]) : [];
    for (let i = 0; i < list.length && Object.keys(vars).length < 12; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as Record<string, unknown>).var;
      if (typeof name !== "string" || !/^--[a-z0-9-]{1,48}$/i.test(name)) continue;
      vars[name] = getComputedStyle(root).getPropertyValue(name).trim().slice(0, 64);
    }
    post("tweaks", { manifest: text, attrs, vars });
  };

  const announceReady = (): void => {
    post("ready", { path: location.pathname });
    reportTweaks();
  };
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

  // Persistent selection: at most 8 elements, each drawn with an outline kept in
  // place by a requestAnimationFrame loop that runs only while something is selected.
  const MAX_SELECTION = 8;
  let selected: Element[] = [];
  const outlines = new Map<Element, HTMLDivElement>();
  let frame = 0;
  const step = (): void => {
    frame = selected.length > 0 ? requestAnimationFrame(step) : 0;
    outlines.forEach((outline, el) => {
      if (!el.isConnected) {
        outline.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
  };
  const redraw = (): void => {
    outlines.forEach((outline) => outline.remove());
    outlines.clear();
    for (const el of selected) {
      const outline = document.createElement("div");
      outline.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #0B0D10;outline:1px solid #F7F8FA;border-radius:3px";
      document.documentElement.append(outline);
      outlines.set(el, outline);
    }
    if (frame === 0 && selected.length > 0) frame = requestAnimationFrame(step);
  };
  const report = (lost: number): void => {
    post("selection", { elements: selected.map((el) => describeElement(el, selectorFor)), lost });
  };

  // Select mode: a hover highlight plus click/keyboard selection; the page never
  // sees the gestures. The mode stays on across clicks until Esc leaves it.
  let stopSelect: (() => void) | null = null;
  let hovered: Element | null = null;
  const startSelect = (): void => {
    if (stopSelect) return;
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0B0D10;outline:1px solid #F7F8FA;background:rgba(11,13,16,.06);border-radius:3px;display:none";
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,Menlo,monospace;background:#0B0D10;color:#F7F8FA;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    document.documentElement.append(box, tip);

    const onMove = (e: MouseEvent): void => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      const target = snapTarget(el);
      hovered = target;
      const r = target.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const id = target.getAttribute("data-agent-id");
      const tag = target.tagName.toLowerCase();
      tip.textContent = id ? `${tag} ${id}` : tag;
      Object.assign(tip.style, { display: "block", left: `${Math.max(4, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
    };
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent): void => {
      swallow(e);
      const t = hovered;
      if (!t) return;
      if (t === document.body || t === document.documentElement) {
        selected = [];
      } else if (e.shiftKey || e.metaKey || e.ctrlKey) {
        if (selected.indexOf(t) >= 0) selected = selected.filter((el) => el !== t);
        else if (selected.length < MAX_SELECTION) selected = [...selected, t];
      } else {
        selected = [t];
      }
      redraw();
      report(0);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      swallow(e);
      if (selected.length > 0) {
        selected = [];
        redraw();
        report(0);
      } else {
        stop();
        post("pick-cancel");
      }
    };
    const stop = (): void => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousedown", swallow, true);
      document.removeEventListener("mouseup", swallow, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      tip.remove();
      hovered = null;
      if (stopSelect === stop) stopSelect = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", swallow, true);
    document.addEventListener("mouseup", swallow, true);
    document.addEventListener("keydown", onKey, true);
    stopSelect = stop;
  };

  // Commands from the canvas.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return;
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      x?: unknown;
      y?: unknown;
      on?: unknown;
      attr?: unknown;
      var?: unknown;
      value?: unknown;
      targets?: unknown;
    } | null;
    if (!data || data.source !== "cubiq-canvas") return;
    if (data.type === "restore-scroll") {
      const x = typeof data.x === "number" ? data.x : 0;
      const y = typeof data.y === "number" ? data.y : 0;
      const restore = (): void => window.scrollTo(x, y);
      restore();
      if (document.readyState === "loading") window.addEventListener("load", restore, { once: true });
    } else if (data.type === "pick") {
      if (data.on) startSelect();
      else stopSelect?.();
    } else if (data.type === "set-selection") {
      const targets = data.targets;
      if (!Array.isArray(targets)) return;
      const list = targets as unknown[];
      const resolved: Element[] = [];
      let taken = 0;
      for (const entry of list) {
        if (taken >= MAX_SELECTION) break;
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.selector !== "string" || typeof item.tag !== "string" || typeof item.text !== "string") continue;
        taken++;
        const target: SelectionTarget = { selector: item.selector, tag: item.tag, text: item.text };
        if (typeof item.id === "string") target.id = item.id;
        const el = resolveTarget(document, target);
        if (el && resolved.indexOf(el) < 0) resolved.push(el);
      }
      selected = resolved;
      redraw();
      report(list.length - resolved.length);
    } else if (data.type === "clear-selection") {
      selected = [];
      redraw();
      report(0);
    } else if (data.type === "set-tweak") {
      const value = typeof data.value === "string" && data.value.length <= 64 ? data.value : null;
      if (value === null) return;
      if (typeof data.attr === "string" && /^data-[a-z0-9-]{1,40}$/.test(data.attr) && /^[a-z0-9-]*$/i.test(value)) {
        document.documentElement.setAttribute(data.attr, value);
      } else if (typeof data.var === "string" && /^--[a-z0-9-]{1,48}$/i.test(data.var) && /^[#a-z0-9.%-]*$/i.test(value)) {
        document.documentElement.style.setProperty(data.var, value);
      }
    }
  });
}

/** The bridge as one script body, embedding the page-side helpers it needs. */
export function bridgeScript(selectorFor: (el: Element) => string): string {
  return `(${designBridge.toString()})(${selectorFor.toString()}, ${describeElement.toString()}, ${snapTarget.toString()}, ${resolveTarget.toString()});`;
}
