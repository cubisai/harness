/// <reference lib="dom" />
/**
 * Text snapshots of the page in the browser pane: what an agent needs to act
 * on a page, at a fraction of a screenshot's tokens. Every interactive
 * element gets a ref (e1, e2, …) that browser_click and browser_type take.
 *
 * `collectPage` runs inside the page (serialized with toString), so it must
 * not reference anything outside itself.
 */

export interface SnapshotNode {
  kind: "heading" | "link" | "button" | "input" | "select" | "checkbox" | "text" | "image";
  ref?: string;
  name: string;
  level?: number;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  truncated: boolean;
}

export function collectPage(maxNodes: number): PageSnapshot {
  const REF = "data-unskilled-ref";
  for (const el of Array.from(document.querySelectorAll(`[${REF}]`))) el.removeAttribute(REF);

  const clip = (s: string, n = 100) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || el.closest("[aria-hidden='true']")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelFor = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.trim()) return text;
    }
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent;
    }
    const wrap = el.closest("label");
    if (wrap?.textContent?.trim()) return wrap.textContent;
    return (
      (el as HTMLElement).innerText ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      el.getAttribute("name") ||
      ""
    );
  };

  const nodes: SnapshotNode[] = [];
  let n = 0;
  let truncated = false;
  const ref = (el: Element) => {
    const r = `e${++n}`;
    el.setAttribute(REF, r);
    return r;
  };

  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
  const seenText = new Set<Element>();
  for (let el = walker.currentNode as Element | null; el; el = walker.nextNode() as Element | null) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;
    const role = el.getAttribute("role");
    const disabled = (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || undefined;

    if (/^h[1-6]$/.test(tag) || role === "heading") {
      if (!visible(el)) continue;
      nodes.push({ kind: "heading", level: Number(tag[1]) || 2, name: clip(el.textContent ?? "") });
      seenText.add(el);
    } else if ((tag === "a" && el.hasAttribute("href")) || role === "link") {
      if (!visible(el)) continue;
      nodes.push({ kind: "link", ref: ref(el), name: clip(labelFor(el)), href: el.getAttribute("href") ?? undefined });
      seenText.add(el);
    } else if (tag === "button" || role === "button" || role === "tab" || role === "menuitem" || tag === "summary" ||
      (tag === "input" && ["button", "submit", "reset"].includes((el as HTMLInputElement).type))) {
      if (!visible(el)) continue;
      nodes.push({ kind: "button", ref: ref(el), name: clip(labelFor(el) || (el as HTMLInputElement).value || ""), disabled });
      seenText.add(el);
    } else if ((tag === "input" && ["checkbox", "radio"].includes((el as HTMLInputElement).type)) || role === "checkbox" || role === "switch") {
      if (!visible(el)) continue;
      const checked = (el as HTMLInputElement).checked ?? el.getAttribute("aria-checked") === "true";
      nodes.push({ kind: "checkbox", ref: ref(el), name: clip(labelFor(el)), checked, disabled });
    } else if (tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable && !el.parentElement?.isContentEditable) {
      if (!visible(el) || (el as HTMLInputElement).type === "hidden") continue;
      const input = el as HTMLInputElement;
      const value = input.type === "password" ? (input.value ? "••••" : "") : clip(input.value ?? el.textContent ?? "", 60);
      nodes.push({ kind: "input", ref: ref(el), name: clip(labelFor(el), 60), value, disabled });
      seenText.add(el);
    } else if (tag === "select") {
      if (!visible(el)) continue;
      const sel = el as HTMLSelectElement;
      nodes.push({ kind: "select", ref: ref(el), name: clip(labelFor(el), 60), value: clip(sel.selectedOptions[0]?.textContent ?? "", 60), disabled });
      seenText.add(el);
    } else if (tag === "img" && el.getAttribute("alt")) {
      if (!visible(el)) continue;
      nodes.push({ kind: "image", name: clip(el.getAttribute("alt") ?? "") });
    } else if (["p", "li", "td", "th", "dt", "dd", "label", "figcaption", "blockquote", "pre", "caption"].includes(tag) || role === "alert" || role === "status") {
      if (!visible(el) || [...seenText].some((s) => s.contains(el))) continue;
      // Text of this block that isn't inside an interactive child.
      const text = clip((el as HTMLElement).innerText ?? "", 160);
      if (text) nodes.push({ kind: "text", name: text });
      seenText.add(el);
    }
  }
  return { url: location.href, title: document.title, nodes, truncated };
}

/** The snapshot as compact text lines, one node per line. */
export function formatSnapshot(s: PageSnapshot): string {
  const lines = [`Page: ${s.title || "(untitled)"}`, `URL: ${s.url}`, ""];
  for (const node of s.nodes) {
    const ref = node.ref ? `[${node.ref}] ` : "";
    const flags = [node.disabled ? "disabled" : "", node.checked === true ? "checked" : node.checked === false && node.kind === "checkbox" ? "unchecked" : ""]
      .filter(Boolean)
      .join(", ");
    const extra = flags ? ` (${flags})` : "";
    switch (node.kind) {
      case "heading":
        lines.push(`${"#".repeat(node.level ?? 2)} ${node.name}`);
        break;
      case "text":
        lines.push(node.name);
        break;
      case "image":
        lines.push(`image "${node.name}"`);
        break;
      case "link":
        lines.push(`${ref}link "${node.name}"${node.href ? ` -> ${node.href}` : ""}`);
        break;
      case "input":
      case "select":
        lines.push(`${ref}${node.kind} "${node.name}"${node.value ? ` = "${node.value}"` : ""}${extra}`);
        break;
      default:
        lines.push(`${ref}${node.kind} "${node.name}"${extra}`);
    }
  }
  if (s.truncated) lines.push("", "(snapshot truncated; scroll or narrow the page to see more)");
  if (s.nodes.length === 0) lines.push("(no visible content)");
  return lines.join("\n");
}
