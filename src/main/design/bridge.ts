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
  /** The element's computed style, limited to the inspector's keys (see STYLE_KEYS in shared/selection.ts). */
  style?: Record<string, string>;
}

/** A reference the canvas sends down for the design page to resolve back to an element. */
export interface SelectionTarget {
  id?: string;
  selector: string;
  tag: string;
  text: string;
}

/** One node of a design page's outline (layer tree), as reported to the canvas. */
export interface OutlineNode {
  id?: string;
  tag: string;
  cls: string;
  selector: string;
  label: string;
  depth: number;
}

/** Messages the design page sends up to the canvas. */
export type BridgeMessage =
  | { source: "cubiq-design"; type: "ready"; path?: string }
  | { source: "cubiq-design"; type: "scroll"; x: number; y: number }
  | { source: "cubiq-design"; type: "selection"; elements: unknown[]; lost: number }
  | { source: "cubiq-design"; type: "text-edit"; id: string; before: string; after: string }
  | { source: "cubiq-design"; type: "edit-refused"; reason: string }
  | { source: "cubiq-design"; type: "pick-cancel" }
  | { source: "cubiq-design"; type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> }
  | { source: "cubiq-design"; type: "pins"; missing: number[] }
  | { source: "cubiq-design"; type: "outline"; nodes: OutlineNode[] }
  | { source: "cubiq-design"; type: "anchor"; rect: Rect | null; bounds?: Rect; editable?: boolean; view?: { width: number; height: number } }
  | { source: "cubiq-design"; type: "marks"; strokes: { x: number; y: number }[][]; notes: { x: number; y: number; text: string; near: string }[] }
  | { source: "cubiq-design"; type: "repick-ask"; label: string };

/** A box in the frame's viewport, in CSS pixels. */
type Rect = { x: number; y: number; width: number; height: number };

/** Messages the canvas sends down into the design page. */
export type CanvasMessage =
  | { source: "cubiq-canvas"; type: "restore-scroll"; x: number; y: number }
  | { source: "cubiq-canvas"; type: "pick"; on: boolean; edit?: boolean }
  | { source: "cubiq-canvas"; type: "set-selection"; targets: { id?: string; selector: string; tag: string; text: string }[] }
  | { source: "cubiq-canvas"; type: "clear-selection" }
  | { source: "cubiq-canvas"; type: "set-tweak"; attr?: string; var?: string; value: string }
  /** A device frame is shown around the page: hide its scrollbars (it still scrolls), like a phone or tablet does. */
  | { source: "cubiq-canvas"; type: "device-chrome"; on: boolean }
  | { source: "cubiq-canvas"; type: "set-pins"; pins: { n: number; target: { id?: string; selector: string; tag: string; text: string } }[] }
  | { source: "cubiq-canvas"; type: "preview-style"; target: { id?: string; selector: string; tag: string; text: string }; prop: string; value: string }
  | { source: "cubiq-canvas"; type: "clear-preview" }
  | { source: "cubiq-canvas"; type: "outline" }
  /** A Layers row is hovered: outline that element on the page (null clears it). Leaves the selection alone. */
  | { source: "cubiq-canvas"; type: "hover-layer"; target: { id?: string; selector: string; tag: string; text: string } | null }
  | { source: "cubiq-canvas"; type: "clear-marks" }
  | { source: "cubiq-canvas"; type: "repick"; ok: boolean }
  | { source: "cubiq-canvas"; type: "edit-selected" };

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
  // The element's computed style, for the inspector. Keep these keys in step with STYLE_KEYS in shared/selection.ts
  // (this function is serialized into the page, so it cannot import them).
  try {
    const computed = getComputedStyle(el);
    const keys = [
      "display",
      "flexDirection",
      "flexWrap",
      "justifyContent",
      "alignItems",
      "gap",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "width",
      "height",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "color",
      "backgroundColor",
      "borderRadius",
      "borderWidth",
      "borderColor",
      "opacity",
      "boxShadow",
    ];
    const style: Record<string, string> = {};
    for (const key of keys) {
      const cssName = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      style[key] = computed.getPropertyValue(cssName).trim().slice(0, 120);
    }
    described.style = style;
  } catch {
    // No computed style here (a non-DOM host): describe the element without it.
  }
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

/** A design page element's own text when it is a leaf with a stable id, or why it cannot be edited in place. */
export function editableText(el: Element): { ok: true; id: string; text: string } | { ok: false; reason: string } {
  const id = el.getAttribute("data-agent-id");
  if (!id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) return { ok: false, reason: "That text has no stable id; ask the agent to change it." };
  if (el.children.length > 0) return { ok: false, reason: "That element holds more than text; ask the agent to change it." };
  return { ok: true, id, text: el.textContent ?? "" };
}

/**
 * Flatten a page's elements into an outline (layer tree), depth-first in document order. `root` itself is not a
 * node; its children start at depth 0. At most 400 nodes and 8 levels of depth are reported; an `<svg>` is a leaf. A node
 * with no text of its own is labelled by its aria-label, alt, title or placeholder. Runs inside the page
 * (passed in with toString), so it must not reference anything outside its own parameters.
 */
export function outlineOf(root: Element, selectorFor: (el: Element) => string): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const walk = (el: Element, depth: number): void => {
    if (nodes.length >= 400 || depth > 8) return;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "link", "meta", "noscript", "template", "br"].indexOf(tag) < 0) {
      const rawId = el.getAttribute("data-agent-id");
      const cls = (el.getAttribute("class") || "")
        .split(/\s+/)
        .filter((name) => name !== "")
        .slice(0, 2)
        .join(".")
        .slice(0, 60);
      let own = "";
      for (let i = 0; i < el.childNodes.length; i++) {
        const text = el.childNodes[i];
        if (text && text.nodeType === 3) own += text.textContent || "";
      }
      // No text of its own: the name a screen reader would read (an icon button, an image, an input).
      if (own.trim() === "") own = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
      const node: OutlineNode = { tag, cls, selector: selectorFor(el), label: own.replace(/\s+/g, " ").trim().slice(0, 40), depth };
      if (rawId && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rawId)) node.id = rawId;
      nodes.push(node);
    }
    // An SVG is one layer: its paths and groups are drawing, not structure.
    if (tag === "svg") return;
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      if (child) walk(child, depth + 1);
    }
  };
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child) walk(child, 0);
  }
  return nodes;
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
  editableText: (el: Element) => { ok: true; id: string; text: string } | { ok: false; reason: string },
  outlineOf: (root: Element, selectorFor: (el: Element) => string) => OutlineNode[],
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

  const reportOutline = (): void => {
    if (document.body) post("outline", { nodes: outlineOf(document.body, selectorFor) });
  };

  // The Layers rail's hover: a dashed box over the hovered row's element, kept on it through scrolls.
  let layerBox: HTMLDivElement | null = null;
  let layerEl: Element | null = null;
  const placeLayerBox = (): void => {
    if (!layerBox || !layerEl) return;
    const r = layerEl.getBoundingClientRect();
    Object.assign(layerBox.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const showLayerHover = (el: Element | null): void => {
    layerEl = el;
    if (!el) {
      if (layerBox) layerBox.style.display = "none";
      return;
    }
    if (!layerBox) {
      layerBox = document.createElement("div");
      layerBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:1.5px dashed #0B0D10;outline:1px solid rgba(247,248,250,.9);background:rgba(11,13,16,.05);border-radius:3px;display:none";
      document.documentElement.append(layerBox);
      window.addEventListener("scroll", placeLayerBox, { passive: true, capture: true });
      window.addEventListener("resize", placeLayerBox);
    }
    placeLayerBox();
  };

  const announceReady = (): void => {
    post("ready", { path: location.pathname });
    reportTweaks();
    reportOutline();
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
  // place by a requestAnimationFrame loop that also positions comment pins and
  // runs only while something is selected or pinned.
  const MAX_SELECTION = 8;
  let selected: Element[] = [];
  const outlines = new Map<Element, HTMLDivElement>();
  // Comment pins: numbered dots dropped by the canvas onto resolved elements.
  let pins: { n: number; el: Element; dot: HTMLDivElement }[] = [];
  let frame = 0;
  const step = (): void => {
    frame = selected.length > 0 || pins.length > 0 ? requestAnimationFrame(step) : 0;
    outlines.forEach((outline, el) => {
      if (!el.isConnected) {
        outline.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    for (const pin of pins) {
      if (!pin.el.isConnected) {
        pin.dot.style.display = "none";
        continue;
      }
      const r = pin.el.getBoundingClientRect();
      Object.assign(pin.dot.style, { display: "block", left: `${Math.max(2, r.left - 10)}px`, top: `${Math.max(2, r.top - 10)}px` });
    }
    postAnchor();
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
    // Marks belong to the one picked element: any other selection lets them go.
    const one = selected.length === 1 ? (selected[0] ?? null) : null;
    if (one !== markedFor) clearMarks();
    markedFor = one;
    editableSel = one !== null && editableText(one).ok;
    if (frame === 0 && (selected.length > 0 || pins.length > 0)) frame = requestAnimationFrame(step);
    if (selected.length === 0) postAnchor();
  };

  // The element bar's anchor: the selection's box (and, for the capture, its box plus the marks and notes), in the
  // frame's viewport. Sent only when it changes; the selection loop above calls this every frame.
  let anchorKey = "";
  let editableSel = false;
  const postAnchor = (): void => {
    const live = selected.filter((el) => el.isConnected);
    if (!live.length) {
      if (anchorKey !== "none") {
        anchorKey = "none";
        post("anchor", { rect: null });
      }
      return;
    }
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const el of live) {
      const q = el.getBoundingClientRect();
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
    const rect = { x: l, y: t, width: r - l, height: b - t };
    for (const s of strokes) {
      for (const p of s.points) {
        l = Math.min(l, p.x - scrollX - 6);
        t = Math.min(t, p.y - scrollY - 6);
        r = Math.max(r, p.x - scrollX + 6);
        b = Math.max(b, p.y - scrollY + 6);
      }
    }
    for (const n of notes) {
      const q = n.el.getBoundingClientRect();
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
    const bounds = { x: l, y: t, width: r - l, height: b - t };
    const editable = live.length === 1 && editableSel;
    const key = [rect.x, rect.y, rect.width, rect.height, bounds.x, bounds.y, bounds.width, bounds.height, innerWidth, innerHeight].map(Math.round).join(",") + (editable ? "e" : "");
    if (key === anchorKey) return;
    anchorKey = key;
    post("anchor", { rect, bounds, editable, view: { width: innerWidth, height: innerHeight } });
  };

  // Marks and notes on the one picked element (Pick mode): a drag draws a stroke, a click drops a note. They sit in a
  // layer over the document in page coordinates, so they scroll with the content; the canvas gets them on each change.
  const MAX_STROKES = 40;
  const MAX_POINTS = 400;
  const MAX_NOTES = 20;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let strokes: { points: { x: number; y: number }[]; line: SVGPolylineElement; halo: SVGPolylineElement }[] = [];
  let notes: { x: number; y: number; near: string; el: HTMLDivElement; input: HTMLInputElement; at: number }[] = [];
  let markedFor: Element | null = null;
  let markLayer: HTMLDivElement | null = null;
  let markSvg: SVGSVGElement | null = null;
  // An element clicked while marks are down: picked only once the canvas confirms (the marks go with it).
  let pendingPick: Element | null = null;
  const inLayer = (e: Event): boolean => markLayer !== null && e.target instanceof Node && markLayer.contains(e.target);
  const ensureLayer = (): void => {
    if (markLayer && markLayer.isConnected && markSvg) return;
    markLayer = document.createElement("div");
    markLayer.setAttribute("data-cubiq-marks", "");
    markLayer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483644;pointer-events:none";
    markSvg = document.createElementNS(SVG_NS, "svg");
    markSvg.setAttribute("width", "1");
    markSvg.setAttribute("height", "1");
    markSvg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
    markLayer.append(markSvg);
    document.documentElement.append(markLayer);
  };
  const reportMarks = (): void => {
    post("marks", {
      strokes: strokes.map((s) => s.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))),
      notes: notes
        .filter((n) => n.input.value.trim())
        .map((n) => ({ x: Math.round(n.x), y: Math.round(n.y), text: n.input.value.trim().slice(0, 200), near: n.near })),
    });
  };
  const hasMarks = (): boolean => strokes.length > 0 || notes.some((n) => n.input.value.trim() !== "");
  const clearMarks = (): void => {
    const had = strokes.length > 0 || notes.length > 0;
    for (const s of strokes) {
      s.line.remove();
      s.halo.remove();
    }
    for (const n of notes) n.el.remove();
    strokes = [];
    notes = [];
    pendingPick = null;
    if (had) reportMarks();
  };
  const startStroke = (x: number, y: number): (typeof strokes)[number] | null => {
    if (strokes.length >= MAX_STROKES) return null;
    ensureLayer();
    const line = (): SVGPolylineElement => {
      const pl = document.createElementNS(SVG_NS, "polyline");
      pl.setAttribute("fill", "none");
      pl.setAttribute("stroke-linecap", "round");
      pl.setAttribute("stroke-linejoin", "round");
      return pl;
    };
    // An ink line on a light halo (like the selection outline), readable on any page.
    const halo = line();
    halo.setAttribute("stroke", "#F7F8FA");
    halo.setAttribute("stroke-width", "6");
    const ink = line();
    ink.setAttribute("stroke", "#0B0D10");
    ink.setAttribute("stroke-width", "2.5");
    markSvg?.append(halo, ink);
    const stroke = { points: [{ x, y }], line: ink, halo };
    strokes.push(stroke);
    return stroke;
  };
  const addPoint = (stroke: (typeof strokes)[number], x: number, y: number): void => {
    if (stroke.points.length >= MAX_POINTS) return;
    stroke.points.push({ x, y });
    const pts = stroke.points.map((p) => `${p.x},${p.y}`).join(" ");
    stroke.line.setAttribute("points", pts);
    stroke.halo.setAttribute("points", pts);
  };
  // A short name for what a note sits on: `button "Subscribe"`.
  const nearLabel = (el: Element | null): string => {
    if (!el || el === document.body || el === document.documentElement) return "";
    const tag = el.tagName.toLowerCase();
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return text ? `${tag} "${text}"` : tag;
  };
  const addNote = (x: number, y: number, near: string): void => {
    if (notes.length >= MAX_NOTES) return;
    ensureLayer();
    const el = document.createElement("div");
    el.setAttribute("data-cubiq-note", "");
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);pointer-events:auto`;
    const input = document.createElement("input");
    input.maxLength = 200;
    input.size = 8;
    input.placeholder = "Note";
    input.setAttribute("aria-label", "Note");
    input.style.cssText =
      "box-sizing:border-box;height:26px;padding:0 10px;border:0;border-radius:6px;background:#0B0D10;color:#F7F8FA;font:500 12px/26px -apple-system,'Segoe UI',system-ui,sans-serif;outline:none;box-shadow:0 0 0 1.5px #F7F8FA";
    el.append(input);
    markLayer?.append(el);
    const note = { x, y, near: near.slice(0, 60), el, input, at: Date.now() };
    notes.push(note);
    input.addEventListener("input", () => {
      input.size = Math.max(8, Math.min(40, input.value.length + 1));
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = "";
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      if (!input.value.trim()) {
        el.remove();
        notes = notes.filter((n) => n !== note);
      }
      reportMarks();
    });
    setTimeout(() => input.focus(), 0);
  };
  const setPins = (raw: unknown): void => {
    for (const pin of pins) pin.dot.remove();
    pins = [];
    const list = Array.isArray(raw) ? raw : [];
    const missing: number[] = [];
    let taken = 0;
    for (const entry of list) {
      if (taken >= 100) break;
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const n = item.n;
      const t = item.target;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 999) continue;
      if (!t || typeof t !== "object") continue;
      const target = t as Record<string, unknown>;
      if (typeof target.selector !== "string" || typeof target.tag !== "string" || typeof target.text !== "string") continue;
      taken++;
      const ref: SelectionTarget = { selector: target.selector, tag: target.tag, text: target.text };
      if (typeof target.id === "string") ref.id = target.id;
      const el = resolveTarget(document, ref);
      if (!el) {
        missing.push(n);
        continue;
      }
      const dot = document.createElement("div");
      dot.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483646;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:#0B0D10;color:#F7F8FA;font:600 11px/20px ui-monospace,Menlo,monospace;text-align:center;box-shadow:0 0 0 2px #F7F8FA";
      dot.textContent = String(n);
      document.documentElement.append(dot);
      pins.push({ n, el, dot });
    }
    if (frame === 0 && pins.length > 0) frame = requestAnimationFrame(step);
    post("pins", { missing });
  };
  const report = (lost: number): void => {
    post("selection", { elements: selected.map((el) => describeElement(el, selectorFor)), lost });
  };

  // Select mode: a hover highlight plus click/keyboard selection; the page never
  // sees the gestures. The mode stays on across clicks until Esc leaves it.
  let stopSelect: (() => void) | null = null;
  // The element bar's Edit text: set while Pick is on.
  let editSelected: (() => void) | null = null;
  // In-place text editing is on unless the canvas says otherwise (the Quick tier turns it off).
  let allowEdit = true;
  let hovered: Element | null = null;
  const startSelect = (): void => {
    if (stopSelect) return;
    const box = document.createElement("div");
    // Under the selection outlines and comment pins (…646), so a hovered pinned element keeps its number readable.
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #0B0D10;outline:1px solid #F7F8FA;background:rgba(11,13,16,.06);border-radius:3px;display:none";
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,Menlo,monospace;background:#0B0D10;color:#F7F8FA;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    document.documentElement.append(box, tip);

    // A press that may become a stroke (one element picked, no modifiers), and whether the last press drew one.
    let press: { x: number; y: number; stroke: (typeof strokes)[number] | null } | null = null;
    let drew = false;
    const endPress = (): void => {
      if (press?.stroke) {
        drew = true;
        reportMarks();
      }
      press = null;
    };
    const onMove = (e: MouseEvent): void => {
      if (press) {
        // The button came up outside the frame: the stroke ends there.
        if (!(e.buttons & 1)) endPress();
        else {
          if (!press.stroke) {
            if (Math.hypot(e.pageX - press.x, e.pageY - press.y) <= 4) return;
            press.stroke = startStroke(press.x, press.y);
            box.style.display = "none";
            tip.style.display = "none";
            if (!press.stroke) return;
          }
          addPoint(press.stroke, e.pageX, e.pageY);
          return;
        }
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip || markLayer?.contains(el)) return;
      const target = snapTarget(el);
      hovered = target;
      const r = target.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const id = target.getAttribute("data-agent-id");
      const tag = target.tagName.toLowerCase();
      tip.textContent = id ? `${tag} ${id}` : tag;
      // A comment pin sits on the element's top-left corner: start the tip past its right edge so it never covers the number.
      const pinned = pins.some((p) => p.el === target);
      Object.assign(tip.style, { display: "block", left: `${Math.max(4, r.left + (pinned ? 14 : 0))}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
    };
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    // In-place text editing: one leaf element at a time, committed with Enter or a
    // click elsewhere, cancelled with Escape.
    let editing: { el: Element; id: string; before: string } | null = null;
    const insideEdit = (e: Event): boolean => editing !== null && e.target instanceof Node && editing.el.contains(e.target);
    const onEditKey = (e: KeyboardEvent): void => {
      if (!editing || e.target !== editing.el) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      }
    };
    const onEditBlur = (e: FocusEvent): void => {
      if (editing && e.target === editing.el) commitEdit();
    };
    const commitEdit = (): void => {
      const edit = editing;
      if (!edit) return;
      editing = null;
      const after = edit.el.textContent ?? "";
      edit.el.removeAttribute("contenteditable");
      (edit.el as HTMLElement).removeEventListener("keydown", onEditKey, true);
      (edit.el as HTMLElement).removeEventListener("blur", onEditBlur);
      if (after.replace(/\s+/g, " ").trim() !== edit.before.replace(/\s+/g, " ").trim()) post("text-edit", { id: edit.id, before: edit.before, after: after.slice(0, 2000) });
    };
    const cancelEdit = (): void => {
      const edit = editing;
      if (!edit) return;
      editing = null;
      edit.el.textContent = edit.before;
      edit.el.removeAttribute("contenteditable");
      (edit.el as HTMLElement).removeEventListener("keydown", onEditKey, true);
      (edit.el as HTMLElement).removeEventListener("blur", onEditBlur);
    };

    // Mousedown/mouseup stay swallowed unless the gesture is inside the editor or a note.
    const onDown = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      swallow(e);
      if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && selected.length === 1) press = { x: e.pageX, y: e.pageY, stroke: null };
    };
    const onUp = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      swallow(e);
      endPress();
    };
    const onClick = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      commitEdit();
      swallow(e);
      if (drew) {
        drew = false;
        return;
      }
      const t = hovered;
      if (!t) return;
      const one = selected.length === 1 ? (selected[0] ?? null) : null;
      const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey;
      if (one && plain && (one.contains(t) || t === document.body || t === document.documentElement)) {
        // On (or around) the picked element a click drops a note; the second click of a double-click doesn't.
        if (e.detail < 2) addNote(e.pageX, e.pageY, nearLabel(document.elementFromPoint(e.clientX, e.clientY)));
        return;
      }
      if (one && plain && hasMarks()) {
        // Another element: the marks would go with the old pick, so the canvas asks first.
        pendingPick = t;
        post("repick-ask", { label: nearLabel(t).slice(0, 60) || t.tagName.toLowerCase() });
        return;
      }
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
    const onDblClick = (e: MouseEvent): void => {
      if (insideEdit(e)) return;
      // The first click of a double-click dropped an empty note: it goes, and the double-click edits the text under it.
      const last = notes[notes.length - 1];
      if (last && !last.input.value.trim() && Date.now() - last.at < 700) {
        last.el.remove();
        notes = notes.filter((n) => n !== last);
      } else if (inLayer(e)) return;
      swallow(e);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      beginEdit(el);
    };
    // In-place editing of one element (a double-click, or the element bar's Edit text).
    const beginEdit = (el: Element): void => {
      if (!allowEdit) {
        post("edit-refused", { reason: "Text editing is off in the Quick tier; ask the agent, or switch the tier." });
        return;
      }
      const r = editableText(el);
      if (!r.ok) {
        post("edit-refused", { reason: r.reason });
        return;
      }
      editing = { el, id: r.id, before: r.text };
      el.setAttribute("contenteditable", "plaintext-only");
      (el as HTMLElement).focus();
      document.getSelection()?.selectAllChildren(el);
      (el as HTMLElement).addEventListener("keydown", onEditKey, true);
      (el as HTMLElement).addEventListener("blur", onEditBlur);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
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
      commitEdit();
      press = null;
      clearMarks();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("dblclick", onDblClick, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      tip.remove();
      hovered = null;
      editSelected = null;
      if (stopSelect === stop) stopSelect = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("keydown", onKey, true);
    editSelected = () => {
      const el = selected.length === 1 ? selected[0] : null;
      if (el) beginEdit(el);
    };
    stopSelect = stop;
  };

  // Live style previews from the inspector: the prop's original inline value is remembered the first time it is
  // touched, so clear-preview can put the page back exactly. Keep these keys in step with STYLE_KEYS in
  // shared/selection.ts (this function is serialized into the page, so it cannot import them).
  const STYLE_PROPS = [
    "display",
    "flexDirection",
    "flexWrap",
    "justifyContent",
    "alignItems",
    "gap",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "width",
    "height",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "color",
    "backgroundColor",
    "borderRadius",
    "borderWidth",
    "borderColor",
    "opacity",
    "boxShadow",
  ];
  const previewOriginals = new Map<Element, Map<string, string>>();

  // Commands from the canvas.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return;
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      x?: unknown;
      y?: unknown;
      on?: unknown;
      ok?: unknown;
      edit?: unknown;
      attr?: unknown;
      var?: unknown;
      value?: unknown;
      targets?: unknown;
      pins?: unknown;
      target?: unknown;
      prop?: unknown;
    } | null;
    if (!data || data.source !== "cubiq-canvas") return;
    if (data.type === "restore-scroll") {
      const x = typeof data.x === "number" ? data.x : 0;
      const y = typeof data.y === "number" ? data.y : 0;
      const restore = (): void => window.scrollTo(x, y);
      restore();
      if (document.readyState === "loading") window.addEventListener("load", restore, { once: true });
    } else if (data.type === "pick") {
      allowEdit = data.edit !== false;
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
    } else if (data.type === "set-pins") {
      setPins(data.pins);
    } else if (data.type === "device-chrome") {
      const id = "cubiq-device-chrome";
      const prior = document.getElementById(id);
      if (data.on === true && !prior) {
        const style = document.createElement("style");
        style.id = id;
        style.textContent = "html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}";
        document.head.appendChild(style);
      } else if (data.on !== true && prior) prior.remove();
    } else if (data.type === "preview-style") {
      if (typeof data.prop !== "string" || STYLE_PROPS.indexOf(data.prop) < 0) return;
      if (typeof data.value !== "string" || data.value.length > 120 || !/^[#(),.%\w\s-]*$/.test(data.value)) return;
      const raw = data.target;
      if (!raw || typeof raw !== "object") return;
      const target = raw as Record<string, unknown>;
      if (typeof target.selector !== "string" || typeof target.tag !== "string" || typeof target.text !== "string") return;
      const ref: SelectionTarget = { selector: target.selector, tag: target.tag, text: target.text };
      if (typeof target.id === "string") ref.id = target.id;
      const el = resolveTarget(document, ref);
      if (!el) return;
      let mine = previewOriginals.get(el);
      if (!mine) {
        mine = new Map<string, string>();
        previewOriginals.set(el, mine);
      }
      const st = (el as HTMLElement).style as unknown as Record<string, string>;
      if (!mine.has(data.prop)) mine.set(data.prop, st[data.prop] ?? "");
      st[data.prop] = data.value;
    } else if (data.type === "clear-preview") {
      previewOriginals.forEach((props, el) => {
        const st = (el as HTMLElement).style as unknown as Record<string, string>;
        props.forEach((value, prop) => {
          st[prop] = value;
        });
      });
      previewOriginals.clear();
    } else if (data.type === "outline") {
      reportOutline();
    } else if (data.type === "clear-marks") {
      clearMarks();
    } else if (data.type === "repick") {
      const next = pendingPick;
      pendingPick = null;
      if (data.ok !== true || !next || !next.isConnected) return;
      selected = [next];
      redraw();
      report(0);
    } else if (data.type === "edit-selected") {
      editSelected?.();
    } else if (data.type === "hover-layer") {
      const raw = data.target;
      let el: Element | null = null;
      if (raw && typeof raw === "object") {
        const target = raw as Record<string, unknown>;
        if (typeof target.selector === "string" && typeof target.tag === "string") {
          const ref: SelectionTarget = { selector: target.selector, tag: target.tag, text: typeof target.text === "string" ? target.text : "" };
          if (typeof target.id === "string") ref.id = target.id;
          el = resolveTarget(document, ref);
        }
      }
      showLayerHover(el);
    }
  });
}

/** The bridge as one script body, embedding the page-side helpers it needs. */
export function bridgeScript(selectorFor: (el: Element) => string): string {
  return `(${designBridge.toString()})(${selectorFor.toString()}, ${describeElement.toString()}, ${snapTarget.toString()}, ${resolveTarget.toString()}, ${editableText.toString()}, ${outlineOf.toString()});`;
}
