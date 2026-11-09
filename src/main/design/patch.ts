/** What patching the frame's page did: the elements it put in new (kit widgets in them need drawing), or why it couldn't. */
export type PatchResult = { ok: true; roots: Element[] } | { ok: false; reason: string };

/**
 * Brings the frame's live page from the file it loaded (`base`) to the file as it is now (`next`) without reloading it,
 * so an edit, undo or agent write doesn't flash. Only what differs between the two files is touched: an element both
 * files agree on keeps its live state (a kit widget's drawing, an open menu, a scroll position). Gives up, so the
 * caller reloads, when a script would have to run again or the live page doesn't line up with `base`.
 *
 * Serialized into the page as a bridge helper: everything it needs is defined inside it. `own` names the bridge's
 * own nodes (its script, overlays, styles), which the files don't have.
 */
export function patchDocument(live: Document, base: Document, next: Document, own: (node: Node) => boolean): PatchResult {
  const roots: Element[] = [];
  const fail = (reason: string): PatchResult => ({ ok: false, reason });
  const isEl = (n: Node): n is Element => n.nodeType === 1;
  const tagOf = (n: Node): string => (isEl(n) ? n.tagName : `#${n.nodeType}`);
  const idOf = (n: Node): string | null => (isEl(n) ? n.getAttribute("data-agent-id") || n.getAttribute("id") : null);
  const hasScript = (n: Node): boolean => isEl(n) && (n.tagName === "SCRIPT" || n.querySelector("script") !== null);
  const kids = (n: Node, mine: boolean): Node[] => {
    const list: Node[] = [];
    n.childNodes.forEach((c) => {
      if (!mine || !own(c)) list.push(c);
    });
    return list;
  };
  const sheet = (n: Node): boolean => isEl(n) && n.tagName === "LINK" && /\bstylesheet\b/i.test(n.getAttribute("rel") || "");

  /** A copy of the file's node, made in the live page. Scripts in it would not run, so a new script means reload. */
  const fresh = (n: Node): Node | null => {
    if (hasScript(n)) return null;
    const copy = live.importNode(n, true);
    if (isEl(copy)) roots.push(copy);
    return copy;
  };

  const syncAttrs = (el: Element, from: Element, to: Element): boolean => {
    // Only what the files disagree on: a live attribute a kit script set (open, data-active) stays.
    const names = new Set([...from.getAttributeNames(), ...to.getAttributeNames()]);
    for (const name of names) {
      const a = from.getAttribute(name);
      const b = to.getAttribute(name);
      if (a === b) continue;
      if (el.tagName === "SCRIPT") return false;
      if (b === null) el.removeAttribute(name);
      else el.setAttribute(name, b);
    }
    return true;
  };

  /** Puts the file's node in place of a live one; returns what now stands there, or null to reload. */
  const replace = (liveNode: Node, to: Node): Node | null => {
    const copy = fresh(to);
    if (!copy || !liveNode.parentNode) return null;
    if (sheet(liveNode) && sheet(copy)) {
      // Keep the old sheet until the new one has loaded.
      liveNode.parentNode.insertBefore(copy, liveNode.nextSibling);
      const drop = (): void => (liveNode as Element).remove();
      copy.addEventListener("load", drop, { once: true });
      copy.addEventListener("error", drop, { once: true });
      return copy;
    }
    liveNode.parentNode.replaceChild(copy, liveNode);
    return copy;
  };

  /** Brings one live node from `from` to `to`; returns the live node that now stands for it, or null to reload. */
  const patch = (liveNode: Node, from: Node, to: Node, mine: boolean): Node | null => {
    if (from.isEqualNode(to)) return liveNode;
    if (tagOf(from) !== tagOf(to) || tagOf(liveNode) !== tagOf(from)) return mine ? null : replace(liveNode, to);
    if (!isEl(to)) {
      liveNode.nodeValue = to.nodeValue;
      return liveNode;
    }
    const f = from as Element;
    if (f.tagName === "SCRIPT" || f.tagName === "TEMPLATE") return null;
    // A stylesheet's address changed: the new one loads before the old one goes, so nothing shows unstyled.
    if (sheet(f) && f.getAttribute("href") !== to.getAttribute("href")) return replace(liveNode, to);
    if (!syncAttrs(liveNode as Element, f, to)) return null;
    return patchKids(liveNode, f, to, mine) ? liveNode : null;
  };

  const patchKids = (liveParent: Node, from: Node, to: Node, mine: boolean): boolean => {
    const l = kids(liveParent, mine);
    const a = kids(from, false);
    const b = kids(to, false);
    if (a.length === b.length && a.every((n, i) => n.isEqualNode(b[i]!))) return true;
    // The live children don't line up with the file it loaded (a kit script drew into this element): put the file's
    // children in whole. Never for the page's own head and body, whose live extras are the bridge's.
    if (l.length !== a.length) {
      if (mine) return false;
      const copies: Node[] = [];
      for (const n of b) {
        const copy = fresh(n);
        if (!copy) return false;
        copies.push(copy);
      }
      for (const n of l) liveParent.removeChild(n);
      for (const n of copies) liveParent.appendChild(n);
      return true;
    }
    // Unchanged runs at both ends stay as they are.
    let start = 0;
    while (start < a.length && start < b.length && a[start]!.isEqualNode(b[start]!)) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1]!.isEqualNode(b[endB - 1]!)) {
      endA--;
      endB--;
    }
    // The middle: a node keeps its live copy when the next file has it at the same id, or at the same place with the
    // same tag when the counts agree (an edited element); everything else is new.
    const sameCount = endA - start === endB - start;
    const used = new Set<number>();
    const pairOf = (j: number): number => {
      const id = idOf(b[j]!);
      if (id) {
        for (let i = start; i < endA; i++) if (!used.has(i) && idOf(a[i]!) === id && tagOf(a[i]!) === tagOf(b[j]!)) return i;
      }
      const i = j;
      return sameCount && !used.has(i) && idOf(a[i]!) === id && tagOf(a[i]!) === tagOf(b[j]!) ? i : -1;
    };
    // Where the middle goes back: before the first unchanged node at the end (live nodes line up with `a` here).
    const anchor = endA < l.length ? l[endA]! : null;
    const placed: Node[] = [];
    for (let j = start; j < endB; j++) {
      const i = pairOf(j);
      if (i >= 0) {
        used.add(i);
        const kept = patch(l[i]!, a[i]!, b[j]!, false);
        if (!kept) return false;
        placed.push(kept);
      } else {
        const copy = fresh(b[j]!);
        if (!copy) return false;
        placed.push(copy);
      }
    }
    for (let i = start; i < endA; i++) if (!used.has(i) && l[i]!.parentNode === liveParent) liveParent.removeChild(l[i]!);
    // Back to front, moving only what's out of place: a moved element loses its scroll and restarts its animations.
    let ref: Node | null = anchor && anchor.parentNode === liveParent ? anchor : null;
    for (let k = placed.length - 1; k >= 0; k--) {
      const n = placed[k]!;
      if (n.parentNode !== liveParent || n.nextSibling !== ref) liveParent.insertBefore(n, ref);
      ref = n;
    }
    return true;
  };

  if (!base.documentElement || !next.documentElement || !base.head || !next.head || !base.body || !next.body) return fail("parse");
  if (!live.head || !live.body) return fail("live");
  // Inline scripts and external ones alike would not run again: a page whose scripts changed reloads.
  const scripts = (d: Document): string =>
    Array.from(d.querySelectorAll("script"))
      .map((s) => `${s.getAttribute("src") || ""}|${s.getAttribute("type") || ""}|${s.textContent || ""}`)
      .join("\n");
  if (scripts(base) !== scripts(next)) return fail("scripts");
  if (!syncAttrs(live.documentElement, base.documentElement, next.documentElement)) return fail("html");
  if (!patch(live.head, base.head, next.head, true)) return fail("head");
  if (!patch(live.body, base.body, next.body, true)) return fail("body");
  return { ok: true, roots };
}
