---
name: design-critique
description: Review a design in a CubiQ design thread against a rubric - hierarchy, 8pt spacing, contrast, design-system token use, alignment, states, accessibility and copy - and return a five-lens scored table (brief, tokens, accessibility, copy, layout) with a weighted composite and concrete fixes, then apply them when asked. Use for "critique this", "what's wrong with this screen", or before handing a design off.
mode: design
---

# Critique a design

Review the design at the design folder's `index.html` (or the page the user names). Be specific and kind; every finding names the element and the fix.

## 1. Look

1. Read the page source and `system/DESIGN.md`.
2. Call `design_screenshot` at width 390 and at 1440 (add `fullPage: true` for long pages) and look at both. Without that tool, use browser tools, or reason from the source and say so.
3. Call `design_lint` (at 1440, and 390 for mobile designs). Its contrast, target, spacing and color findings are facts: carry them into your findings with their selectors.
4. Read `references/rubric.md` from this skill's folder.

## 2. Score (five lenses)

Score the design 0–10 through five lenses, then combine them. Lint findings are facts and cap scores: any **contrast** or **target** finding caps Accessibility at 6; **color** or **spacing** findings cap Tokens at 7.

| Lens | Weight | What it asks |
| --- | --- | --- |
| Brief fit | 0.4 | Does it do what was asked: the right content, flows and states? |
| Tokens & brand | 0.2 | Only the system's tokens, on the 8pt scale, true to its DESIGN.md? |
| Accessibility | 0.2 | Contrast, 44px targets, focus-visible, semantics, alt text |
| Copy | 0.2 | Real, specific, short; clear labels and errors |
| Layout | 0 | Hierarchy, alignment, rhythm (notes only: taste, not a gate) |

**Composite** = 0.4 × Brief + 0.2 × Tokens + 0.2 × Accessibility + 0.2 × Copy, one decimal. **8.0 ships.**

Reply in this shape, the composite line first:

**Composite: 7.4 / 10** (round 1)

| Lens | Score | Top issue |
| --- | --- | --- |
| Brief fit | 8 | No empty state for the invoice list |
| Tokens & brand | 7 | `.pricing .card` padding 20px is off the scale |
| … | | |

Then the findings, most severe first. Severity: **Blocker** (broken, inaccessible, unreadable), **Major** (clearly off-system or confusing), **Minor** (polish).

1. **Major · Tokens** `.pricing .card` padding 20px is off the 8pt scale → `var(--space-6)` (24).
2. …

Keep it to the 10 most useful findings. Quote selectors (or `data-agent-id`s) so the user can select them in the canvas.

Save the composite line, table and findings with `design_critique_save` (the user sees it as the thread's **Critique**, one version per round), then give a 2–3 line summary in the chat instead of repeating it.

## 3. Fix (when the user agrees, or asked "critique and fix")

Apply Blockers and Majors first, then Minors, in place in the design files. Then look again: screenshot, `design_lint`, re-score, and save that round's critique with `design_critique_save`. Stop as soon as the composite reaches **8.0**. Do at most **2 rounds** of review-then-fix; after the second, keep the best round, list what's left instead of looping, and end with each round's composite in one line (e.g. "7.4 → 8.3").
