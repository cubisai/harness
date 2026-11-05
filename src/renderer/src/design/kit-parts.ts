// What the canvas needs from a kit's components.json, and the pure rules for Swap, Insert, Wrap and the Layout card.
import { parse, parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

export type KitPartProp = { name: string; label?: string; type: "choice" | "boolean" | "text"; options?: string[]; default?: string | boolean };
export type KitPart = { ui: string; name: string; category: string; kind: "component" | "composition"; props: KitPartProp[]; snippet: string; importName: string | null; isNew?: boolean };

export type AttrChange = { name: string; value: string | null };

/** The kit's parts from its manifest text. A flat style has no manifest; anything unreadable counts as none. */
export function parseKitParts(text: string | null | undefined): KitPart[] {
  if (!text) return [];
  try {
    const raw = JSON.parse(text) as { components?: unknown };
    if (!Array.isArray(raw.components)) return [];
    return raw.components.flatMap((c: Record<string, unknown>) => {
      if (typeof c?.ui !== "string" || typeof c.snippet !== "string") return [];
      const imp = c.import as { name?: unknown } | undefined;
      return [
        {
          ui: c.ui,
          name: typeof c.name === "string" ? c.name : c.ui,
          category: typeof c.category === "string" && c.category ? c.category : "Other",
          kind: c.kind === "composition" ? ("composition" as const) : ("component" as const),
          props: Array.isArray(c.props) ? (c.props as KitPartProp[]) : [],
          snippet: c.snippet,
          importName: typeof imp?.name === "string" ? imp.name : null,
          ...(c.status === "new" ? { isNew: true } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

type Node5 = DefaultTreeAdapterMap["node"];
type El5 = DefaultTreeAdapterMap["element"];
const isEl = (n: Node5): n is El5 => "attrs" in n;
const kids = (n: Node5): Node5[] => ("childNodes" in n ? n.childNodes : []);
const elKids = (n: Node5): El5[] => kids(n).filter(isEl);
const attr = (el: El5, name: string): string | null => el.attrs.find((a) => a.name === name)?.value ?? null;
const textIn = (n: Node5): string => ("value" in n && n.nodeName === "#text" ? n.value : kids(n).map(textIn).join(""));
/** The first element of a piece of HTML, parsed as the service parses it. */
const firstEl = (html: string): El5 | null => elKids(parseFragment(html))[0] ?? null;
const walk = (n: Node5): El5[] => elKids(n).flatMap((e) => [e, ...walk(e)]);
const outer = (el: El5): string => {
  const holder = parseFragment("");
  holder.childNodes = [el];
  return serialize(holder);
};

/** The kit file holding a block's markup, when its snippet is only a pointer to it. */
export function blockFile(part: KitPart): string | null {
  return /\bdata-block="(blocks\/[\w.-]+\.html)"/.exec(part.snippet)?.[1] ?? null;
}

/** The custom properties set inline on the page's root: its overrides of the theme. */
export function rootTokens(html: string): Record<string, string> {
  const root = elKids(parse(html)).find((e) => e.tagName === "html");
  const style = root ? attr(root, "style") : null;
  const out: Record<string, string> = {};
  for (const decl of (style ?? "").split(";")) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** A snippet is a demo of the part, often several in a row. This is one instance of it: the part's first element. */
export function instanceOf(part: KitPart): string {
  const found = walk(parseFragment(part.snippet)).find((e) => attr(e, "data-ui") === part.ui);
  return found ? outer(found) : part.snippet;
}

/** The attributes of an element's start tag, from its HTML. */
export function startAttrs(html: string): Record<string, string> {
  const el = firstEl(html);
  return el ? Object.fromEntries(el.attrs.map((a) => [a.name, a.value])) : {};
}

/** Parts for a picker, in the kit's category order, filtered by a search. Whole-page blocks only show when searched for. */
export function groupParts(parts: KitPart[], query: string, exclude?: string): { category: string; parts: KitPart[] }[] {
  const q = query.trim().toLowerCase();
  const out: { category: string; parts: KitPart[] }[] = [];
  for (const p of parts) {
    // A saved composition is the user's own, so it's always offered; a kit's whole-page blocks wait to be searched for.
    if (p.ui === exclude || (p.kind === "composition" && p.category !== "Compositions" && !q)) continue;
    if (q && !p.name.toLowerCase().includes(q) && !p.ui.includes(q) && !p.category.toLowerCase().includes(q)) continue;
    const group = out.find((g) => g.category === p.category);
    if (group) group.parts.push(p);
    else out.push({ category: p.category, parts: [p] });
  }
  return out;
}

const SKIP_ATTRS = new Set(["data-ui", "data-agent-id", "data-part"]);

export type SwapPlan = { dropped: string[] } & ({ kind: "attrs"; changes: AttrChange[] } | { kind: "replace"; html: string });

/**
 * How to turn an element into another part. The same tag with nothing new inside it keeps its own source and only
 * changes attributes, so its children and id survive. Anything else is replaced with one instance of the new part,
 * carrying over the text and every prop the new part also takes.
 */
export function swapPlan(html: string, text: string, from: KitPart | null, to: KitPart): SwapPlan {
  const old = firstEl(html);
  const fresh = firstEl(instanceOf(to));
  const takes = new Set(to.props.map((p) => `data-${p.name}`));
  const declared = new Set((from?.props ?? []).map((p) => `data-${p.name}`));
  const oldAttrs = old ? old.attrs.filter((a) => a.name.startsWith("data-") && !SKIP_ATTRS.has(a.name)) : [];
  const dropped = oldAttrs.filter((a) => !takes.has(a.name) && declared.has(a.name)).map((a) => a.name.slice(5));
  if (!old || !fresh) return { kind: "replace", html: instanceOf(to), dropped };

  const sameShape = old.tagName === fresh.tagName && (elKids(old).length > 0 || elKids(fresh).length === 0);
  if (sameShape) {
    const changes: AttrChange[] = [{ name: "data-ui", value: to.ui }];
    for (const a of oldAttrs) if (!takes.has(a.name)) changes.push({ name: a.name, value: null });
    for (const a of fresh.attrs) if (a.name.startsWith("data-") && !SKIP_ATTRS.has(a.name) && attr(old, a.name) === null) changes.push({ name: a.name, value: a.value });
    return { kind: "attrs", changes, dropped };
  }
  for (const a of oldAttrs) {
    if (!takes.has(a.name)) continue;
    const own = fresh.attrs.find((x) => x.name === a.name);
    if (own) own.value = a.value;
    else fresh.attrs.push({ name: a.name, value: a.value });
  }
  const label = text.trim();
  if (label) {
    // The first leaf that already says something takes the label; a field with no text takes it as its placeholder.
    const leaf = [fresh, ...walk(fresh)].find((e) => elKids(e).length === 0 && textIn(e).trim() && !/^(option|script|style)$/.test(e.tagName));
    if (leaf) leaf.childNodes = parseFragment(escapeText(label)).childNodes;
    else {
      const holder = fresh.attrs.find((a) => a.name === "placeholder");
      if (holder) holder.value = label;
    }
  }
  return { kind: "replace", html: outer(fresh), dropped };
}

const escapeText = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the toast says after a swap. */
export function swapNotice(fromName: string, to: KitPart, dropped: string[]): string {
  const base = `Swapped ${fromName} for ${to.name}.`;
  if (!dropped.length) return `${base} Undo with ⌘Z.`;
  return `${base} Dropped ${dropped.join(", ")}, which ${to.name} doesn't take. Undo with ⌘Z.`;
}

export type WrapShape = "stack" | "grid" | "box" | "card" | "container" | "paper";

/** The wrappers this page can offer: Stack and Grid always, the rest when the kit has them. */
export function wrapShapes(parts: KitPart[]): WrapShape[] {
  const has = new Set(parts.map((p) => p.ui));
  return (["stack", "grid", "box", "card", "container", "paper"] as WrapShape[]).filter((s) => s === "stack" || s === "grid" || has.has(s));
}

/** The new wrapper's attributes. A kit's own part when it has one; on a flat style, plain inline layout. */
export function wrapAttrs(shape: WrapShape, count: number, parts: KitPart[]): Record<string, string> {
  const columns = (part: KitPart): string => {
    const options = part.props.find((p) => p.name === "columns")?.options ?? [];
    const exact = options.includes(String(count));
    return exact ? String(count) : (options.filter((o) => /^\d+$/.test(o) && Number(o) >= count)[0] ?? "auto");
  };
  const part = parts.find((p) => p.ui === shape);
  if (!part) {
    if (shape === "grid") return { style: `display:grid;grid-template-columns:repeat(${Math.max(1, count)},minmax(0,1fr));gap:16px` };
    return { style: "display:flex;flex-direction:row;align-items:center;gap:16px" };
  }
  if (shape === "stack") return { "data-ui": "stack", "data-direction": "row", "data-gap": "md", "data-align": "center" };
  if (shape === "grid") return { "data-ui": "grid", "data-columns": columns(part), "data-gap": "md" };
  return { "data-ui": shape };
}

const GAP_ORDER = ["none", "xs", "sm", "md", "lg", "xl"];

/** A kit's gap names from smallest to largest, whatever order its manifest lists them in. */
export function gapSteps(part: KitPart | null): string[] {
  const options = part?.props.find((p) => p.name === "gap")?.options ?? [];
  return [...options].sort((a, b) => (GAP_ORDER.indexOf(a) + 1 || 99) - (GAP_ORDER.indexOf(b) + 1 || 99));
}

export type Flow = "column" | "row" | "grid";

export function flowOf(attrs: Record<string, string>): Flow | null {
  if (attrs["data-ui"] === "grid") return "grid";
  if (attrs["data-ui"] === "stack") return attrs["data-direction"] === "row" ? "row" : "column";
  return null;
}

/** What each flow last had, so switching back restores it. Only the attributes that flow owns are in here. */
const FLOW_ATTRS: Record<Flow, string[]> = { column: ["data-align", "data-justify", "data-wrap"], row: ["data-align", "data-justify", "data-wrap"], grid: ["data-columns", "data-place"] };

/** The attribute changes for one Flow pick. Children, their order and the gap never change. */
export function flowChanges(attrs: Record<string, string>, to: Flow, remembered: Partial<Record<string, string>> = {}, columnsDefault = "2"): AttrChange[] {
  const changes: AttrChange[] = [];
  const set = (name: string, value: string | null) => {
    if ((attrs[name] ?? null) !== value) changes.push({ name, value });
  };
  set("data-ui", to === "grid" ? "grid" : "stack");
  set("data-direction", to === "row" ? "row" : null);
  const keep = new Set(FLOW_ATTRS[to]);
  for (const name of [...FLOW_ATTRS.column, ...FLOW_ATTRS.grid]) if (!keep.has(name)) set(name, null);
  for (const name of keep) set(name, attrs[name] ?? remembered[name] ?? (name === "data-columns" ? columnsDefault : null));
  return changes;
}

/** The 1-based line an element starts on in the page's source, found by its id or its start tag. Null when it isn't. */
export function lineOf(source: string, id: string | undefined, html: string): number | null {
  const startTag = html.slice(0, html.indexOf(">") + 1);
  const at = id ? source.indexOf(`data-agent-id="${id}"`) : startTag ? source.indexOf(startTag) : -1;
  return at < 0 ? null : source.slice(0, at).split("\n").length;
}

/** The start tag, for the Layout card's read-only code. */
export function startTagOf(html: string): string {
  const end = html.indexOf(">");
  return end < 0 ? html : html.slice(0, end + 1);
}

/** JSX for one instance, only when the kit links the part to a real import. CubiQ never invents code that doesn't exist. */
export function jsxOf(part: KitPart | null, attrs: Record<string, string>, text: string): string | null {
  if (!part?.importName) return null;
  const props = part.props.flatMap((p) => {
    const v = attrs[`data-${p.name}`];
    if (v === undefined) return [];
    return [v === "true" ? p.name : `${p.name}="${v.replace(/"/g, "&quot;")}"`];
  });
  const open = [part.importName, ...props].join(" ");
  return text.trim() ? `<${open}>${text.trim()}</${part.importName}>` : `<${open} />`;
}
