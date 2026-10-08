---
name: design-critique
description: Review a design in a CubiQ design thread against a rubric - hierarchy, 8pt spacing, contrast, design-system token use, alignment, states, accessibility and copy - and return a scored table with concrete fixes, then apply them when asked. Use for "critique this", "what's wrong with this screen", or before handing a design off.
mode: design
---

# Critique a design

Review the design at the design folder's `index.html` (or the page the user names). Be specific and kind; every finding names the element and the fix.

## 1. Look

1. Read the page source and `system/DESIGN.md`.
2. If you have a screenshot tool (`design_screenshot`) or browser tools, look at it at 390 and 1440 wide; otherwise reason from the source and say so.
3. Read `references/rubric.md` from this skill's folder.

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

## 3. Fix (when the user agrees, or asked "critique and fix")

Apply Blockers and Majors first, then Minors, in place in the design files. Do at most **2 rounds** of review-then-fix; after the second, list what's left instead of looping. End with the new scores in one line.
