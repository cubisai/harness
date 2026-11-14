import type { LintFinding } from "./lint";

/**
 * Craft checks: the small, checkable habits of a senior UI designer that the other slop groups don't cover. Buttons
 * that say what they do, one strong action per group, confirms that name what's lost, icon buttons with a name, calm
 * copy, chunked numbers, light from above, motion that doesn't drag. Each fires on clear cases only.
 */

/** One control as the page draws it. */
export interface CraftControl {
  selector: string;
  /** Its visible text, trimmed (empty for an icon-only control). */
  label: string;
  /** The nearest grouping ancestor (form, dialog, card-like box, section, bar, row) it shares with its siblings. */
  group: string;
  /** Filled with a colour that stands out from what's behind it (a primary or danger fill, not a quiet grey). */
  strong: boolean;
  /** Draws an icon (svg, img or an icon font) and has no text. */
  iconOnly: boolean;
  /** Has an aria-label, aria-labelledby or title. */
  named: boolean;
}

export interface CraftSnapshot {
  controls: CraftControl[];
  /** Short UI strings: headings, buttons, labels, nav links, table heads. */
  texts: { selector: string; kind: "heading" | "button" | "label" | "nav"; text: string; level: number }[];
  dialogs: { selector: string; text: string; actions: string[] }[];
  /** Text with a run of 9 or more digits. */
  digits: { selector: string; text: string }[];
  /** Text drawn in pure black on a light surface. */
  black: { selector: string; count: number };
  /** Box shadows cast upward (a negative y offset), outside fixed and sticky bars. */
  upward: { selector: string; value: string }[];
  /** Transitions or keyframes on layout properties. */
  layoutMotion: { selector: string; what: string }[];
  /** Controls whose state transition lasts longer than half a second. */
  slow: { selector: string; ms: number }[];
  /** A stat's change with no comparison (kit `stat` parts' `delta`). */
  deltas: { selector: string; text: string }[];
}

/** Snapshot controls, short copy, dialogs, numbers, shadows and motion; runs inside the page. */
export function collectCraftSlop(selectorFor: (el: Element) => string): CraftSnapshot {
  const out: CraftSnapshot = { controls: [], texts: [], dialogs: [], digits: [], black: { selector: "", count: 0 }, upward: [], layoutMotion: [], slow: [], deltas: [] };
  const body = document.body;
  if (!body) return out;
  const rgb = (value: string): number[] | null => {
    const m = /rgba?\(([^)]*)\)/.exec(value || "");
    if (!m) return null;
    const parts = m[1]!.includes(",") ? m[1]!.split(",") : m[1]!.split(/[\s/]+/);
    const n = parts.map((p) => Number.parseFloat(p));
    if (n.length < 3 || n.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
    return [n[0]!, n[1]!, n[2]!, n.length > 3 && Number.isFinite(n[3]!) ? n[3]! : 1];
  };
  const lum = (c: number[]): number => {
    const ch = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(c[0]!) + 0.7152 * ch(c[1]!) + 0.0722 * ch(c[2]!);
  };
  const ratio = (a: number[], b: number[]): number => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /** The colour painted behind an element: its nearest ancestor with an opaque-enough background, else white. */
  const behind = (el: Element | null): number[] => {
    for (let a: Element | null = el; a; a = a.parentElement) {
      const c = rgb(getComputedStyle(a).backgroundColor);
      if (c && c[3]! >= 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const check = (el as unknown as { checkVisibility?: (o: object) => boolean }).checkVisibility;
    return !check || check.call(el, { opacityProperty: true, visibilityProperty: true });
  };
  const ownText = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

  // Controls: buttons and button-like links, outside toggles, tabs and menus (a selected tab is filled on purpose).
  const controls = body.querySelectorAll('button, [role=button], a[data-ui="button"], a[class*="button" i], a[class*="btn" i], input[type=submit], input[type=button]');
  const groupOf = (el: Element): string => {
    for (let a: Element | null = el.parentElement; a && a !== body; a = a.parentElement) {
      const tag = a.tagName.toLowerCase();
      if (/^(form|dialog|section|header|nav|footer|article|aside|li|tr|td|fieldset|main)$/.test(tag) || a.getAttribute("role") === "dialog" || a.getAttribute("role") === "toolbar") return selectorFor(a);
      const cs = getComputedStyle(a);
      const bg = rgb(cs.backgroundColor);
      const bordered = Number.parseFloat(cs.borderTopWidth) >= 1 && Number.parseFloat(cs.borderBottomWidth) >= 1;
      if ((bg && bg[3]! >= 0.5) || bordered || a.hasAttribute("data-ui")) {
        if (a.getAttribute("data-ui") !== "stack" && a.getAttribute("data-ui") !== "grid") return selectorFor(a);
      }
    }
    return "body";
  };
  for (let i = 0; i < Math.min(controls.length, 400); i += 1) {
    const el = controls[i]!;
    if (!visible(el)) continue;
    const role = el.getAttribute("role") ?? "";
    if (el.hasAttribute("aria-pressed") || el.hasAttribute("aria-selected") || el.hasAttribute("aria-current") || /^(tab|radio|switch|option|menuitem\w*|checkbox)$/.test(role)) continue;
    if (el.closest('[role=tablist], [role=menu], [role=listbox], [role=radiogroup], [data-ui="pagination"], [data-ui="tabs"]')) continue;
    const cs = getComputedStyle(el);
    const bg = rgb(cs.backgroundColor);
    const strong = !!bg && bg[3]! >= 0.9 && ratio(bg, behind(el.parentElement)) >= 3;
    const label = el.tagName === "INPUT" ? ((el as HTMLInputElement).value || "").trim() : ownText(el);
    const iconOnly = !label && !!el.querySelector("svg, img, i, [class*=icon]");
    const named = !!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title"));
    out.controls.push({ selector: selectorFor(el), label: label.slice(0, 60), group: groupOf(el), strong, iconOnly, named });
  }

  // Short UI strings.
  const pick = (selector: string, kind: CraftSnapshot["texts"][number]["kind"]): void => {
    const list = body.querySelectorAll(selector);
    for (let i = 0; i < Math.min(list.length, 300) && out.texts.length < 600; i += 1) {
      const el = list[i]!;
      if (!visible(el) || el.closest("blockquote, q, figure, code, pre")) continue;
      const text = ownText(el);
      if (!text || text.length > 120) continue;
      const m = /^h([1-6])$/i.exec(el.tagName);
      out.texts.push({ selector: selectorFor(el), kind, text, level: m ? Number(m[1]) : 0 });
    }
  };
  pick("h1, h2, h3, h4, [role=heading]", "heading");
  pick('button, [role=button], a[data-ui="button"]', "button");
  pick("label, legend, th", "label");
  pick("nav a", "nav");

  // Dialogs and what their actions say.
  const dialogs = body.querySelectorAll('dialog, [role=dialog], [role=alertdialog], [data-ui="dialog"]');
  for (let i = 0; i < Math.min(dialogs.length, 20); i += 1) {
    const el = dialogs[i]!;
    const actions: string[] = [];
    el.querySelectorAll('button, [role=button], a[data-ui="button"]').forEach((b) => {
      const t = ownText(b);
      if (t && actions.length < 6) actions.push(t.slice(0, 40));
    });
    out.dialogs.push({ selector: selectorFor(el), text: ownText(el).slice(0, 400), actions });
  }

  // Text: long digit runs, and pure black on a light surface.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(), count = 0; n && count < 4000; n = walker.nextNode(), count += 1) {
    const value = (n.nodeValue ?? "").trim();
    const parent = n.parentElement;
    if (!value || !parent || seen.has(parent) || parent.closest("script, style, noscript, template, code, pre, kbd, samp, svg")) continue;
    seen.add(parent);
    if (/\d{9,}/.test(value) && out.digits.length < 6) out.digits.push({ selector: selectorFor(parent), text: value.slice(0, 60) });
    // A closed select's options aren't on screen, and the browser draws them in its own black.
    if (parent.closest("select, option, optgroup, datalist") || !visible(parent)) continue;
    const c = rgb(getComputedStyle(parent).color);
    if (c && c[3]! >= 0.99 && c[0] === 0 && c[1] === 0 && c[2] === 0 && lum(behind(parent)) > 0.5) {
      if (!out.black.count) out.black.selector = selectorFor(parent);
      out.black.count += 1;
    }
  }

  // Shadows, motion and stat changes, element by element.
  const layoutProp = /^(width|height|min-width|max-width|min-height|max-height|top|left|right|bottom|inset|margin|margin-\w+|padding|padding-\w+)$/;
  const all = body.querySelectorAll("*");
  const secs = (v: string): number => (v.trim().endsWith("ms") ? Number.parseFloat(v) / 1000 : Number.parseFloat(v) || 0);
  for (let i = 0; i < Math.min(all.length, 3000); i += 1) {
    const el = all[i]!;
    if (el.matches('[data-ui="stat"] [data-part="delta"]') && out.deltas.length < 12) out.deltas.push({ selector: selectorFor(el), text: ownText(el).slice(0, 60) });
    // A kit part's own shadows and motion are the kit's (system/ is CubiQ's, not the page's to change).
    if (el.closest("[data-ui]")) continue;
    const cs = getComputedStyle(el);
    if (cs.boxShadow && cs.boxShadow !== "none" && cs.position !== "fixed" && cs.position !== "sticky" && out.upward.length < 6) {
      // Each layer: "<color> x y blur spread [inset]"; colours may hold commas, so split on commas outside parentheses.
      const layers: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of cs.boxShadow) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        if (ch === "," && depth === 0) {
          layers.push(cur);
          cur = "";
        } else cur += ch;
      }
      layers.push(cur);
      for (const layer of layers) {
        if (/\binset\b/.test(layer)) continue;
        const lengths = layer.replace(/rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]+/gi, "").match(/-?[\d.]+px/g) ?? [];
        const y = Number.parseFloat(lengths[1] ?? "0");
        const blur = Number.parseFloat(lengths[2] ?? "0");
        if (y <= -2 && blur > 0) {
          out.upward.push({ selector: selectorFor(el), value: layer.trim().slice(0, 60) });
          break;
        }
      }
    }
    const props = cs.transitionProperty.split(",").map((p) => p.trim());
    const durs = cs.transitionDuration.split(",").map(secs);
    for (let j = 0; j < props.length; j += 1) {
      const d = durs[j % Math.max(durs.length, 1)] ?? 0;
      if (d > 0 && layoutProp.test(props[j]!) && out.layoutMotion.length < 6) {
        out.layoutMotion.push({ selector: selectorFor(el), what: `transition ${props[j]}` });
        break;
      }
    }
    if (el.matches('a, button, [role=button], input, select, textarea, summary, [data-ui="button"]')) {
      const longest = Math.max(0, ...props.map((p, j) => (p === "none" ? 0 : (durs[j % Math.max(durs.length, 1)] ?? 0))));
      if (longest > 0.5 && out.slow.length < 6) out.slow.push({ selector: selectorFor(el), ms: Math.round(longest * 1000) });
    }
  }

  // Keyframes that move layout, when something runs them.
  const running: Record<string, string> = {};
  for (let i = 0; i < Math.min(all.length, 3000); i += 1) {
    const name = getComputedStyle(all[i]!).animationName;
    if (name && name !== "none" && !all[i]!.closest("[data-ui]")) for (const one of name.split(",")) running[one.trim()] = running[one.trim()] ?? selectorFor(all[i]!);
  }
  const visit = (list: CSSRuleList): void => {
    for (let i = 0; i < list.length; i += 1) {
      const rule = list[i] as unknown as { name?: string; cssRules?: CSSRuleList; type?: number; style?: CSSStyleDeclaration };
      if (rule.type === 7 && rule.name && running[rule.name] && rule.cssRules) {
        let moves = "";
        for (let k = 0; k < rule.cssRules.length && !moves; k += 1) {
          const frame = rule.cssRules[k] as unknown as { style?: CSSStyleDeclaration };
          for (let m = 0; frame.style && m < frame.style.length; m += 1) if (layoutProp.test(frame.style[m] ?? "")) moves = frame.style[m]!;
        }
        if (moves && out.layoutMotion.length < 6) out.layoutMotion.push({ selector: running[rule.name]!, what: `@keyframes ${rule.name} animates ${moves}` });
      } else {
        let nested: CSSRuleList | null = null;
        try {
          nested = rule.cssRules ?? null;
        } catch {
          nested = null;
        }
        if (nested && nested.length) visit(nested);
      }
    }
  };
  for (let i = 0; i < document.styleSheets.length; i += 1) {
    try {
      const rules = document.styleSheets[i]?.cssRules;
      if (rules) visit(rules);
    } catch {
      // A cross-origin sheet can't be read.
    }
  }
  return out;
}

/** Turn a craft snapshot into findings; pure and self-contained. */
export function craftSlopFindings(s: CraftSnapshot): LintFinding[] {
  const findings: LintFinding[] = [];
  const push = (id: string, selector: string, detail: string): void => {
    findings.push({ rule: "slop", id, selector, detail });
  };
  /** One finding for many hits: the first one's selector, a count, and up to three examples. */
  const fold = (id: string, hits: { selector: string; example: string }[], say: (examples: string, count: number) => string): void => {
    if (!hits.length) return;
    const examples = hits.slice(0, 3).map((h) => `"${h.example}"`).join(", ");
    push(id, hits[0]!.selector, say(examples, hits.length));
  };

  // A label that doesn't say what happens.
  const vague: Record<string, boolean> = { submit: true, ok: true, okay: true, yes: true, no: true, confirm: true, go: true, "click here": true, click: true, here: true };
  fold(
    "vague-action",
    s.controls.filter((c) => vague[c.label.toLowerCase().replace(/[.!]+$/, "")]).map((c) => ({ selector: c.selector, example: c.label })),
    (ex, n) => `${n} button${n === 1 ? "" : "s"} labelled ${ex}: say what happens, a verb and its object ("Create account", "Delete file")`,
  );

  // More than one strong fill in a group: nothing reads as the main action.
  const byGroup: Record<string, CraftControl[]> = {};
  for (const c of s.controls) if (c.strong) (byGroup[c.group] = byGroup[c.group] ?? []).push(c);
  for (const group of Object.keys(byGroup)) {
    const list = byGroup[group]!;
    if (list.length < 2) continue;
    push("primary-crowd", list[0]!.selector, `${list.length} filled buttons side by side (${list.slice(0, 3).map((c) => `"${c.label || "icon"}"`).join(", ")}): keep one filled for the main action, the next outlined, the rest as text`);
  }

  // Confirms that hide what will be lost.
  for (const d of s.dialogs) {
    const asks = /are you sure/i.test(d.text);
    const named = /["“‘'«].+["”’'»]/.test(d.text);
    const vagueAct = d.actions.find((a) => /^(ok|okay|yes|confirm)$/i.test(a.replace(/[.!]+$/, "")));
    const destructive = /\b(delete|remove|discard|erase|destroy|permanent(ly)?|can.?t be undone|cannot be undone)\b/i.test(d.text);
    if ((asks && !named) || (vagueAct && destructive)) {
      push("vague-confirm", d.selector, `a confirm that ${asks && !named ? 'asks "Are you sure?"' : `answers with "${vagueAct}"`}: name the thing and what happens ("Delete 'Q4 report'? This can't be undone.") and label the button with the act ("Delete file")`);
    }
  }

  // An icon button with no name.
  fold(
    "unlabelled-icon-button",
    s.controls.filter((c) => c.iconOnly && !c.named).map((c) => ({ selector: c.selector, example: c.selector.slice(0, 40) })),
    (_ex, n) => `${n} icon-only button${n === 1 ? " has" : "s have"} no name: give each an aria-label, and a visible word unless the icon is close, search or menu`,
  );

  // Shouting and greeting.
  fold(
    "shout-copy",
    s.texts.filter((t) => /!/.test(t.text) && !/!=/.test(t.text)).map((t) => ({ selector: t.selector, example: t.text.slice(0, 40) })),
    (ex, n) => `exclamation marks in interface text (${ex}${n > 3 ? ` and ${n - 3} more` : ""}): state it plainly`,
  );
  const greeting = s.texts.find((t) => t.kind === "heading" && t.level <= 2 && /^(welcome back|welcome,|hi|hello|hey|good (morning|afternoon|evening))\b/i.test(t.text));
  if (greeting) push("greeting-headline", greeting.selector, `a greeting as the headline ("${greeting.text.slice(0, 40)}"): title the page by its context (the page, the place or the period)`);

  // Periods on short strings.
  fold(
    "label-period",
    s.texts.filter((t) => t.text.split(/\s+/).length <= 8 && /[^.]\.$/.test(t.text) && !/\b(etc|inc|ltd|co|vs|no)\.$/i.test(t.text)).map((t) => ({ selector: t.selector, example: t.text.slice(0, 40) })),
    (ex, n) => `${n} short label${n === 1 ? " ends" : "s end"} with a period (${ex}): headings, buttons and labels don't take one`,
  );

  // Numbers too long to read back.
  fold(
    "long-digits",
    s.digits.map((d) => ({ selector: d.selector, example: d.text.slice(0, 30) })),
    (ex) => `long unbroken numbers (${ex}): group card, phone and account numbers in threes or fours ("4829 1750 3618 2947")`,
  );

  // Pure black text.
  if (s.black.count >= 3) push("pure-black-text", s.black.selector, `${s.black.count} text elements in pure #000 on a light surface: use the theme's text colour, a soft near-black`);

  // Light from below.
  fold(
    "upward-shadow",
    s.upward.map((u) => ({ selector: u.selector, example: u.value })),
    (ex) => `shadows cast upward (${ex}): light comes from above, so shadows fall below the object, soft and neutral`,
  );

  // Layout in motion.
  fold(
    "layout-animation",
    s.layoutMotion.map((m) => ({ selector: m.selector, example: m.what })),
    (ex) => `motion on layout properties (${ex}): animate transform and opacity instead; layout animation stutters`,
  );

  // Feedback that drags.
  fold(
    "slow-feedback",
    s.slow.map((m) => ({ selector: m.selector, example: `${m.ms}ms` })),
    (ex, n) => `${n} control${n === 1 ? "" : "s"} with state transitions over 500ms (${ex}): hover and press feedback takes 120 to 200ms`,
  );

  // A change without its baseline.
  fold(
    "delta-no-baseline",
    s.deltas.filter((d) => /\d/.test(d.text) && !/\b(vs\.?|versus|from|since|on|than|over|last|this|per|compared|in|of|before|after|ago|yesterday|today)\b/i.test(d.text)).map((d) => ({ selector: d.selector, example: d.text })),
    (ex) => `stat changes with nothing to compare to (${ex}): say against what ("+12% vs last month")`,
  );
  return findings;
}
