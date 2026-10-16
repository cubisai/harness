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
  | { source: "cubiq-design"; type: "outline"; nodes: OutlineNode[] };

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
  | { source: "cubiq-canvas"; type: "outline" };

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
 * node; its children start at depth 0. At most 400 nodes and 8 levels of depth are reported. Runs inside the page
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
      const node: OutlineNode = { tag, cls, selector: selectorFor(el), label: own.replace(/\s+/g, " ").trim().slice(0, 40), depth };
      if (rawId && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(rawId)) node.id = rawId;
      nodes.push(node);
    }
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
    if (frame === 0 && (selected.length > 0 || pins.length > 0)) frame = requestAnimationFrame(step);
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

    // Mousedown/mouseup stay swallowed unless the gesture is inside the editor.
    const onPointer = (e: Event): void => {
      if (insideEdit(e)) return;
      swallow(e);
    };
    const onClick = (e: MouseEvent): void => {
      if (insideEdit(e)) return;
      commitEdit();
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
    const onDblClick = (e: MouseEvent): void => {
      if (insideEdit(e)) return;
      swallow(e);
      if (!allowEdit) {
        post("edit-refused", { reason: "Text editing is off in the Quick tier; ask the agent, or switch the tier." });
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
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
      if (insideEdit(e)) return;
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
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("dblclick", onDblClick, true);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("mouseup", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      tip.remove();
      hovered = null;
      if (stopSelect === stop) stopSelect = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("mouseup", onPointer, true);
    document.addEventListener("keydown", onKey, true);
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
    }
  });
}

/** The bridge as one script body, embedding the page-side helpers it needs. */
export function bridgeScript(selectorFor: (el: Element) => string): string {
  return `(${designBridge.toString()})(${selectorFor.toString()}, ${describeElement.toString()}, ${snapTarget.toString()}, ${resolveTarget.toString()}, ${editableText.toString()}, ${outlineOf.toString()});`;
}
