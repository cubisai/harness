import type { OutlineNode } from "./frame";

/** What a layer is, for its icon and its fallback name. */
export type LayerKind = "heading" | "text" | "image" | "vector" | "button" | "link" | "input" | "list" | "nav" | "section" | "form" | "table" | "media" | "group";

const KIND_BY_TAG: Record<string, LayerKind> = {
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  p: "text", span: "text", small: "text", strong: "text", em: "text", b: "text", i: "text", label: "text", blockquote: "text", code: "text", pre: "text", time: "text", figcaption: "text", dt: "text", dd: "text",
  img: "image", picture: "image", canvas: "image", figure: "image",
  svg: "vector",
  button: "button", summary: "button",
  a: "link",
  input: "input", select: "input", textarea: "input",
  ul: "list", ol: "list", dl: "list", li: "list",
  nav: "nav",
  header: "section", footer: "section", main: "section", section: "section", article: "section", aside: "section", dialog: "section",
  form: "form", fieldset: "form",
  table: "table", thead: "table", tbody: "table", tr: "table", td: "table", th: "table",
  video: "media", audio: "media", iframe: "media",
};

/** The layer kind of an outline node, from its tag. */
export function layerKind(node: Pick<OutlineNode, "tag">): LayerKind {
  return KIND_BY_TAG[node.tag] ?? "group";
}

/** A tag's plain name, for a layer with no text, id or class ("Heading 1", "Header", "Group"). */
const TAG_NAMES: Record<string, string> = {
  header: "Header", footer: "Footer", main: "Main", section: "Section", article: "Article", aside: "Sidebar", nav: "Navigation", dialog: "Dialog",
  p: "Paragraph", span: "Text", a: "Link", button: "Button", img: "Image", picture: "Image", svg: "Vector", figure: "Figure", canvas: "Canvas",
  ul: "List", ol: "List", li: "Item", form: "Form", input: "Input", select: "Select", textarea: "Text area", label: "Label", table: "Table",
  tr: "Row", td: "Cell", th: "Header cell", video: "Video", audio: "Audio", iframe: "Embed", div: "Group",
};

/** "hero-section", "hero_section" or "heroSection" → "Hero section". */
export function humanize(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return "";
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A layer's readable name: its own text (or accessible name), else its agent id, else its first class, else its
 * tag's plain name. `div.hero-wrap` reads "Hero wrap", an `<h1>` with text reads that text.
 */
export function layerName(node: OutlineNode): string {
  if (node.label) return node.label;
  if (node.id) return humanize(node.id);
  const cls = node.cls.split(".")[0];
  if (cls) return humanize(cls) || cls;
  if (/^h[1-6]$/.test(node.tag)) return `Heading ${node.tag.slice(1)}`;
  return TAG_NAMES[node.tag] ?? node.tag;
}

/** One visible row of the Layers tree. */
export interface LayerRow {
  node: OutlineNode;
  /** The node's index in the outline. */
  index: number;
  /** The next node is deeper: the row can collapse. */
  hasChildren: boolean;
}

/** A stable key for a node across outline refreshes of the same page. */
export const layerKey = (node: OutlineNode): string => node.id ?? node.selector;

/** True when `node` matches a search, by name, tag, class, id or text (case-insensitive). */
function matches(node: OutlineNode, q: string): boolean {
  return [layerName(node), node.tag, node.cls, node.id ?? "", node.label].some((s) => s.toLowerCase().includes(q));
}

/**
 * The rows to show. With a query: every match plus its ancestors (collapse is ignored, so a match is never hidden).
 * Without: every row except the descendants of a collapsed one.
 */
export function layerRows(nodes: OutlineNode[], collapsed: ReadonlySet<string>, query = ""): LayerRow[] {
  const hasChildren = (i: number): boolean => (nodes[i + 1]?.depth ?? -1) > nodes[i]!.depth;
  const q = query.trim().toLowerCase();
  if (q) {
    const keep = new Set<number>();
    // The open ancestors of the node being looked at, by depth.
    const path: number[] = [];
    nodes.forEach((node, i) => {
      path.length = node.depth;
      if (matches(node, q)) {
        for (const a of path) keep.add(a);
        keep.add(i);
      }
      path[node.depth] = i;
    });
    return nodes.flatMap((node, i) => (keep.has(i) ? [{ node, index: i, hasChildren: hasChildren(i) }] : []));
  }
  const rows: LayerRow[] = [];
  // Depth of the collapsed row whose subtree is being skipped, or null.
  let skipBelow: number | null = null;
  nodes.forEach((node, i) => {
    if (skipBelow !== null) {
      if (node.depth > skipBelow) return;
      skipBelow = null;
    }
    const kids = hasChildren(i);
    rows.push({ node, index: i, hasChildren: kids });
    if (kids && collapsed.has(layerKey(node))) skipBelow = node.depth;
  });
  return rows;
}

/** The keys of every ancestor of the node at `index`, so a selection inside a collapsed subtree can be revealed. */
export function ancestorKeys(nodes: OutlineNode[], index: number): string[] {
  const keys: string[] = [];
  let depth = nodes[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    const n = nodes[i]!;
    if (n.depth < depth) {
      keys.push(layerKey(n));
      depth = n.depth;
    }
  }
  return keys;
}
