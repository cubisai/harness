// Source-preserving edits to a design page. parse5 only ever finds byte offsets; every change is a
// string splice, so the bytes outside the edit (whitespace, comments, quoting, doctype) stay identical.

import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { DesignChange, InsertPosition, TargetLocator } from "../../shared/design-mutation";
import { decodeEntities, escapeText } from "./textedit";

type TreeMap = DefaultTreeAdapterMap;
type Document = TreeMap["document"];
type Element = TreeMap["element"];
type ParentNode = TreeMap["parentNode"];
type ChildNode = TreeMap["childNode"];
type ElementLocation = NonNullable<Element["sourceCodeLocation"]>;
type StartTagLocation = NonNullable<ElementLocation["startTag"]>;
type AttrLocation = NonNullable<ElementLocation["attrs"]>[string];

/** A refusal: `stale`/`ambiguous` mean the target cannot be named unambiguously, `invalid` the change itself. */
export class SourceEditError extends Error {
  constructor(
    readonly reason: "stale" | "ambiguous" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "SourceEditError";
  }
}

/** What a successful edit produced. */
export interface EditOutcome {
  html: string;
  targetId: string;
  stampedId?: string;
  createdIds?: string[];
}

/** The smallest single splice turning `before` into `after`. */
export interface TextPatch {
  start: number;
  removed: string;
  inserted: string;
}

const MAX_TEXT_CHARS = 2000;
const MAX_ATTR_CHARS = 2000;
const MAX_STYLE_CHARS = 120;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROP_NAME_RE = /^[a-z][a-z0-9:_.-]*$/i;
const STYLE_PROP_RE = /^(--[a-z0-9-]+|[a-z-]+)$/;
const WRAP_TAG_RE = /^[a-z][a-z0-9-]*$/;
const BANNED_PROPS = new Set(["style", "data-agent-id", "srcdoc"]);
const SCHEME_PROPS = new Set(["href", "src", "action", "formaction", "xlink:href"]);
const BANNED_SCHEMES = ["javascript:", "data:", "vbscript:"];
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const BANNED_TEXT_TAGS = new Set(["script", "style", "textarea"]);
const UNSTRUCTURABLE = new Set(["html", "head", "body"]);
const WRAP_TAGS = new Set(["div", "section", "article", "main", "header", "footer", "aside", "nav"]);
const INSERT_BANNED_TAGS = new Set(["script", "iframe", "object", "embed", "base", "meta", "link"]);

// --- patch diff ----------------------------------------------------------------------------------

/** The smallest single splice turning `before` into `after`, never splitting a surrogate pair. */
export function diffPatch(before: string, after: string): TextPatch {
  if (before === after) return { start: 0, removed: "", inserted: "" };

  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;

  const last = max - prefix;
  let suffix = 0;
  while (
    suffix < last &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;

  return {
    start: prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
  };
}

/** Splice a patch into a page, refusing if the bytes it expects to replace are not there. */
export function applyPatch(html: string, patch: TextPatch): string {
  if (html.slice(patch.start, patch.start + patch.removed.length) !== patch.removed) {
    throw new SourceEditError("stale", "The page changed since you started editing; try again.");
  }
  return html.slice(0, patch.start) + patch.inserted + html.slice(patch.start + patch.removed.length);
}

/** The patch that undoes `patch`. */
export function invertPatch(patch: TextPatch): TextPatch {
  return { start: patch.start, removed: patch.inserted, inserted: patch.removed };
}

// --- target resolution ---------------------------------------------------------------------------

/**
 * Name the target element: an existing unique `data-agent-id`, or a locator that is found and stamped
 * with a fresh id. Refuses when the element cannot be named unambiguously.
 */
export function resolveTarget(
  html: string,
  target: { id: string } | { locator: TargetLocator },
  newId: () => string,
): { html: string; id: string; stampedId?: string } {
  const root = parse(html, { sourceCodeLocationInfo: true });

  if ("id" in target) {
    const id = target.id;
    if (!ID_RE.test(id)) throw invalid("That element id is not a valid id.");
    const count = countIds(root, id);
    if (count === 0) throw new SourceEditError("stale", "That element is no longer in the page.");
    if (count > 1) throw new SourceEditError("ambiguous", "More than one element has that id.");
    return { html, id };
  }

  const element = locate(root, target.locator);
  if (!element) throw new SourceEditError("stale", "That spot in the page no longer holds that element.");

  const existing = findAttr(element, "data-agent-id");
  if (existing) {
    const id = existing.value.trim();
    if (!ID_RE.test(id)) throw invalid("That element id is not a valid id.");
    const count = countIds(root, id);
    if (count === 0) throw new SourceEditError("stale", "That element is no longer in the page.");
    if (count > 1) throw new SourceEditError("ambiguous", "More than one element has that id.");
    return { html, id };
  }

  const stampAt = tagNameEnd(html, element);
  if (stampAt === null) throw invalid("That element cannot be given an id.");
  const fresh = uniqueId(allIds(root), newId);
  const next = splice(html, stampAt, 0, ` data-agent-id="${fresh}"`);
  return { html: next, id: fresh, stampedId: fresh };
}

/** Resolve the target, then apply one change to it. */
export function applyChange(
  html: string,
  target: { id: string } | { locator: TargetLocator },
  change: DesignChange,
  newId: () => string,
): EditOutcome {
  const resolved = resolveTarget(html, target, newId);
  const root = parse(resolved.html, { sourceCodeLocationInfo: true });
  const element = findById(root, resolved.id);
  if (!element) throw new SourceEditError("stale", "That element is no longer in the page.");

  const applied = applyOne({ html: resolved.html, root, element, newId }, change);

  const outcome: EditOutcome = { html: applied.html, targetId: resolved.id };
  if (resolved.stampedId !== undefined) outcome.stampedId = resolved.stampedId;
  if (applied.createdIds !== undefined) outcome.createdIds = applied.createdIds;
  return outcome;
}

interface Context {
  html: string;
  root: Document;
  element: Element;
  newId: () => string;
}

interface Applied {
  html: string;
  createdIds?: string[];
}

/** Run one change; anything it cannot do refuses with `invalid`. */
function applyOne(ctx: Context, change: DesignChange): Applied {
  switch (change.kind) {
    case "setProp":
      return { html: setAttribute(ctx.html, ctx.element, change.name, change.value) };
    case "setStyle":
      return { html: setStyle(ctx.html, ctx.element, change.changes) };
    case "setText":
      return { html: setText(ctx.html, ctx.element, change.before, change.after) };
    case "insert":
      return insertContent(ctx, change.html, change.position);
    case "remove":
      return { html: removeElement(ctx.html, ctx.element) };
    case "move":
      return { html: moveElement(ctx, change.refId, change.position) };
    case "wrap":
      return wrapElement(ctx, change.extraIds, change.tag, change.attrs);
    case "unwrap":
      return { html: unwrapElement(ctx.html, ctx.element) };
  }
}

// --- setProp -------------------------------------------------------------------------------------

/** Set (`null` removes) one attribute, splicing only that attribute's bytes. */
function setAttribute(html: string, element: Element, name: string, value: string | null): string {
  if (!PROP_NAME_RE.test(name)) throw invalid(`"${name}" is not a valid attribute name.`);
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) throw invalid(`Attributes starting with "on" are not allowed.`);
  if (BANNED_PROPS.has(lower)) throw invalid(`"${name}" cannot be set here.`);
  if (value !== null) checkValue(lower, value);

  const range = attrRange(html, element, lower);

  if (value === null) {
    if (!range) return html;
    const from = whitespaceBefore(html, range.start);
    return html.slice(0, from) + html.slice(range.end);
  }

  if (range) {
    // Keep the name's original case, and only replace the value part of the range.
    return rewriteAttr(html, range, escapeAttribute(value));
  }

  const at = attributeInsertPoint(html, element);
  if (at === null) throw invalid("That element's start tag cannot be edited.");
  return splice(html, at, 0, ` ${name}="${escapeAttribute(value)}"`);
}

function checkValue(lowerName: string, value: string): void {
  if (value.length > MAX_ATTR_CHARS) throw invalid("That value is too long.");
  if (SCHEME_PROPS.has(lowerName) && hasBannedScheme(value)) {
    throw invalid(`"${lowerName}" cannot point at a script or inline document.`);
  }
}

// --- setStyle ------------------------------------------------------------------------------------

function setStyle(html: string, element: Element, changes: { prop: string; value: string }[]): string {
  if (changes.length < 1 || changes.length > 32) throw invalid("A style edit needs 1 to 32 declarations.");
  const updates = new Map<string, string>();
  for (const { prop, value } of changes) {
    if (!STYLE_PROP_RE.test(prop)) throw invalid(`"${prop}" is not a valid style property.`);
    checkStyleValue(prop, value);
    updates.set(prop, value.trim());
  }

  const range = attrRange(html, element, "style");
  const existing = findAttr(element, "style");
  const declarations = existing ? splitDeclarations(existing.value) : [];

  const kept: { prop: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const update = updates.get(declaration.prop);
    if (update === undefined) {
      kept.push(declaration);
      continue;
    }
    seen.add(declaration.prop);
    if (update !== "") kept.push({ prop: declaration.prop, value: update });
  }
  for (const [prop, value] of updates) {
    if (seen.has(prop) || value === "") continue;
    kept.push({ prop, value });
  }

  const body = kept.map((d) => `${d.prop}: ${d.value}`).join("; ");

  if (body === "" && range) {
    const from = whitespaceBefore(html, range.start);
    return html.slice(0, from) + html.slice(range.end);
  }
  if (body === "") return html;

  if (range) {
    return rewriteAttr(html, range, escapeAttribute(body));
  }

  const at = attributeInsertPoint(html, element);
  if (at === null) throw invalid("That element's start tag cannot be edited.");
  return splice(html, at, 0, ` style="${escapeAttribute(body)}"`);
}

function checkStyleValue(prop: string, raw: string): void {
  const value = raw.trim();
  if (value.length > MAX_STYLE_CHARS) throw invalid(`That ${prop} value is too long.`);
  if (/[;{}<>"'\\]/.test(value)) throw invalid(`That ${prop} value contains a character that is not allowed.`);
  if (/url\s*\(/i.test(value) || /expression\s*\(/i.test(value)) {
    throw invalid(`That ${prop} value cannot reference a URL or script.`);
  }
}

function splitDeclarations(raw: string): { prop: string; value: string }[] {
  const out: { prop: string; value: string }[] = [];
  for (const part of raw.split(";")) {
    const text = part.trim();
    if (!text) continue;
    const colon = text.indexOf(":");
    if (colon === -1) continue;
    const prop = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    if (!prop || !value) continue;
    out.push({ prop, value });
  }
  return out;
}

// --- setText -------------------------------------------------------------------------------------

function setText(html: string, element: Element, before: string, after: string): string {
  if (after.length > MAX_TEXT_CHARS) throw invalid("The new text is too long.");

  const tag = element.tagName.toLowerCase();
  if (BANNED_TEXT_TAGS.has(tag)) throw invalid(`A <${tag}>'s text cannot be edited here.`);
  if (VOID_TAGS.has(tag)) throw invalid(`A <${tag}> has no text.`);
  const loc = element.sourceCodeLocation;
  if (!loc || !loc.startTag || !loc.endTag) throw invalid("That element has no closing tag.");

  for (const child of element.childNodes) {
    if (child.nodeName === "#comment") throw invalid("That element holds a comment; it cannot be edited as text.");
    if (child.nodeName !== "#text") throw invalid("That element holds more than text.");
  }

  const from = loc.startTag.endOffset;
  const to = loc.endTag.startOffset;
  const raw = html.slice(from, to);
  if (decodeEntities(raw) !== before) {
    throw new SourceEditError("stale", "The text changed since you started editing; try again.");
  }
  return splice(html, from, to - from, escapeText(after));
}

// --- insert --------------------------------------------------------------------------------------

function insertContent(ctx: Context, fragmentHtml: string, position: InsertPosition): Applied {
  const fragment = stampFragment(fragmentHtml, ctx.root, ctx.newId);

  const tag = ctx.element.tagName.toLowerCase();
  if (position === "before" || position === "after") {
    if (UNSTRUCTURABLE.has(tag)) throw invalid(`Content cannot be inserted next to <${tag}>.`);
  }
  const offset = placementOffset(ctx.element, position);
  if (offset === null) throw invalid("That element cannot hold content there.");

  return { html: splice(ctx.html, offset, 0, fragment.html), createdIds: fragment.ids };
}

function placementOffset(element: Element, position: InsertPosition): number | null {
  const loc = element.sourceCodeLocation;
  if (!loc) return null;
  if (position === "before") return loc.startOffset;
  if (position === "after") return loc.endOffset;
  if (VOID_TAGS.has(element.tagName.toLowerCase())) return null;
  const startTag = loc.startTag;
  const endTag = loc.endTag;
  if (!startTag || !endTag) return null;
  return position === "inside-start" ? startTag.endOffset : endTag.startOffset;
}

interface StampedFragment {
  html: string;
  ids: string[];
}

/** Refuse banned markup in a fragment; stamp every root element that has no id yet. */
function stampFragment(fragmentHtml: string, root: Document, newId: () => string): StampedFragment {
  const fragment = parseFragment(fragmentHtml, { sourceCodeLocationInfo: true });
  const roots: Element[] = [];
  for (const node of fragment.childNodes) {
    if (isElement(node)) roots.push(node);
  }
  if (roots.length === 0) throw invalid("That content has no element in it.");

  const ids = allIds(root);
  for (const node of fragment.childNodes) {
    if (!isElement(node)) continue;
    inspect(node, ids);
  }

  const stamps: { at: number; id: string }[] = [];
  const created: string[] = [];
  for (const element of roots) {
    if (findAttr(element, "data-agent-id")) continue;
    const at = tagNameEnd(fragmentHtml, element);
    if (at === null) throw invalid("That content cannot be given an id.");
    const id = uniqueId(ids, newId);
    ids.add(id);
    stamps.push({ at, id });
    created.push(id);
  }

  let html = fragmentHtml;
  // Apply the later offsets first so an earlier insert never shifts a later one.
  for (const stamp of [...stamps].sort((a, b) => b.at - a.at)) {
    html = splice(html, stamp.at, 0, ` data-agent-id="${stamp.id}"`);
  }
  return { html, ids: created };
}

/** Refuse banned elements, attributes and schemes anywhere in the inserted tree. */
function inspect(element: Element, pageIds: Set<string>): void {
  const tag = element.tagName.toLowerCase();
  if (INSERT_BANNED_TAGS.has(tag)) throw invalid(`A <${tag}> cannot be inserted here.`);

  for (const attr of element.attrs) {
    const name = `${attr.prefix ? `${attr.prefix}:` : ""}${attr.name}`;
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) throw invalid(`Attributes starting with "on" are not allowed.`);
    if (lower === "srcdoc") throw invalid("A srcdoc attribute is not allowed.");
    if (SCHEME_PROPS.has(lower) && hasBannedScheme(attr.value)) {
      throw invalid(`"${lower}" cannot point at a script or inline document.`);
    }
    if (lower === "data-agent-id") {
      const id = attr.value.trim();
      if (!ID_RE.test(id)) throw invalid(`"${id}" is not a valid element id.`);
      if (pageIds.has(id)) throw invalid(`The page already has an element with the id "${id}".`);
    }
  }

  for (const child of childList(element)) {
    if (isElement(child)) inspect(child, pageIds);
  }
}

// --- remove --------------------------------------------------------------------------------------

function removeElement(html: string, element: Element): string {
  const loc = element.sourceCodeLocation;
  if (!loc) throw new SourceEditError("stale", "That element is not in the page's source.");
  if (UNSTRUCTURABLE.has(element.tagName.toLowerCase())) throw invalid(`The <${element.tagName}> cannot be removed.`);

  const from = lineStartBefore(html, loc.startOffset);
  return splice(html, from, loc.endOffset - from, "");
}

// --- move ----------------------------------------------------------------------------------------

/** Move `ctx.element` next to the element named by `refId`; `position` is relative to that reference. */
function moveElement(ctx: Context, refId: string, position: InsertPosition): string {
  if (!ID_RE.test(refId)) throw invalid("That element id is not a valid id.");
  const count = countIds(ctx.root, refId);
  if (count === 0) throw new SourceEditError("stale", "The element to move next to is no longer in the page.");
  if (count > 1) throw new SourceEditError("ambiguous", "More than one element has that id.");

  const moving = ctx.element;
  const ref = findById(ctx.root, refId);
  if (!ref) throw new SourceEditError("stale", "The element to move next to is no longer in the page.");

  const movingTag = moving.tagName.toLowerCase();
  if (UNSTRUCTURABLE.has(movingTag)) throw invalid(`Content cannot be moved next to <${movingTag}>.`);
  if (ref === moving || contains(moving, ref)) throw invalid("An element cannot be moved inside itself.");

  if (position === "before" || position === "after") {
    const refTag = ref.tagName.toLowerCase();
    if (UNSTRUCTURABLE.has(refTag)) throw invalid(`Content cannot be moved next to <${refTag}>.`);
  }

  const movingLoc = moving.sourceCodeLocation;
  if (!movingLoc) throw new SourceEditError("stale", "The element to move is not in the page's source.");
  const destination = placementOffset(ref, position);
  if (destination === null) throw invalid("That element cannot hold content there.");

  const from = lineStartBefore(ctx.html, movingLoc.startOffset);
  const to = movingLoc.endOffset;
  // The exact source of the element, without the whitespace before it.
  const moved = ctx.html.slice(movingLoc.startOffset, to);

  if (destination > from && destination < to) throw invalid("An element cannot be moved inside itself.");

  let html = ctx.html;
  // Apply the later offset first so the earlier splice never shifts the later one.
  if (destination >= to) {
    html = splice(html, destination, 0, moved);
    return splice(html, from, to - from, "");
  }
  html = splice(html, from, to - from, "");
  return splice(html, destination, 0, moved);
}

// --- wrap ----------------------------------------------------------------------------------------

function wrapElement(ctx: Context, extraIds: string[], tag: string, attrs: Record<string, string>): Applied {
  if (!WRAP_TAG_RE.test(tag) || !WRAP_TAGS.has(tag)) throw invalid(`A <${tag}> wrapper is not allowed.`);
  const rendered = renderWrapAttrs(attrs);

  const node = ctx.element;
  if (UNSTRUCTURABLE.has(node.tagName.toLowerCase())) throw invalid(`The <${node.tagName}> cannot be wrapped.`);
  const parent = node.parentNode;

  const members: Element[] = [node];
  for (const id of extraIds) {
    if (!ID_RE.test(id)) throw invalid("A sibling id is not a valid id.");
    const count = countIds(ctx.root, id);
    if (count === 0) throw new SourceEditError("stale", "A sibling to wrap is no longer in the page.");
    if (count > 1) throw new SourceEditError("ambiguous", "More than one element has that id.");
    const extra = findById(ctx.root, id);
    if (extra) members.push(extra);
  }

  const ordered = parent ? orderSiblings(parent, members) : null;
  if (!ordered) throw invalid("The elements to wrap are not siblings in one run.");
  if (ordered.some((e) => UNSTRUCTURABLE.has(e.tagName.toLowerCase()))) {
    throw invalid("The page's frame cannot be wrapped.");
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) throw invalid("The elements to wrap are not siblings in one run.");
  const firstLoc = first.sourceCodeLocation;
  const lastLoc = last.sourceCodeLocation;
  if (!firstLoc || !lastLoc || !firstLoc.endTag || !lastLoc.endTag) {
    throw invalid("The elements to wrap need real start and end tags.");
  }

  const wrapperId = uniqueId(allIds(ctx.root), ctx.newId);
  const open = `<${tag}${rendered} data-agent-id="${wrapperId}">`;
  const close = `</${tag}>`;

  let html = splice(ctx.html, firstLoc.startOffset, 0, open);
  html = splice(html, lastLoc.endOffset + open.length, 0, close);
  return { html, createdIds: [wrapperId] };
}

/** Validate a wrapper's attributes and render them; `style` follows the setStyle value checks. */
function renderWrapAttrs(attrs: Record<string, string>): string {
  let rendered = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (!PROP_NAME_RE.test(name)) throw invalid(`"${name}" is not a valid attribute name.`);
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) throw invalid(`Attributes starting with "on" are not allowed.`);
    if (lower === "style") {
      for (const part of value.split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        const prop = part.slice(0, colon).trim();
        if (!STYLE_PROP_RE.test(prop)) throw invalid(`"${prop}" is not a valid style property.`);
      }
      checkStyleValue("style", value);
    } else {
      if (BANNED_PROPS.has(lower)) throw invalid(`"${name}" cannot be set here.`);
      checkValue(lower, value);
    }
    rendered += ` ${name}="${escapeAttribute(value)}"`;
  }
  return rendered;
}

/** Order `members` by source position, refusing unless they are siblings in one whitespace/comment run. */
function orderSiblings(parent: ParentNode, members: Element[]): Element[] | null {
  const unique: Element[] = [];
  for (const member of members) {
    if (member.parentNode !== parent) return null;
    if (!unique.includes(member)) unique.push(member);
  }
  if (unique.some((e) => !e.sourceCodeLocation)) return null;

  const children = childList(parent);
  const positions = unique.map((element) => children.indexOf(element));
  if (positions.some((p) => p === -1)) return null;

  const min = Math.min(...positions);
  const max = Math.max(...positions);
  for (let i = min; i <= max; i++) {
    const child = children[i];
    if (!child) return null;
    // An element outside `unique` sits in the run: the members are not one contiguous run.
    if (isElement(child) && !unique.includes(child)) return null;
    if (isText(child) && /\S/.test(child.value)) return null; // real text between the members
  }

  const byPosition = unique
    .map((element) => ({ element, at: element.sourceCodeLocation?.startOffset ?? -1 }))
    .sort((a, b) => a.at - b.at);
  return byPosition.map((entry) => entry.element);
}

// --- unwrap --------------------------------------------------------------------------------------

function unwrapElement(html: string, element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (UNSTRUCTURABLE.has(tag)) throw invalid(`The <${tag}> cannot be unwrapped.`);
  if (VOID_TAGS.has(tag)) throw invalid(`A <${tag}> has no content to keep.`);
  const loc = element.sourceCodeLocation;
  if (!loc || !loc.startTag || !loc.endTag) throw invalid("That element has no closing tag.");
  if (!childList(element).some(isElement)) throw invalid("That element has no child elements.");

  const inner = html.slice(loc.startTag.endOffset, loc.endTag.startOffset);
  return html.slice(0, loc.startOffset) + inner + html.slice(loc.endTag.endOffset);
}

// --- element walking -----------------------------------------------------------------------------

/** The `<html>` element, or null. */
function htmlElement(root: Document): Element | null {
  for (const node of root.childNodes) {
    if (isElement(node) && node.tagName.toLowerCase() === "html") return node;
  }
  return null;
}

/** Walk the locator's element-child path from `<html>`, then check tag and text. */
function locate(root: Document, locator: TargetLocator): Element | null {
  let current: Element | null = htmlElement(root);
  if (!current) return null;
  for (const index of locator.path) {
    if (!Number.isInteger(index) || index < 0) return null;
    const next: Element | undefined = childElements(current)[index];
    if (!next) return null;
    current = next;
  }
  return matchesLocator(current, locator) ? current : null;
}

function matchesLocator(element: Element, locator: TargetLocator): boolean {
  if (!element.sourceCodeLocation) return false;
  if (element.tagName.toLowerCase() !== locator.tag.toLowerCase()) return false;
  if (locator.text !== undefined && !textContent(element).trim().startsWith(locator.text)) return false;
  return true;
}

/** The child nodes of a parent, descending into a `<template>`'s contents. */
function childList(parent: ParentNode): ChildNode[] {
  if (isTemplate(parent)) return parent.content.childNodes;
  return parent.childNodes;
}

function childElements(parent: ParentNode): Element[] {
  const out: Element[] = [];
  for (const child of childList(parent)) {
    if (isElement(child)) out.push(child);
  }
  return out;
}

function textContent(element: Element): string {
  let text = "";
  for (const child of childList(element)) {
    if (isText(child)) text += child.value;
    else if (isElement(child)) text += textContent(child);
  }
  return text;
}

function isElement(node: ChildNode | null | undefined): node is Element {
  return node !== null && node !== undefined && typeof (node as Element).tagName === "string";
}

function isText(node: ChildNode | null | undefined): node is TreeMap["textNode"] {
  return node !== null && node !== undefined && node.nodeName === "#text";
}

/** A `<template>` element: its children live in its `content` fragment. */
function isTemplate(parent: ParentNode): parent is TreeMap["template"] {
  return typeof (parent as TreeMap["template"]).content === "object" && (parent as TreeMap["template"]).content !== null;
}

/** True when `outer` is `inner` or one of its ancestors. */
function contains(outer: Element, inner: Element): boolean {
  let current: ParentNode | null | undefined = inner;
  while (current !== null && current !== undefined) {
    if (current === outer) return true;
    current = "parentNode" in current ? (current.parentNode as ParentNode | null | undefined) : undefined;
  }
  return false;
}

function findById(root: Document, id: string): Element | null {
  let found: Element | null = null;
  walkElements(root, (element) => {
    if (found) return;
    const attr = findAttr(element, "data-agent-id");
    if (attr && attr.value.trim() === id) found = element;
  });
  return found;
}

function countIds(root: Document, id: string): number {
  let count = 0;
  walkElements(root, (element) => {
    const attr = findAttr(element, "data-agent-id");
    if (attr && attr.value.trim() === id) count++;
  });
  return count;
}

function allIds(root: Document): Set<string> {
  const ids = new Set<string>();
  walkElements(root, (element) => {
    const attr = findAttr(element, "data-agent-id");
    const id = attr ? attr.value.trim() : "";
    if (ID_RE.test(id)) ids.add(id);
  });
  return ids;
}

function walkElements(root: Document, visit: (element: Element) => void): void {
  const walk = (parent: ParentNode): void => {
    for (const child of childList(parent)) {
      if (!isElement(child)) continue;
      visit(child);
      walk(child);
    }
  };
  walk(root);
}

// --- attributes and tag geometry -----------------------------------------------------------------

function findAttr(element: Element, name: string): { name: string; value: string } | null {
  const lower = name.toLowerCase();
  for (const attr of element.attrs) {
    const full = `${attr.prefix ? `${attr.prefix}:` : ""}${attr.name}`;
    if (full.toLowerCase() === lower) return { name: full, value: attr.value };
  }
  return null;
}

interface AttrRange {
  start: number;
  end: number;
  /** Offset of the opening quote of the value, or `end` for a value-less attribute. */
  valueAt: number;
}

/** Rewrite an attribute's value, keeping the name's original spelling and adding an `=` when missing. */
function rewriteAttr(html: string, range: AttrRange, escaped: string): string {
  if (range.valueAt >= range.end) {
    // Value-less attribute: keep the name's bytes and add `="value"`.
    return html.slice(0, range.end) + `="${escaped}"` + html.slice(range.end);
  }
  const head = html.slice(range.start, range.valueAt);
  return html.slice(0, range.start) + head + `"${escaped}"` + html.slice(range.end);
}

/** One attribute's byte range in the source, including its quotes. */
function attrRange(html: string, element: Element, lowerName: string): AttrRange | null {
  const locs = element.sourceCodeLocation?.attrs;
  const attr = locs ? locs[lowerName] : undefined;
  if (!attr) return null;
  // A value-less attribute (`<div hidden>`) has no `=`; rewrite it as a whole instead.
  const afterName = attr.startOffset + lowerName.length;
  const valueAt = html.charAt(afterName) === "=" ? afterName + 1 : attr.endOffset;
  return { start: attr.startOffset, end: attr.endOffset, valueAt };
}

/** The offset just past a start tag's name. */
function tagNameEnd(html: string, element: Element): number | null {
  const startTag = startTagLocation(element);
  if (!startTag) return null;
  for (let i = startTag.startOffset + 1; i < startTag.endOffset; i++) {
    const ch = html.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ">") return i;
    // A `/` only ends the name when it closes a self-closing tag, never inside `<a/b>`.
    if (ch === "/" && html.charAt(i + 1) === ">") return i;
  }
  return null;
}

/** Where a new attribute goes: after the last attribute, else directly after the tag name. */
function attributeInsertPoint(html: string, element: Element): number | null {
  const locs = element.sourceCodeLocation?.attrs;
  if (locs) {
    let last: AttrLocation | null = null;
    for (const attr of Object.values(locs)) {
      if (!last || attr.endOffset > last.endOffset) last = attr;
    }
    if (last) return last.endOffset;
  }
  return tagNameEnd(html, element);
}

function startTagLocation(element: Element): StartTagLocation | null {
  return element.sourceCodeLocation?.startTag ?? null;
}

/** Walk back over spaces, tabs and newlines to the start of the attribute's leading separator. */
function whitespaceBefore(html: string, at: number): number {
  let i = at;
  while (i > 0) {
    const ch = html.charAt(i - 1);
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") i--;
    else break;
  }
  return i;
}

/** Walk back over spaces and tabs to just past the previous newline; otherwise return `at`. */
function lineStartBefore(html: string, at: number): number {
  let i = at;
  while (i > 0) {
    const ch = html.charAt(i - 1);
    if (ch === " " || ch === "\t") i--;
    else break;
  }
  if (i === 0) return at;
  const before = html.charAt(i - 1);
  if (before === "\n") {
    // Include the newline, and a CRLF's `\r` too.
    return i > 1 && html.charAt(i - 2) === "\r" ? i - 2 : i - 1;
  }
  if (before === "\r") return i - 1;
  return at;
}

function hasBannedScheme(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return BANNED_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function uniqueId(existing: Set<string>, newId: () => string): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = newId();
    if (!ID_RE.test(candidate) || existing.has(candidate)) continue;
    existing.add(candidate);
    return candidate;
  }
  throw invalid("A fresh element id could not be generated.");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function splice(html: string, at: number, remove: number, insert: string): string {
  return html.slice(0, at) + insert + html.slice(at + remove);
}

function invalid(message: string): SourceEditError {
  return new SourceEditError("invalid", message);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
