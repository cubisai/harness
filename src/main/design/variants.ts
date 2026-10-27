// In-place variant sets: the agent writes three versions of an element beside the original, and the canvas keeps one.
// Pure text work on the page's HTML (no parser dependency), like textedit.ts: every edit is around unique markers.
//
//   <style data-cubiq-variants="hero">@scope ([data-cubiq-variant="hero-1"]) { :scope > .card { … } }</style>
//   <div data-cubiq-variant="hero-0" hidden> …the original element… </div>
//   <div data-cubiq-variant="hero-1"> …one element… </div>
//   <div data-cubiq-variant="hero-2" hidden> … </div>
//   <div data-cubiq-variant="hero-3" hidden> … </div>

/** A set's name: short, lowercase, so it can sit in a class name (`cq-hero`). */
export const VARIANT_SET_RE = /^[a-z][a-z0-9]{0,15}$/;
/** The most variants one set may hold (always 3 today; a little room for a retry that writes one more). */
export const MAX_VARIANTS = 6;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);

type Tag = { name: string; start: number; end: number; closing: boolean; selfClosing: boolean };

/** The tags in `html` from `from` on, in order. Comments are skipped, and so is the raw text of script, style, textarea and title. */
function* tags(html: string, from = 0): Generator<Tag> {
  const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  re.lastIndex = from;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith("<!--")) continue;
    const tag: Tag = { name: m[2]!.toLowerCase(), start: m.index, end: m.index + m[0].length, closing: m[1] === "/", selfClosing: m[3] === "/" };
    yield tag;
    if (!tag.closing && RAW.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, "ig");
      close.lastIndex = tag.end;
      const c = close.exec(html);
      if (!c) return;
      yield { name: tag.name, start: c.index, end: c.index + c[0].length, closing: true, selfClosing: false };
      re.lastIndex = c.index + c[0].length;
    }
  }
}

/** Where the element opened at `open` closes (its closing tag's start and end), or null when it never does. */
function closeOf(html: string, open: Tag): { start: number; end: number } | null {
  let depth = 1;
  for (const t of tags(html, open.end)) {
    if (t.name !== open.name || t.selfClosing) continue;
    depth += t.closing ? -1 : 1;
    if (depth === 0) return { start: t.start, end: t.end };
  }
  return null;
}

/** How many top-level elements a stretch of HTML holds, or -1 when it also has loose text. */
function topLevelCount(html: string): number {
  let depth = 0;
  let count = 0;
  let last = 0;
  for (const t of tags(html)) {
    if (depth === 0 && html.slice(last, t.start).trim()) return -1;
    if (t.closing) depth = Math.max(0, depth - 1);
    else {
      if (depth === 0) count++;
      if (!t.selfClosing && !VOID.has(t.name)) depth++;
    }
    last = t.end;
  }
  if (html.slice(last).trim()) return -1;
  return count;
}

type Wrapper = { n: number; start: number; end: number; innerStart: number; innerEnd: number };

/** Every variant wrapper in the page, by set. */
function wrappers(html: string): Map<string, Wrapper[]> {
  const sets = new Map<string, Wrapper[]>();
  for (const t of tags(html)) {
    if (t.closing || t.name !== "div") continue;
    const m = /\bdata-cubiq-variant\s*=\s*["']([a-z][a-z0-9]{0,15})-(\d{1,2})["']/.exec(html.slice(t.start, t.end));
    if (!m) continue;
    const close = closeOf(html, t);
    if (!close) continue;
    const list = sets.get(m[1]!) ?? [];
    list.push({ n: Number(m[2]), start: t.start, end: close.end, innerStart: t.end, innerEnd: close.start });
    sets.set(m[1]!, list);
  }
  return sets;
}

/** What's wrong with a set (null when it can be resolved): wrappers missing, doubled, nested, or not holding one element each. */
function problem(html: string, list: Wrapper[]): string | null {
  const byN = new Map<number, Wrapper>();
  for (const w of list) {
    if (byN.has(w.n)) return `variant ${w.n} appears twice`;
    byN.set(w.n, w);
  }
  if (!byN.has(0)) return "the original (variant 0) is missing";
  const count = list.length - 1;
  if (count < 1) return "it has no variants";
  if (count > MAX_VARIANTS) return `it has ${count} variants (at most ${MAX_VARIANTS})`;
  for (let n = 1; n <= count; n++) if (!byN.has(n)) return `variant ${n} is missing`;
  const sorted = [...list].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) return "the wrappers are nested";
  for (const w of list) {
    const top = topLevelCount(html.slice(w.innerStart, w.innerEnd));
    // The original may be empty (Insert adds where there was nothing); a variant is exactly one element.
    if (top === -1 || top > 1 || (w.n > 0 && top === 0)) return `variant ${w.n} must hold exactly one element`;
  }
  return null;
}

/** The page's variant sets: each one's name, how many variants it has (the original not counted), and what's wrong with it if anything. */
export function listVariantSets(html: string): { set: string; count: number; malformed: string | null }[] {
  return [...wrappers(html)].map(([set, list]) => ({ set, count: Math.max(0, list.length - 1), malformed: problem(html, list) }));
}

/** The end of the brace block opened at `open` (the index just past its `}`), skipping strings and comments; -1 when unclosed. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") {
      const e = css.indexOf("*/", i + 2);
      if (e < 0) return -1;
      i = e + 1;
    } else if (c === '"' || c === "'") {
      const e = css.indexOf(c, i + 1);
      if (e < 0) return -1;
      i = e;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** One compound selector (no combinators), with any pseudo-class arguments. */
const COMPOUND = String.raw`(?:[^\s>+~,{}()]|\([^()]*\))+`;

/**
 * A variant's rules, moved from its wrapper (`:scope` = the wrapper, a `display: contents` shell) onto the kept element
 * itself (`:scope` = the element): `:scope > C` becomes `:scope:is(C)`, and `:scope C` also matches the element when it
 * is a C. Declarations and at-rule preludes are left alone.
 */
export function retargetRules(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) return out + css.slice(i);
    const end = blockEnd(css, open);
    if (end < 0) return out + css.slice(i);
    const prelude = css.slice(i, open);
    const body = css.slice(open + 1, end - 1);
    if (prelude.trim().startsWith("@")) {
      // @media and friends hold rules; @keyframes and @font-face hold no selectors to move.
      const nested = /^\s*@(media|supports|container|layer)\b/i.test(prelude);
      out += `${prelude}{${nested ? retargetRules(body) : body}}`;
    } else {
      const sel = prelude
        .replace(new RegExp(String.raw`:scope\s*>\s*(${COMPOUND})`, "g"), ":scope:is($1)")
        .replace(new RegExp(String.raw`:scope\s+(?![>+~])(${COMPOUND})`, "g"), ":is(:scope:is($1), :scope $1)");
      out += `${sel}{${body}}`;
    }
    i = end;
  }
  return out;
}

/** The set's `@scope` blocks in a style text, each with the variant it styles. */
function scopeBlocks(css: string, set: string): { n: number; start: number; end: number; open: number }[] {
  const re = new RegExp(String.raw`@scope\s*\(\s*\[\s*data-cubiq-variant\s*=\s*["']?${set}-(\d{1,2})["']?\s*\]\s*\)\s*\{`, "g");
  const found: { n: number; start: number; end: number; open: number }[] = [];
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const open = m.index + m[0].length - 1;
    const end = blockEnd(css, open);
    if (end < 0) break;
    found.push({ n: Number(m[1]), start: m.index, end, open });
    re.lastIndex = end;
  }
  return found;
}

/** The kept element's opening tag with `cls` added to its classes. */
function addClass(inner: string, cls: string): string {
  for (const t of tags(inner)) {
    if (t.closing) continue;
    const tag = inner.slice(t.start, t.end);
    const m = /\sclass\s*=\s*(["'])([^"']*)\1/i.exec(tag);
    const next = m ? tag.replace(m[0], ` class=${m[1]}${m[2] ? `${m[2]} ` : ""}${cls}${m[1]}`) : tag.replace(/\s*(\/?)>$/, ` class="${cls}"$1>`);
    return inner.slice(0, t.start) + next + inner.slice(t.end);
  }
  return inner;
}

/**
 * The text with a stretch removed, along with the blank rest of its line. When whole lines go and they sat between two
 * blank lines (an inserted set the agent spaced out), one blank line goes too, so × leaves the page as it was.
 */
function cut(html: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && (html[s - 1] === " " || html[s - 1] === "\t")) s--;
  let e = end;
  const tail = /^[ \t]*\r?\n/.exec(html.slice(e));
  if (tail && (s === 0 || html[s - 1] === "\n")) {
    e += tail[0].length;
    const blank = /^[ \t]*\r?\n/.exec(html.slice(e));
    if (blank && /\n[ \t]*\r?\n$/.test(html.slice(0, s))) e += blank[0].length;
  }
  return html.slice(0, s) + html.slice(e);
}

/**
 * Resolve a variant set: keep variant `keep` (null or 0 = the original) in place of the set and drop the rest. The kept
 * variant's `@scope` rules move onto it as `@scope (.cq-<set>)`, with a `cq-<set>` class on the element; the set's other
 * rules go. Throws with the reason when the set is missing or malformed (a discard of a set whose original is intact
 * still works).
 */
export function resolveVariantSet(html: string, set: string, keep: number | null): string {
  if (!VARIANT_SET_RE.test(set)) throw new Error("Not a variant set.");
  const list = wrappers(html).get(set);
  if (!list?.length) throw new Error("Those variants are no longer on the page.");
  const n = keep ?? 0;
  const bad = problem(html, list);
  const original = list.find((w) => w.n === 0);
  // Discarding needs only an intact original; keeping needs a well-formed set.
  if (bad && !(n === 0 && original && list.filter((w) => w.n === 0).length === 1 && topLevelCount(html.slice(original.innerStart, original.innerEnd)) >= 0)) {
    throw new Error(`The variants came back malformed: ${bad}.`);
  }
  if (!list.some((w) => w.n === n)) throw new Error(`There is no variant ${n}.`);

  // The style blocks first (they may sit before or after the wrappers), each rewritten in place.
  const cls = `cq-${set}`;
  let keptRules = false;
  const styleRe = new RegExp(String.raw`<style\b[^>]*\bdata-cubiq-variants\s*=\s*["']${set}["'][^>]*>([\s\S]*?)</style\s*>`, "gi");
  const styles: { start: number; end: number; text: string }[] = [];
  for (let m = styleRe.exec(html); m; m = styleRe.exec(html)) {
    const css = m[1] ?? "";
    let next = "";
    let at = 0;
    for (const b of scopeBlocks(css, set)) {
      next += css.slice(at, b.start);
      if (b.n === n && n > 0) {
        next += `@scope (.${cls}) {${retargetRules(css.slice(b.open + 1, b.end - 1))}}`;
        keptRules = true;
      } else next = next.replace(/\s*\/\*(?:(?!\*\/)[\s\S])*\*\/\s*$/, ""); // a dropped block's own comment goes with it
      at = b.end;
    }
    next += css.slice(at);
    // A rule on the wrappers themselves (the agent's copy of the canvas's display rule) is dead once they go, and the
    // dropped blocks leave blank runs behind.
    next = next.replace(/[^{}]*\[\s*data-cubiq-variant[^{}]*\{[^{}]*\}/g, "").replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, "\n\n");
    // The original keeps nothing from the set; a kept variant keeps its rules plus anything shared (keyframes, fonts).
    styles.push({ start: m.index, end: m.index + m[0].length, text: n > 0 && next.trim() ? `<style>${next.trim()}</style>` : "" });
  }

  // Then every wrapper and style block, from the last to the first so the earlier offsets hold.
  const edits = [
    ...list.map((w) => {
      if (w.n !== n) return { start: w.start, end: w.end, text: "" };
      const inner = html.slice(w.innerStart, w.innerEnd).trim();
      return { start: w.start, end: w.end, text: keptRules ? addClass(inner, cls) : inner };
    }),
    ...styles,
  ].sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) out = e.text ? out.slice(0, e.start) + e.text + out.slice(e.end) : cut(out, e.start, e.end);
  return out;
}
