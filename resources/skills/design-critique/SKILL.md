---
name: design-critique
description: Review a design in a CubiQ design thread against a rubric - hierarchy, 8pt spacing, contrast, design-system token use, alignment, states, accessibility and copy - and return a scored table with concrete fixes, then apply them when asked. Use for "critique this", "what's wrong with this screen", or before handing a design off.
mode: design
---

# Critique a design

Review the design at the design folder's `index.html` (or the page the user names). Be specific and kind; every finding names the element and the fix.

## 1. Look

1. Read the page source and `system/DESIGN.md`.
2. Call `design_screenshot` at width 390 and at 1440 (add `fullPage: true` for long pages) and look at both. Without that tool, use browser tools, or reason from the source and say so.
3. Call `design_lint` (at 1440, and 390 for mobile designs). Its contrast, target, spacing and color findings are facts: carry them into your findings with their selectors.
4. Read `references/rubric.md` from this skill's folder.

## 2. Score

Score each rubric area 1–5 and list findings, most severe first. Severity: **Blocker** (broken, inaccessible, unreadable), **Major** (clearly off-system or confusing), **Minor** (polish).

Reply in this shape:

| Area | Score | Top issue |
| --- | --- | --- |
| Hierarchy | 3 | Two equal-weight CTAs in the hero |
| … | | |

Then the findings:

1. **Major · Spacing** `.pricing .card` padding 20px is off the 8pt scale → `var(--space-6)` (24).
2. …

Keep it to the 10 most useful findings. Quote selectors so the user can pick them in the canvas.

Save the table and findings with `design_critique_save` (the user sees it as the thread's **Critique**, one version per round), then give a 2–3 line summary in the chat instead of repeating it.

## 3. Fix (when the user agrees, or asked "critique and fix")

Apply Blockers and Majors first, then Minors, in place in the design files. Then look again: screenshot, `design_lint`, re-score, and save that round's critique with `design_critique_save`. Do at most **2 rounds** of review-then-fix; after the second, list what's left instead of looping. End with the new scores in one line.
