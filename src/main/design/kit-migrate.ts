import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { KitManifest } from "./kit-schema";

/**
 * Move a page from one kit to another by table: rename each `data-ui` to the part the target kit calls it, and drop the
 * props the target doesn't have. Only those attributes are spliced, so every other byte of the page stays as written.
 * Deterministic on purpose: the AI's adaptation is a separate step the user opts into.
 */

type Node5 = DefaultTreeAdapterMap["node"];
type El5 = DefaultTreeAdapterMap["element"];
const isEl = (n: Node5): n is El5 => "attrs" in n;
const kids = (n: Node5): Node5[] => ("childNodes" in n ? n.childNodes : []);
const attr = (el: El5, name: string): string | null => el.attrs.find((a) => a.name === name)?.value ?? null;

function walk(n: Node5, out: El5[] = []): El5[] {
  for (const child of kids(n)) {
    if (isEl(child)) {
      out.push(child);
      walk(child, out);
    }
    const content = (child as { content?: Node5 }).content;
    if (content) walk(content, out);
  }
  return out;
}

/** `migrations.json`: what the target kit calls another kit's parts. */
export function parseMigrations(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as { aliases?: unknown };
    if (typeof raw.aliases !== "object" || raw.aliases === null) return {};
    return Object.fromEntries(Object.entries(raw.aliases).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export interface MigrationCount {
  ui: string;
  name: string;
  count: number;
}

export interface MigrationPlan {
  html: string;
  /** Parts that exist in the target under the same name. */
  same: number;
  /** Parts given the target's name for them. */
  renamed: { from: string; to: string; count: number }[];
  /** Parts the target has no match for: left as they are and flagged, so nothing on the page is lost. */
  unsupported: MigrationCount[];
  /** Props the target doesn't take, removed so the part falls back to its default. */
  droppedProps: { ui: string; prop: string; value: string; count: number }[];
  /** Parts whose inner pieces the target kit names differently: these need a look. */
  review: MigrationCount[];
  changed: boolean;
}

/** The `data-part` names directly in a part, not counting those of parts nested inside it. */
function ownPieces(el: El5, into = new Set<string>()): Set<string> {
  for (const child of kids(el)) {
    if (!isEl(child)) continue;
    const part = attr(child, "data-part");
    if (part) into.add(part);
    if (!attr(child, "data-ui")) ownPieces(child, into);
  }
  return into;
}

/** What a part is made of in a kit, read from its snippet. */
function snippetPieces(snippet: string, ui: string): Set<string> {
  const found = walk(parseFragment(snippet)).find((e) => attr(e, "data-ui") === ui);
  return found ? ownPieces(found) : new Set();
}

type Splice = { start: number; end: number; text: string };

function bump<T>(list: T[], match: (item: T) => boolean, make: () => T, grow: (item: T) => void): void {
  const hit = list.find(match);
  if (hit) grow(hit);
  else list.push(make());
}

/** Work out the move; `plan.html` is the page after it. Nothing is written here. */
export function migratePage(html: string, from: KitManifest | null, to: KitManifest, aliases: Record<string, string>): MigrationPlan {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const targets = new Map(to.components.map((c) => [c.ui, c]));
  const sources = new Map((from?.components ?? []).map((c) => [c.ui, c]));
  const plan: MigrationPlan = { html, same: 0, renamed: [], unsupported: [], droppedProps: [], review: [], changed: false };
  const splices: Splice[] = [];

  for (const el of walk(doc)) {
    const ui = attr(el, "data-ui");
    if (!ui) continue;
    const toUi = targets.has(ui) ? ui : aliases[ui] && targets.has(aliases[ui]!) ? aliases[ui]! : null;
    const source = sources.get(ui);
    if (!toUi) {
      bump(plan.unsupported, (u) => u.ui === ui, () => ({ ui, name: source?.name ?? ui, count: 1 }), (u) => (u.count += 1));
      continue;
    }
    const target = targets.get(toUi)!;
    const loc = el.sourceCodeLocation?.attrs;
    if (toUi === ui) plan.same += 1;
    else {
      bump(plan.renamed, (r) => r.from === ui, () => ({ from: ui, to: toUi, count: 1 }), (r) => (r.count += 1));
      const at = loc?.["data-ui"];
      if (at) splices.push({ start: at.startOffset, end: at.endOffset, text: `data-ui="${toUi}"` });
    }

    // Only what the source kit calls a prop is the kit's to change; a page's own data-* stays.
    for (const prop of source?.props ?? []) {
      const value = attr(el, `data-${prop.name}`);
      if (value === null) continue;
      const wanted = target.props.find((p) => p.name === prop.name);
      const fits = wanted && (wanted.type !== "choice" || wanted.options?.includes(value));
      if (fits) continue;
      const at = loc?.[`data-${prop.name}`];
      if (at) {
        // The attribute and the space before it, so the tag doesn't gain a gap.
        const start = /\s/.test(html[at.startOffset - 1] ?? "") ? at.startOffset - 1 : at.startOffset;
        splices.push({ start, end: at.endOffset, text: "" });
      }
      bump(plan.droppedProps, (d) => d.ui === ui && d.prop === prop.name && d.value === value, () => ({ ui, prop: prop.name, value, count: 1 }), (d) => (d.count += 1));
    }

    const have = ownPieces(el);
    if (have.size) {
      const want = snippetPieces(target.snippet, toUi);
      if ([...have].some((p) => !want.has(p))) {
        bump(plan.review, (r) => r.ui === toUi, () => ({ ui: toUi, name: target.name, count: 1 }), (r) => (r.count += 1));
      }
    }
  }

  let next = html;
  for (const s of splices.sort((a, b) => b.start - a.start)) next = `${next.slice(0, s.start)}${s.text}${next.slice(s.end)}`;
  plan.html = next;
  plan.changed = next !== html;
  return plan;
}
