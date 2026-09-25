/// <reference lib="dom" />
/**
 * Element picking in the browser pane: hover highlights, a click reports the
 * element through the CDP binding, Esc cancels. Runs inside the page
 * (serialized with toString), so it must not reference anything outside.
 */
export const PICK_BINDING = "__unskilledPick";

export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
}

export function startPicker(binding: string): void {
  const w = window as unknown as Record<string, unknown>;
  (w.__unskilledPickStop as (() => void) | undefined)?.();

  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #0a84ff;background:rgba(10,132,255,.12);border-radius:3px;transition:all 60ms ease-out;display:none";
  const tip = document.createElement("div");
  tip.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;font:11px/1.4 ui-monospace,Menlo,monospace;background:#1d1d1f;color:#fff;padding:2px 6px;border-radius:4px;display:none;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  document.documentElement.append(box, tip);

  const selectorFor = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && parts.length < 5) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const testId = cur.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`${tag}[data-testid="${testId}"]`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(" > ");
  };

  let current: Element | null = null;
  const onMove = (e: MouseEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === tip) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    tip.textContent = selectorFor(el);
    Object.assign(tip.style, { display: "block", left: `${Math.max(4, r.left)}px`, top: `${r.top > 24 ? r.top - 22 : r.bottom + 4}px` });
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const onClick = (e: MouseEvent) => {
    swallow(e);
    const el = current;
    stop();
    if (!el) return;
    const r = el.getBoundingClientRect();
    const payload: PickedElement = {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      html: el.outerHTML.slice(0, 1200),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    };
    (w[binding] as (s: string) => void)(JSON.stringify(payload));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      swallow(e);
      stop();
      (w[binding] as (s: string) => void)("null");
    }
  };
  const stop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    tip.remove();
    delete w.__unskilledPickStop;
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", onKey, true);
  w.__unskilledPickStop = stop;
}

/** What goes into the message box for a picked element. */
export function describePick(p: PickedElement, url: string, screenshotPath?: string): string {
  const lines = [`Element \`${p.selector}\` on ${url}`];
  if (p.text) lines.push(`Text: "${p.text}"`);
  lines.push("```html", p.html + (p.html.length >= 1200 ? "…" : ""), "```");
  if (screenshotPath) lines.push(`Screenshot: ${screenshotPath}`);
  return lines.join("\n");
}
