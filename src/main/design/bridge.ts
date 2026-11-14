/// <reference lib="dom" />
import { patchDocument, type PatchResult } from "./patch";

/** The shape a design page element is described as when reported to the canvas. */
export interface DescribedElement {
  id?: string;
  selector: string;
  tag: string;
  text: string;
  /** The text a panel edit replaces, as written in the source. Absent when no one element holds the text. */
  ownText?: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  path: { label: string; selector: string; ui?: string; part?: string }[];
  /** The element's computed style, limited to the inspector's keys (see STYLE_KEYS in shared/selection.ts). */
  style?: Record<string, string>;
  /** Its element-child path from `<html>`: how the mutation service finds it before it has an id. */
  at?: number[];
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
  /** Its kit part, from `data-ui`. */
  ui?: string;
}

/** Messages the design page sends up to the canvas. */
export type BridgeMessage =
  | { source: "cubiq-design"; type: "ready"; path?: string }
  | { source: "cubiq-design"; type: "scroll"; x: number; y: number }
  | { source: "cubiq-design"; type: "selection"; elements: unknown[]; lost: number }
  /** Design v2: an in-place edit, named by id or by its place in the page, for the mutation service. */
  | { source: "cubiq-design"; type: "text-commit"; target: { id: string } | { locator: { tag: string; path: number[]; text?: string } }; before: string; after: string; live: boolean }
  /** Design v2: a press on the page, which swallows it: the app's own focus lets go, so the canvas's keys work next. */
  | { source: "cubiq-design"; type: "pointer" }
  /** Design v2: ⌘Z, ⇧⌘Z or ⌘Y with the keyboard in the frame. */
  | { source: "cubiq-design"; type: "history-key"; action: "undo" | "redo" }
  /** Design v2: the page's own values for the tokens the Customize panel asked about. */
  | { source: "cubiq-design"; type: "theme"; tokens: Record<string, string>; scheme?: "light" | "dark" }
  | { source: "cubiq-design"; type: "edit-refused"; reason: string }
  | { source: "cubiq-design"; type: "pick-cancel" }
  | { source: "cubiq-design"; type: "tweaks"; manifest: string; attrs: Record<string, string>; vars: Record<string, string> }
  | { source: "cubiq-design"; type: "pins"; missing: number[] }
  | { source: "cubiq-design"; type: "outline"; nodes: OutlineNode[] }
  | { source: "cubiq-design"; type: "anchor"; rect: Rect | null; bounds?: Rect; editable?: boolean; view?: { width: number; height: number } }
  | { source: "cubiq-design"; type: "variants"; sets: { set: string; count: number; shown: number; malformed: string | null }[] }
  | { source: "cubiq-design"; type: "variant-rect"; set: string; rect: Rect | null }
  /** A Detect pin was clicked: its element is now the selection. */
  | { source: "cubiq-design"; type: "finding"; n: number };

/** A box in the frame's viewport, in CSS pixels. */
type Rect = { x: number; y: number; width: number; height: number };

/** Messages the canvas sends down into the design page. */
export type CanvasMessage =
  | { source: "cubiq-canvas"; type: "restore-scroll"; x: number; y: number }
  | { source: "cubiq-canvas"; type: "pick"; on: boolean; edit?: boolean; color?: string }
  /** Design v2: this frame load's token, which the page sends back with every later message. */
  | { source: "cubiq-canvas"; type: "session"; nonce: string }
  /** Design v2: Esc, Enter or an arrow with the keyboard in the app: the same step as the key pressed in the frame. */
  | { source: "cubiq-canvas"; type: "key"; key: string; alt: boolean }
  /** Design v2: the mutation service stamped an id on this element: the frame's copy takes it too. */
  | { source: "cubiq-canvas"; type: "stamp"; path: number[]; id: string }
  /** Design v2: preview an edit the mutation service is saving. */
  | { source: "cubiq-canvas"; type: "apply-style"; target: { id?: string; selector: string; tag: string; text: string }; changes: { prop: string; value: string }[] }
  | { source: "cubiq-canvas"; type: "apply-attr"; target: { id?: string; selector: string; tag: string; text: string }; name: string; value: string | null }
  | { source: "cubiq-canvas"; type: "apply-text"; target: { id?: string; selector: string; tag: string; text: string }; value: string }
  | { source: "cubiq-canvas"; type: "read-theme"; names: string[] }
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
  | { source: "cubiq-canvas"; type: "show-variant"; set: string; n: number }
  /** Detect's pins (an empty list clears them): clickable, unlike comment pins; a click selects the element. */
  | { source: "cubiq-canvas"; type: "set-findings"; findings: { n: number; selector: string; detail: string }[] };

/** Snap an element to its nearest interactive ancestor, or itself when there is none. */
/** A stylesheet href with a fresh `r=` cache-buster in place of any earlier one: `a.css?r=1` → `a.css?r=2`, `a.css?v=3&r=1` → `a.css?v=3&r=2`. */
export function restyledHref(href: string, stamp: number): string {
  const base = href.replace(/([?&])r=\d+&?/, "$1").replace(/[?&]$/, "");
  return `${base}${base.includes("?") ? "&" : "?"}r=${stamp}`;
}

export function snapTarget(el: Element): Element {
  return el.closest("a, button, [role=button], input, select, textarea, label, summary") ?? el;
}

/** One step up from the hovered element (innermost first): its box, whether its siblings sit beside it, and whether it has any. */
export type GapLevel = { rect: { x: number; y: number; width: number; height: number }; row: boolean; siblings: boolean };

/**
 * Where an Insert goes for the pointer at (x, y): the outermost level with siblings whose leading or trailing edge is
 * within `edge` px (so a section boundary wins over the text inside it), else the innermost level with siblings,
 * before or after it by which half the pointer is in. Null when no level has siblings.
 */
export function gapChoice(chain: GapLevel[], x: number, y: number, edge = 10): { level: number; position: "before" | "after" } | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i]!;
    if (!c.siblings) continue;
    const at = c.row ? x : y;
    const start = c.row ? c.rect.x : c.rect.y;
    const end = start + (c.row ? c.rect.width : c.rect.height);
    if (Math.abs(at - start) <= edge) return { level: i, position: "before" };
    if (Math.abs(at - end) <= edge) return { level: i, position: "after" };
  }
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!;
    if (!c.siblings) continue;
    const mid = c.row ? c.rect.x + c.rect.width / 2 : c.rect.y + c.rect.height / 2;
    return { level: i, position: (c.row ? x : y) < mid ? "before" : "after" };
  }
  return null;
}

/**
 * The gap the pointer is in when it's inside an element but over none of its children (the space between two
 * sections): the nearest child within `reach` px, before or after it along its flow. Null when the pointer is over a
 * child or none is that near.
 */
export function childGap(kids: GapLevel[], x: number, y: number, reach = 40): { index: number; position: "before" | "after" } | null {
  let best = -1;
  let dist = Infinity;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i]!.rect;
    const d = Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.width)), Math.max(r.y - y, 0, y - (r.y + r.height)));
    if (d === 0) return null;
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  if (best < 0 || dist > reach) return null;
  const k = kids[best]!;
  const mid = k.row ? k.rect.x + k.rect.width / 2 : k.rect.y + k.rect.height / 2;
  return { index: best, position: (k.row ? x : y) < mid ? "before" : "after" };
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
    const step: DescribedElement["path"][number] = { label: good ? `${tag} ${good}` : tag, selector: selectorFor(cur) };
    const ui = cur.getAttribute("data-ui");
    const part = cur.getAttribute("data-part");
    if (ui) step.ui = ui;
    if (part) step.part = part;
    path.push(step);
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
  // The text a panel edit writes, as the source has it: `text` is what shows, so CSS uppercase would leak into the field.
  // The same rule as `textHolder` (this function is serialized into the page, so it cannot call it).
  try {
    const holdsOwn = (node: Element): boolean => Array.from(node.childNodes).some((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "");
    const noText = /^(SCRIPT|STYLE|TEXTAREA|SELECT|OPTION|SVG|IMG|INPUT)$/i;
    if (!noText.test(el.tagName)) {
      const holders = holdsOwn(el) ? [el] : Array.from(el.querySelectorAll("*")).filter((node) => !noText.test(node.tagName) && !node.closest("svg") && holdsOwn(node));
      const holder = holders.length === 1 ? holders[0] : null;
      if (holder) {
        const run = holder.children.length > 0 ? Array.from(holder.childNodes).find((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "") : null;
        const own = ((run ? run.nodeValue : holder.textContent) ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (own) described.ownText = own;
      }
    }
  } catch {
    // A label to read, not a reason to lose the selection.
  }
  const at: number[] = [];
  for (let cur: Element = el; cur.parentElement; cur = cur.parentElement) {
    const kin = cur.parentElement.children;
    let index = -1;
    for (let i = 0; i < (kin?.length ?? 0); i++) if (kin[i] === cur) index = i;
    at.unshift(index);
  }
  if (at.length > 0 && at.length <= 64 && at.every((n) => n >= 0)) described.at = at;
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
 * False for what a person can't see or mean to click: screen-reader text, skip links, anything transparent, hidden,
 * clipped away, tiny or off the page. Runs inside the page (passed in with toString).
 */
export function isSelectableElement(el: Element, styleOf: (el: Element) => CSSStyleDeclaration): boolean {
  if (el.matches(".sr-only, .visually-hidden, .skip-link")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0) return false;
  const own = styleOf(el);
  if (own.visibility === "hidden" || own.pointerEvents === "none") return false;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const s = styleOf(cur);
    if (s.opacity === "0") return false;
    if (s.clipPath !== "" && s.clipPath !== undefined && s.clipPath !== "none") return false;
    if (s.position === "absolute" && s.clip !== "" && s.clip !== undefined && s.clip !== "auto") return false;
  }
  return true;
}

/**
 * What a click lands on first in Design v2: the nearest library part, element the agent named, page region or control
 * around an element, or the element itself when the page has none.
 */
export function componentOf(el: Element): Element {
  // An `el-…` id is one the editor stamped to save an edit: editing an element mustn't change what a click on it takes.
  const found = el.closest('[data-ui], [data-agent-id]:not([data-agent-id^="el-"]), header, footer, nav, main, section, aside, article, a, button, [role=button], input, select, textarea, label, summary, img, svg');
  return found && found.tagName !== "BODY" && found.tagName !== "HTML" ? found : el;
}

/** One level inside `current` on the way to the element under the pointer; null when the pointer is on `current` itself. */
export function drillTarget(current: Element, hit: Element, selectable: (el: Element) => boolean): Element | null {
  let step: Element | null = null;
  for (let cur: Element | null = hit; cur && cur !== current; cur = cur.parentElement) {
    if (selectable(cur)) step = cur;
    if (cur.parentElement === current && step) return step;
  }
  return null;
}

/**
 * What a click takes once something is selected, so a selected parent never blocks its children. Inside the selection:
 * the component under the pointer, else the element itself if it has content of its own. A click on a sibling works the
 * same inside their shared parent, so the depth holds, and on that parent's bare background it steps up to the parent.
 * A bare wrapper in between takes the scope: a stray click on a gap shouldn't lose it. One you can see, with a fill or a
 * border, counts as content. Outside: the component there.
 */
export function clickTarget(selected: Element | null, hit: Element, component: (el: Element) => Element, paints: (el: Element) => boolean): Element {
  if (!selected) return component(hit);
  const parent = selected.parentElement && selected.parentElement.tagName !== "BODY" && selected.parentElement.tagName !== "HTML" ? component(selected.parentElement) : null;
  const scope = selected.contains(hit) ? selected : parent && parent.contains(hit) ? parent : null;
  if (!scope) return component(hit);
  const target = component(hit);
  if (target !== scope && scope.contains(target)) return target;
  if (hit === scope) return scope;
  const hasContent = /^(IMG|SVG|VIDEO|CANVAS|PICTURE)$/i.test(hit.tagName) || Array.from(hit.childNodes).some((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "");
  return hasContent || paints(hit) ? hit : scope;
}

/** The component that holds this one, or null at the top of the page. */
export function parentComponent(el: Element, component: (el: Element) => Element): Element | null {
  const up = el.parentElement;
  if (!up || up.tagName === "BODY" || up.tagName === "HTML") return null;
  const found = component(up);
  return found.tagName === "BODY" || found.tagName === "HTML" ? null : found;
}

/** The element whose text a double-click edits: this one when it holds text directly, else its only text-bearing descendant. */
export function textHolder(el: Element): Element | null {
  const own = (node: Element): boolean => Array.from(node.childNodes).some((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "");
  const noText = /^(SCRIPT|STYLE|TEXTAREA|SELECT|OPTION|SVG|IMG|INPUT)$/i;
  if (noText.test(el.tagName)) return null;
  if (own(el)) return el;
  const holders = Array.from(el.querySelectorAll("*")).filter((node) => !noText.test(node.tagName) && !node.closest("svg") && own(node));
  return holders.length === 1 ? (holders[0] ?? null) : null;
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
      const ui = el.getAttribute("data-ui");
      if (ui && /^[a-z0-9][a-z0-9-]{0,47}$/.test(ui)) node.ui = ui;
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
  gapChoice: (chain: GapLevel[], x: number, y: number) => { level: number; position: "before" | "after" } | null,
  childGap: (kids: GapLevel[], x: number, y: number) => { index: number; position: "before" | "after" } | null,
  isSelectableElement: (el: Element, styleOf: (el: Element) => CSSStyleDeclaration) => boolean,
  componentOf: (el: Element) => Element,
  drillTarget: (current: Element, hit: Element, selectable: (el: Element) => boolean) => Element | null,
  parentComponent: (el: Element, component: (el: Element) => Element) => Element | null,
  clickTarget: (selected: Element | null, hit: Element, component: (el: Element) => Element, paints: (el: Element) => boolean) => Element,
  textHolder: (el: Element) => Element | null,
  patchDocument: (live: Document, base: Document, next: Document, own: (node: Node) => boolean) => PatchResult,
  restyledHref: (href: string, stamp: number) => string,
): void {
  // This script's own element, which the page's file doesn't have (a patch must leave it be).
  const bridgeScript = document.currentScript;
  // Design v2's per-load token and selection colour, both from the canvas. Without them the page behaves as before.
  let nonce = "";
  let selectColor = "";
  const post = (type: string, data?: Record<string, unknown>): void => {
    parent.postMessage({ source: "cubiq-design", type, ...(data ?? {}), ...(nonce ? { nonce } : {}) }, "*");
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
    post("ready", { path: location.pathname, loaded: bridgeScript?.getAttribute("data-source") ?? "" });
    reportTweaks();
    reportOutline();
    findVariants();
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
  // Detect pins: numbered amber squares on the elements a lint finding names; a click selects the element.
  let findings: { n: number; el: Element; dot: HTMLDivElement }[] = [];
  const onFinding = (e: Event): boolean => e.target instanceof Element && e.target.closest("[data-cubiq-finding]") !== null;
  let frame = 0;
  const step = (): void => {
    frame = selected.length > 0 || pins.length > 0 || findings.length > 0 || activeSet !== null ? requestAnimationFrame(step) : 0;
    outlines.forEach((outline, el) => {
      if (!el.isConnected) {
        outline.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      Object.assign(outline.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    postVariantRect();
    for (const pin of pins) {
      if (!pin.el.isConnected) {
        pin.dot.style.display = "none";
        continue;
      }
      const r = pin.el.getBoundingClientRect();
      Object.assign(pin.dot.style, { display: "block", left: `${Math.max(2, r.left - 10)}px`, top: `${Math.max(2, r.top - 10)}px` });
    }
    // Detect pins sit on the top-right corner, clear of a comment pin on the top-left.
    for (const f of findings) {
      if (!f.el.isConnected) {
        f.dot.style.display = "none";
        continue;
      }
      const r = f.el.getBoundingClientRect();
      Object.assign(f.dot.style, { display: "block", left: `${Math.max(2, Math.min(innerWidth - 24, r.right - 10))}px`, top: `${Math.max(2, r.top - 10)}px` });
    }
    postAnchor();
  };
  const redraw = (): void => {
    outlines.forEach((outline) => outline.remove());
    outlines.clear();
    for (const el of selected) {
      const outline = document.createElement("div");
      outline.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:2px solid ${selectColor || "#0B0D10"};outline:1px solid #F7F8FA;border-radius:3px`;
      document.documentElement.append(outline);
      outlines.set(el, outline);
    }
    const one = selected.length === 1 ? (selected[0] ?? null) : null;
    editableSel = one !== null && (selectColor ? textHolder(one) !== null : editableText(one).ok);
    if (frame === 0 && (selected.length > 0 || pins.length > 0)) frame = requestAnimationFrame(step);
    if (selected.length === 0) postAnchor();
  };

  // In-place variant sets (`data-cubiq-variant="<set>-<n>"`, 0 = the original): found when the page loads, one shown
  // at a time. A shown wrapper is a layout-neutral shell; the canvas cycles them and keeps one (in the main process).
  let variantSets: { set: string; wrappers: Map<number, Element> }[] = [];
  let activeSet: string | null = null;
  let variantKey = "";
  const findVariants = (): void => {
    const sets = new Map<string, Map<number, Element>>();
    const doubled = new Set<string>();
    document.querySelectorAll("[data-cubiq-variant]").forEach((el) => {
      // A set name may carry inner hyphens (`hero-em-1` is set `hero-em`, variant 1): small models write them.
      const m = /^([a-z](?:[a-z0-9-]{0,22}[a-z0-9])?)-(\d{1,2})$/.exec(el.getAttribute("data-cubiq-variant") || "");
      if (!m) return;
      const name = m[1] as string;
      const n = Number(m[2]);
      const list = sets.get(name) ?? new Map<number, Element>();
      if (list.has(n)) doubled.add(name);
      list.set(n, el);
      sets.set(name, list);
    });
    variantSets = [...sets].map(([set, wrappers]) => ({ set, wrappers }));
    if (variantSets.length && !document.getElementById("cubiq-variant-style")) {
      const style = document.createElement("style");
      style.id = "cubiq-variant-style";
      style.textContent = "[data-cubiq-variant]:not([hidden]){display:contents}[data-cubiq-variant][hidden]{display:none!important}";
      document.head.appendChild(style);
    }
    const report = variantSets.map(({ set, wrappers }) => {
      let count = 0;
      while (wrappers.has(count + 1)) count++;
      let malformed: string | null = null;
      if (doubled.has(set)) malformed = "a variant appears twice";
      else if (!wrappers.has(0)) malformed = "the original (variant 0) is missing";
      else if (count < 1 || wrappers.size !== count + 1) malformed = "the variants aren't numbered 1, 2, 3";
      else
        wrappers.forEach((el, n) => {
          const loose = Array.from(el.childNodes).some((c) => c.nodeType === 3 && (c.textContent || "").trim() !== "");
          if (!malformed && (loose || el.children.length > 1 || (n > 0 && el.children.length === 0))) malformed = `variant ${n} must hold exactly one element`;
        });
      let shown = 0;
      wrappers.forEach((el, n) => {
        if (!el.hasAttribute("hidden") && n > 0 && shown === 0) shown = n;
      });
      return { set, count, shown, malformed };
    });
    activeSet = report.find((r) => r.malformed === null)?.set ?? null;
    if (activeSet !== null && frame === 0) frame = requestAnimationFrame(step);
    post("variants", { sets: report });
  };
  const showVariant = (set: string, n: number): void => {
    const entry = variantSets.find((v) => v.set === set);
    if (!entry || !entry.wrappers.has(n)) return;
    entry.wrappers.forEach((el, k) => {
      if (k === n) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
    });
    activeSet = set;
    variantKey = "";
    if (frame === 0) frame = requestAnimationFrame(step);
  };
  // The shown variant's box (its one element; the wrapper itself has none), for the canvas's cycler.
  const postVariantRect = (): void => {
    const entry = activeSet === null ? undefined : variantSets.find((v) => v.set === activeSet);
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    entry?.wrappers.forEach((el) => {
      if (rect || el.hasAttribute("hidden")) return;
      const child = el.firstElementChild;
      if (!child) return;
      const q = child.getBoundingClientRect();
      rect = { x: q.left, y: q.top, width: q.width, height: q.height };
    });
    const r = rect as { x: number; y: number; width: number; height: number } | null;
    const key = r ? [r.x, r.y, r.width, r.height].map(Math.round).join(",") : "none";
    if (key === variantKey || !entry) return;
    variantKey = key;
    post("variant-rect", { set: entry.set, rect: r });
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
    const bounds = { x: l, y: t, width: r - l, height: b - t };
    const editable = live.length === 1 && editableSel;
    const key = [rect.x, rect.y, rect.width, rect.height, bounds.x, bounds.y, bounds.width, bounds.height, innerWidth, innerHeight].map(Math.round).join(",") + (editable ? "e" : "");
    if (key === anchorKey) return;
    anchorKey = key;
    post("anchor", { rect, bounds, editable, view: { width: innerWidth, height: innerHeight } });
  };

  // A press on a Detect pin belongs to the pin, not to the selection.
  const inLayer = (e: Event): boolean => onFinding(e);
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
  const setFindings = (raw: unknown): void => {
    for (const f of findings) f.dot.remove();
    findings = [];
    const list = Array.isArray(raw) ? raw : [];
    for (const entry of list.slice(0, 40)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const n = item.n;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 99) continue;
      if (typeof item.selector !== "string" || typeof item.detail !== "string") continue;
      let el: Element | null = null;
      try {
        el = document.querySelector(item.selector);
      } catch {
        el = null;
      }
      if (!el) continue;
      const target = el;
      const dot = document.createElement("div");
      dot.setAttribute("data-cubiq-finding", String(n));
      dot.setAttribute("role", "button");
      dot.setAttribute("aria-label", item.detail.slice(0, 300));
      dot.tabIndex = 0;
      dot.title = item.detail.slice(0, 300);
      dot.style.cssText =
        "position:fixed;cursor:pointer;z-index:2147483646;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:4px;background:#F5A524;color:#0B0D10;font:600 11px/20px ui-monospace,Menlo,monospace;text-align:center;box-shadow:0 0 0 2px #0B0D10";
      dot.textContent = String(n);
      const choose = (e: Event): void => {
        e.preventDefault();
        e.stopPropagation();
        selected = [target];
        redraw();
        report(0);
        post("finding", { n });
      };
      dot.addEventListener("click", choose);
      dot.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") choose(e);
      });
      document.documentElement.append(dot);
      findings.push({ n, el: target, dot });
    }
    if (frame === 0 && findings.length > 0) frame = requestAnimationFrame(step);
  };
  const report = (lost: number): void => {
    post("selection", { elements: selected.map((el) => describeElement(el, selectorFor)), lost });
  };

  // Select mode: a hover highlight plus click/keyboard selection; the page never
  // sees the gestures. The mode stays on across clicks until Esc leaves it.
  let stopSelect: (() => void) | null = null;
  // In-place text editing is on unless the canvas says otherwise.
  let allowEdit = true;
  // An edit to an element's text, for the canvas to hand the mutation service. `whole` is how the file's copy still reads.
  const postText = (holder: Element, before: string, after: string, whole: string, live: boolean): void => {
    const id = holder.getAttribute("data-agent-id");
    const path = describeElement(holder, selectorFor).at;
    if (!id && !path) return post("edit-refused", { reason: "That text is nested too deep to edit here; ask the agent to change it." });
    post("text-commit", { target: id ? { id } : { locator: { tag: holder.tagName.toLowerCase(), path, text: whole } }, before, after, live });
  };

  // Design v2's selection. Click takes the component, double-click edits text or drills one level, ⌘-click takes the
  // exact element, and Esc walks back up. Hidden elements are never hit, and nothing needs an id before it's edited.
  let stepKey: ((key: string, alt: boolean) => boolean) | null = null;
  const startSelectV2 = (): void => {
    if (stopSelect) return;
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483645;border:1px solid ${selectColor};border-radius:3px;display:none`;
    const tip = document.createElement("div");
    tip.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,Menlo,monospace;background:${selectColor};color:#fff;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
    document.documentElement.append(box, tip);

    const selectable = (el: Element): boolean => isSelectableElement(el, (node) => getComputedStyle(node));
    const paints = (el: Element): boolean => {
      const s = getComputedStyle(el);
      const fill = s.backgroundColor !== "" && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.backgroundColor);
      return fill || s.backgroundImage !== "none" || s.boxShadow !== "none" || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0 || parseFloat(s.borderLeftWidth) > 0;
    };
    const isRoot = (el: Element): boolean => el === document.body || el === document.documentElement;
    const hitAt = (x: number, y: number): Element | null => {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === box || el === tip || el.closest("[data-cubiq-finding]")) continue;
        if (isRoot(el) || selectable(el)) return el;
      }
      return null;
    };
    const nameOf = (el: Element): string => el.getAttribute("data-ui") || el.getAttribute("data-agent-id") || el.tagName.toLowerCase();
    const choose = (next: Element[]): void => {
      selected = next;
      redraw();
      report(0);
    };
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const hide = (): void => {
      box.style.display = "none";
      tip.style.display = "none";
    };

    // ⌥-drag: a copy of the component lands in the gap the pointer is over when the button comes up.
    const cloneLine = document.createElement("div");
    cloneLine.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;background:${selectColor || "#0B0D10"};display:none`;
    document.documentElement.append(cloneLine);
    let clone: { source: Element; x: number; y: number; moved: boolean; drop: { el: Element; position: "before" | "after" } | null } | null = null;
    let skipClick = false;
    const cloneMove = (x: number, y: number): void => {
      if (!clone) return;
      if (!clone.moved && Math.abs(x - clone.x) + Math.abs(y - clone.y) < 5) return;
      clone.moved = true;
      hide();
      const g = gapAt(x, y);
      const fits = g !== null && !isRoot(g.el) && g.el !== clone.source && !clone.source.contains(g.el);
      clone.drop = fits && g ? { el: g.el, position: g.position } : null;
      if (!fits || !g) {
        cloneLine.style.display = "none";
        return;
      }
      const r = gapLine(g.el, g.position, g.row);
      const across = r.width >= r.height;
      Object.assign(cloneLine.style, { display: "block", left: `${across ? r.x : r.x - 1}px`, top: `${across ? r.y - 1 : r.y}px`, width: `${across ? r.width : 2}px`, height: `${across ? 2 : r.height}px` });
    };
    const cloneEnd = (): void => {
      const c = clone;
      clone = null;
      cloneLine.style.display = "none";
      if (!c || !c.moved) return;
      skipClick = true;
      if (c.drop) post("clone-drop", { from: describeElement(c.source, selectorFor), ref: describeElement(c.drop.el, selectorFor), position: c.drop.position });
    };

    // Where the pointer last was: the outline is worked out again from there when the page moves under a still mouse.
    let pointer: { x: number; y: number; exact: boolean } | null = null;
    const onMove = (e: MouseEvent): void => {
      // The button came up outside the frame: no drop.
      if (clone && e.buttons === 0) {
        clone = null;
        cloneLine.style.display = "none";
      }
      if (clone) {
        cloneMove(e.clientX, e.clientY);
        if (clone.moved) return;
      }
      pointer = { x: e.clientX, y: e.clientY, exact: e.metaKey || e.ctrlKey };
      hoverAt(pointer);
    };
    const hoverAt = (at: { x: number; y: number; exact: boolean }): void => {
      if (postSeam(at.x, at.y)) return hide();
      const hit = hitAt(at.x, at.y);
      const one = selected.length === 1 ? (selected[0] ?? null) : null;
      if (!hit || isRoot(hit) || editing) return hide();
      // The outline previews what a click would take.
      const target = at.exact ? hit : clickTarget(one, hit, componentOf, paints);
      if (target === one) return hide();
      const r = target.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      tip.textContent = nameOf(target);
      Object.assign(tip.style, { display: "block", left: `${Math.max(4, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
    };

    // In-place text. A label beside its icons is edited in a temporary span, so the icons can't be typed over.
    let editing: { el: HTMLElement; wrapped: boolean; holder: Element; before: string; whole: string } | null = null;
    const insideEdit = (e: Event): boolean => editing !== null && e.target instanceof Node && editing.el.contains(e.target);
    const onEditKey = (e: KeyboardEvent): void => {
      if (!editing) return;
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        endEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        endEdit(false);
      }
    };
    const onEditBlur = (): void => endEdit(true);
    const endEdit = (keep: boolean): void => {
      const edit = editing;
      if (!edit) return;
      editing = null;
      edit.el.removeEventListener("keydown", onEditKey, true);
      edit.el.removeEventListener("blur", onEditBlur);
      const typed = edit.el.textContent ?? "";
      const changed = keep && typed.replace(/\s+/g, " ").trim() !== edit.before.replace(/\s+/g, " ").trim();
      const after = changed ? typed : edit.before;
      if (edit.wrapped) edit.el.replaceWith(document.createTextNode(after));
      else {
        edit.el.removeAttribute("contenteditable");
        edit.el.textContent = after;
      }
      if (changed) postText(edit.holder, edit.before, after, edit.whole, false);
    };
    const beginEdit = (holder: Element): void => {
      if (!allowEdit) {
        post("edit-refused", { reason: "The agent is working on this page. Edit it when the turn ends." });
        return;
      }
      // How the file's copy of this element reads, for the service to check it found the right one.
      const whole = (holder.textContent ?? "").trim().slice(0, 40);
      const run = holder.children.length > 0 ? Array.from(holder.childNodes).find((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "") : null;
      let el = holder as HTMLElement;
      if (run) {
        el = document.createElement("span");
        el.textContent = run.nodeValue;
        run.replaceWith(el);
      }
      editing = { el, wrapped: Boolean(run), holder, before: el.textContent ?? "", whole };
      hide();
      el.setAttribute("contenteditable", "plaintext-only");
      el.focus();
      document.getSelection()?.selectAllChildren(el);
      el.addEventListener("keydown", onEditKey, true);
      el.addEventListener("blur", onEditBlur);
    };

    const onDown = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      swallow(e);
      if (e.type === "mouseup") return cloneEnd();
      post("pointer");
      if (!e.altKey || e.button !== 0 || editing) return;
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit || isRoot(hit)) return;
      clone = { source: selected.find((el) => el.contains(hit)) ?? componentOf(hit), x: e.clientX, y: e.clientY, moved: false, drop: null };
    };
    // The Actions menu: a right-click on something outside the selection takes that thing first.
    const onContext = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      swallow(e);
      endEdit(true);
      const hit = hitAt(e.clientX, e.clientY);
      if (hit && !isRoot(hit) && !selected.some((el) => el.contains(hit))) choose([componentOf(hit)]);
      post("context-menu", { x: e.clientX, y: e.clientY });
    };
    // The gap the pointer is at, when it's close to the line between two blocks.
    let seamKey = "";
    const postSeam = (cx: number, cy: number): boolean => {
      const g = editing ? null : gapAt(cx, cy);
      const r = g ? gapLine(g.el, g.position, g.row) : null;
      const near = r !== null && (r.width >= r.height ? Math.abs(cy - r.y) : Math.abs(cx - r.x)) <= 8;
      const key = near && g && r ? [g.position, r.x, r.y, r.width, r.height].map(String).join() : "";
      if (key !== seamKey) {
        seamKey = key;
        post("seam", { seam: near && g && r ? { position: g.position, anchor: describeElement(g.el, selectorFor), rect: r } : null });
      }
      return near;
    };
    const onLeave = (): void => {
      pointer = null;
      hide();
      if (seamKey) {
        seamKey = "";
        post("seam", { seam: null });
      }
    };
    const onClick = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      endEdit(true);
      swallow(e);
      // The click that ends a ⌥-drag isn't a selection.
      if (skipClick) {
        skipClick = false;
        return;
      }
      if (e.detail >= 2) return;
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit || isRoot(hit)) return choose([]);
      if (e.metaKey || e.ctrlKey) return choose([hit]);
      const target = componentOf(hit);
      if (e.shiftKey) {
        if (selected.indexOf(target) >= 0) return choose(selected.filter((el) => el !== target));
        return selected.length < MAX_SELECTION ? choose([...selected, target]) : undefined;
      }
      const one = selected.length === 1 ? (selected[0] ?? null) : null;
      const next = clickTarget(one, hit, componentOf, paints);
      if (next !== one) choose([next]);
    };
    const onDblClick = (e: MouseEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      swallow(e);
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit || isRoot(hit)) return;
      const holder = textHolder(hit);
      if (holder) return beginEdit(holder);
      const current = selected.length === 1 && selected[0]?.contains(hit) ? (selected[0] as Element) : componentOf(hit);
      const next = drillTarget(current, hit, selectable);
      if (next) choose([next]);
    };
    // Up one level the way a click comes down: components, and wrappers you can see. Plain wrappers don't count.
    const stepUp = (el: Element): Element | null => parentComponent(el, (up) => {
      for (let cur: Element | null = up; cur && !isRoot(cur); cur = cur.parentElement) {
        if (componentOf(cur) === cur || paints(cur)) return cur;
      }
      return up;
    });
    const firstChild = (el: Element): Element | null => {
      for (let i = 0; i < el.children.length; i++) {
        const kid = el.children[i];
        if (kid && selectable(kid)) return kid;
      }
      return null;
    };
    const sibling = (el: Element, dir: "previousElementSibling" | "nextElementSibling"): Element | null => {
      let cur = el[dir];
      while (cur && !selectable(cur)) cur = cur[dir];
      return cur;
    };
    // One key's step. True when it did something, so the key doesn't also go to the page.
    const step = (key: string, alt: boolean): boolean => {
      const one = selected.length === 1 ? (selected[0] ?? null) : null;
      if (selected.length === 0) {
        // Tabbed into the canvas with nothing chosen: ↓, → or Enter takes the page's first component.
        if (alt || !(key === "ArrowDown" || key === "ArrowRight" || key === "Enter") || !document.body) return false;
        const first = firstChild(document.body);
        if (!first) return false;
        first.scrollIntoView({ block: "nearest" });
        choose([first]);
        return true;
      }
      if (key === "Escape") {
        const up = one ? stepUp(one) : null;
        choose(up ? [up] : []);
        return true;
      }
      if (!one) return false;
      const next =
        key === "Enter" ? firstChild(one)
        : alt && key === "ArrowUp" ? stepUp(one)
        : alt && key === "ArrowDown" ? firstChild(one)
        : alt ? null
        : key === "ArrowUp" || key === "ArrowLeft" ? sibling(one, "previousElementSibling")
        : key === "ArrowDown" || key === "ArrowRight" ? sibling(one, "nextElementSibling")
        : null;
      if (key === "Enter") {
        const holder = textHolder(one);
        if (holder) {
          beginEdit(holder);
          return true;
        }
      }
      if (next) choose([next]);
      return key === "Enter" || key.startsWith("Arrow");
    };
    const onKey = (e: KeyboardEvent): void => {
      if (insideEdit(e) || inLayer(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && (k === "z" || k === "y")) {
        swallow(e);
        post("history-key", { action: k === "y" || e.shiftKey ? "redo" : "undo" });
        return;
      }
      // The canvas's own shortcuts, for when the frame has the keyboard: the app decides what they do.
      if ((mod && /^[gdsf\\']$/.test(k)) || (!mod && /^(Backspace|Delete|i|\/|v|d|c)$/.test(e.key))) {
        swallow(e);
        post("canvas-key", { key: e.key, mod, shift: e.shiftKey, alt: e.altKey });
        return;
      }
      if (mod || e.shiftKey || !/^(Escape|Enter|Arrow(Up|Down|Left|Right))$/.test(e.key)) return;
      if (step(e.key, e.altKey)) swallow(e);
    };
    const stop = (): void => {
      endEdit(true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("dblclick", onDblClick, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onDown, true);
      document.removeEventListener("contextmenu", onContext, true);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", rehover, true);
      window.removeEventListener("resize", rehover);
      moved.disconnect();
      cancelAnimationFrame(rehoverFrame);
      clone = null;
      cloneLine.remove();
      if (seamKey) post("seam", { seam: null });
      box.remove();
      tip.remove();
      stepKey = null;
      if (stopSelect === stop) stopSelect = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onDown, true);
    document.addEventListener("contextmenu", onContext, true);
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.addEventListener("keydown", onKey, true);
    // An insert, a patch, a scroll or a resize moves the page under a mouse that stays put: the outline follows on the next frame.
    let rehoverFrame = 0;
    const rehover = (): void => {
      if (rehoverFrame) return;
      rehoverFrame = requestAnimationFrame(() => {
        rehoverFrame = 0;
        if (pointer) hoverAt(pointer);
      });
    };
    const moved = new MutationObserver(rehover);
    if (document.body) moved.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    window.addEventListener("scroll", rehover, { passive: true, capture: true });
    // A viewport switch resizes the page under the mouse without changing it.
    window.addEventListener("resize", rehover);
    stepKey = step;
    stopSelect = stop;
  };
  // A panel edit moved the element: the canvas hears its new box and values once the edits pause.
  let reportTimer = 0;
  const reportSoon = (): void => {
    clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      if (selected.length > 0) report(0);
    }, 120);
  };
  let themeWatch: MediaQueryList | null = null;
  let themeRead: (() => void) | null = null;
  const targetOf = (raw: unknown): Element | null => {
    if (!raw || typeof raw !== "object") return null;
    const target = raw as Record<string, unknown>;
    if (typeof target.selector !== "string" || typeof target.tag !== "string") return null;
    const ref: SelectionTarget = { selector: target.selector, tag: target.tag, text: typeof target.text === "string" ? target.text : "" };
    if (typeof target.id === "string") ref.id = target.id;
    return resolveTarget(document, ref);
  };

  // The gap nearest the pointer, between two blocks: where the seam's + offers to insert.
  // The nearest sibling that shows (no scripts, styles or empty boxes).
  const shownSibling = (el: Element, dir: "previousElementSibling" | "nextElementSibling"): Element | null => {
    let s = el[dir];
    while (s) {
      const q = s.getBoundingClientRect();
      if (!/^(SCRIPT|STYLE|TEMPLATE|LINK|META)$/.test(s.tagName) && q.width + q.height > 0) return s;
      s = s[dir];
    }
    return null;
  };
  // The line for a gap: halfway between the element's edge and its neighbour's (on the same row or column), else on the edge.
  const gapLine = (el: Element, position: "before" | "after", row: boolean): { x: number; y: number; width: number; height: number } => {
    const r = el.getBoundingClientRect();
    const n = shownSibling(el, position === "before" ? "previousElementSibling" : "nextElementSibling");
    const q = n ? n.getBoundingClientRect() : null;
    if (row) {
      const edge = position === "before" ? r.left : r.right;
      const near = q && Math.min(r.bottom, q.bottom) > Math.max(r.top, q.top) ? (position === "before" ? q.right : q.left) : edge;
      return { x: (edge + near) / 2, y: r.top, width: 0, height: r.height };
    }
    const edge = position === "before" ? r.top : r.bottom;
    const near = q && Math.min(r.right, q.right) > Math.max(r.left, q.left) ? (position === "before" ? q.bottom : q.top) : edge;
    return { x: r.left, y: (edge + near) / 2, width: r.width, height: 0 };
  };

  // A block's box, whether its siblings sit beside it, and whether it has any; null for inline text and empty boxes.
  const levelOf = (el: Element): GapLevel | null => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || /^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName) || getComputedStyle(el).display === "inline") return null;
    const sib = shownSibling(el, "previousElementSibling") ?? shownSibling(el, "nextElementSibling");
    let row = false;
    if (sib) {
      const q = sib.getBoundingClientRect();
      row = Math.min(r.bottom, q.bottom) > Math.max(r.top, q.top) && (q.left >= r.right - 1 || q.right <= r.left + 1);
    }
    return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, row, siblings: sib !== null };
  };
  // The gap under the pointer. In the space between an element's children (`childGap`), the nearest child's edge;
  // otherwise the hovered element and its block ancestors, and `gapChoice` picks the level. Variant sets are skipped.
  const gapAt = (cx: number, cy: number): { el: Element; position: "before" | "after"; row: boolean } | null => {
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit.closest("[data-cubiq-variant]")) return null;
    const kidEls: Element[] = [];
    const kids: GapLevel[] = [];
    for (let i = 0; i < hit.children.length; i++) {
      const k = hit.children[i] as Element;
      const lv = levelOf(k);
      if (!lv) continue;
      kidEls.push(k);
      kids.push(lv);
    }
    const between = kids.length ? childGap(kids, cx, cy) : null;
    if (between) return { el: kidEls[between.index] as Element, position: between.position, row: (kids[between.index] as GapLevel).row };
    const els: Element[] = [];
    const chain: GapLevel[] = [];
    for (let el: Element | null = hit; el && el !== document.body && el !== document.documentElement && els.length < 12; el = el.parentElement) {
      const lv = levelOf(el);
      if (!lv) continue;
      els.push(el);
      chain.push(lv);
    }
    const choice = gapChoice(chain, cx, cy);
    return choice ? { el: els[choice.level] as Element, position: choice.position, row: (chain[choice.level] as GapLevel).row } : null;
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
  // Esc with a selection and no tool on (a Detect pin or Layers picked it): clear it. The page keeps the key.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || stopSelect || selected.length === 0) return;
    selected = [];
    redraw();
    report(0);
  });
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return;
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      x?: unknown;
      y?: unknown;
      on?: unknown;
      ok?: unknown;
      set?: unknown;
      n?: unknown;
      edit?: unknown;
      attr?: unknown;
      var?: unknown;
      value?: unknown;
      targets?: unknown;
      pins?: unknown;
      findings?: unknown;
      target?: unknown;
      prop?: unknown;
      color?: unknown;
      nonce?: unknown;
      key?: unknown;
      alt?: unknown;
      path?: unknown;
      id?: unknown;
      changes?: unknown;
      name?: unknown;
      names?: unknown;
      base?: unknown;
      html?: unknown;
      restyle?: unknown;
    } | null;
    if (!data || data.source !== "cubiq-canvas") return;
    if (data.type === "patch") {
      // The file changed under the page (an edit, undo, or the agent): bring the page to it in place, so nothing flashes.
      // The canvas reloads instead when this says no.
      const seq = typeof data.n === "number" ? data.n : 0;
      const base = typeof data.base === "string" && data.base.length <= 8_000_000 ? data.base : null;
      const html = typeof data.html === "string" && data.html.length <= 8_000_000 ? data.html : null;
      const done = (ok: boolean, reason?: string): void => post("patched", { ok, n: seq, ...(reason ? { reason } : {}) });
      if (base === null || html === null) return done(false, "input");
      const parse = (text: string): Document => new DOMParser().parseFromString(text, "text/html");
      const own = (n: Node): boolean => {
        if (n === bridgeScript) return true;
        if (n.nodeType !== 1) return false;
        const el = n as Element;
        return el.id === "cubiq-variant-style" || el.id === "cubiq-device-chrome" || el.hasAttribute("data-cubiq-finding");
      };
      let result: PatchResult;
      try {
        result = base === html ? { ok: true, roots: [] } : patchDocument(document, parse(base), parse(html), own);
      } catch {
        return done(false, "error");
      }
      if (!result.ok) return done(false, result.reason);
      // Kit widgets in what came in new are drawn by the kit's script, which listens for this; one that doesn't means reload.
      const widgets = result.roots.filter((r) => r.matches("[data-ui]") || r.querySelector("[data-ui]") !== null);
      if (widgets.length) {
        const ev = new CustomEvent("kit:refresh", { detail: { roots: widgets }, cancelable: true });
        document.dispatchEvent(ev);
        if (!ev.defaultPrevented && document.querySelector('script[src$="ui.js"]')) return done(false, "kit");
      }
      // A theme switch rewrote the stylesheets the page links: each loads again, and the old one goes once it has.
      if (data.restyle === true) {
        // A copy that fails (the file was mid-rewrite) goes instead, and the old sheet stays until a retry loads.
        const swap = (link: Element, tries: number): void => {
          const copy = link.cloneNode() as HTMLLinkElement;
          copy.setAttribute("href", restyledHref(link.getAttribute("href") || "", Date.now()));
          copy.addEventListener(
            "load",
            () => {
              link.remove();
              // The panel's colours follow the new sheet.
              themeRead?.();
            },
            { once: true },
          );
          copy.addEventListener(
            "error",
            () => {
              copy.remove();
              if (tries < 4) setTimeout(() => link.isConnected && swap(link, tries + 1), 200 * (tries + 1));
            },
            { once: true },
          );
          link.after(copy);
        };
        document.querySelectorAll('link[rel~="stylesheet"][href]').forEach((link) => {
          if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link.getAttribute("href") || "")) return;
          swap(link, 0);
        });
      }
      selected = selected.filter((el) => el.isConnected);
      redraw();
      // What a load reports, again: Layers, the page's tweaks and its variant sets follow the new page.
      reportTweaks();
      reportOutline();
      findVariants();
      done(true);
      return;
    }
    if (data.type === "restore-scroll") {
      const x = typeof data.x === "number" ? data.x : 0;
      const y = typeof data.y === "number" ? data.y : 0;
      const restore = (): void => window.scrollTo(x, y);
      restore();
      if (document.readyState === "loading") window.addEventListener("load", restore, { once: true });
    } else if (data.type === "pick") {
      allowEdit = data.edit !== false;
      if (typeof data.color === "string" && /^[#(),.%\w\s-]{1,40}$/.test(data.color)) selectColor = data.color;
      if (data.on) startSelectV2();
      else stopSelect?.();
    } else if (data.type === "session") {
      if (typeof data.nonce === "string" && data.nonce.length <= 64) nonce = data.nonce;
    } else if (data.type === "hit-test") {
      const x = typeof data.x === "number" ? data.x : -1;
      const y = typeof data.y === "number" ? data.y : -1;
      const el = document.elementFromPoint(x, y);
      post("hit-result", { element: el && el !== document.body && el !== document.documentElement ? describeElement(componentOf(el), selectorFor) : null });
    } else if (data.type === "key") {
      if (typeof data.key === "string") stepKey?.(data.key, data.alt === true);
    } else if (data.type === "stamp") {
      if (!Array.isArray(data.path) || typeof data.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(data.id)) return;
      let el: Element | null = document.documentElement;
      for (const at of data.path as unknown[]) el = typeof at === "number" ? (el?.children[at] ?? null) : null;
      if (!el) return;
      el.setAttribute("data-agent-id", data.id);
      if (selected.indexOf(el) >= 0) report(0);
    } else if (data.type === "apply-style") {
      const el = targetOf(data.target) as HTMLElement | null;
      if (!el || !Array.isArray(data.changes)) return;
      for (const raw of (data.changes as unknown[]).slice(0, 32)) {
        const c = raw as { prop?: unknown; value?: unknown } | null;
        if (typeof c?.prop !== "string" || typeof c.value !== "string" || !/^(--[a-z0-9-]+|[a-z-]+)$/.test(c.prop)) continue;
        if (c.value.length > 300 || /[;{}<>"'\\]/.test(c.value) || /(url|expression)\s*\(/i.test(c.value)) continue;
        if (c.value === "") el.style.removeProperty(c.prop);
        else el.style.setProperty(c.prop, c.value);
      }
      reportSoon();
    } else if (data.type === "apply-attr") {
      const el = targetOf(data.target) as HTMLInputElement | null;
      if (!el || typeof data.name !== "string" || !/^(data-[a-z0-9-]{1,40}|disabled|placeholder|value)$/.test(data.name)) return;
      if (data.value !== null && (typeof data.value !== "string" || data.value.length > 2000)) return;
      if (data.value === null) el.removeAttribute(data.name);
      else el.setAttribute(data.name, data.value);
      if (data.name === "value") el.value = data.value ?? "";
      reportSoon();
    } else if (data.type === "apply-text") {
      const el = targetOf(data.target);
      if (!el || typeof data.value !== "string" || data.value.length > 2000) return;
      const holder = textHolder(el);
      if (!holder) return;
      const whole = (holder.textContent ?? "").trim().slice(0, 40);
      const run = holder.children.length > 0 ? Array.from(holder.childNodes).find((c) => c.nodeType === 3 && (c.nodeValue ?? "").trim() !== "") : null;
      const before = (run ? run.nodeValue : holder.textContent) ?? "";
      if (before === data.value) return;
      if (run) run.nodeValue = data.value;
      else holder.textContent = data.value;
      postText(holder, before, data.value, whole, true);
      reportSoon();
    } else if (data.type === "read-theme") {
      if (!Array.isArray(data.names)) return;
      const names = (data.names as unknown[]).filter((name): name is string => typeof name === "string" && /^--[a-z0-9-]{1,48}$/.test(name)).slice(0, 200);
      const send = (): void => {
        const style = getComputedStyle(document.documentElement);
        const tokens: Record<string, string> = {};
        for (const name of names) tokens[name] = style.getPropertyValue(name).trim().slice(0, 120);
        // A page with one scheme only (e.g. a dark-native reference) says which, so Appearance shows the truth.
        const only = style.colorScheme.trim();
        post("theme", only === "dark" || only === "light" ? { tokens, scheme: only } : { tokens });
      };
      send();
      // The scheme can change under the page (the app's theme, or the panel's Appearance): the panel hears the new values.
      if (!themeWatch) {
        themeWatch = matchMedia("(prefers-color-scheme: dark)");
        themeWatch.addEventListener("change", () => themeRead?.());
      }
      themeRead = send;
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
    } else if (data.type === "set-findings") {
      setFindings(data.findings);
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
    } else if (data.type === "show-variant") {
      if (typeof data.set === "string" && typeof data.n === "number" && Number.isInteger(data.n)) showVariant(data.set, data.n);
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
  return `(${designBridge.toString()})(${selectorFor.toString()}, ${describeElement.toString()}, ${snapTarget.toString()}, ${resolveTarget.toString()}, ${editableText.toString()}, ${outlineOf.toString()}, ${gapChoice.toString()}, ${childGap.toString()}, ${isSelectableElement.toString()}, ${componentOf.toString()}, ${drillTarget.toString()}, ${parentComponent.toString()}, ${clickTarget.toString()}, ${textHolder.toString()}, ${patchDocument.toString()}, ${restyledHref.toString()});`;
}
