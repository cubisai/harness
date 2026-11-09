---
name: design-review
description: Review a design in a CubiQ design thread. Critique mode scores it through five lenses (brief, kit and tokens, accessibility, copy, layout) with concrete fixes, saves the critique and applies the fixes when asked. Handoff mode writes handoff.md for a developer from the kit parts the page actually uses, with their real imports and props. Use for "critique this", "what's wrong with this screen", "hand this off" or "write the dev spec".
mode: design
---

# Review a design

Pick the mode from the message: **critique** (review, score, fix) or **handoff** (a spec a developer builds from). Review `index.html` unless the user names another page.

## Look (both modes)

1. Read the page source, `system/KIT.md` and `system/DESIGN.md`.
2. `design_screenshot` at 390 and 1440 (`fullPage: true` for long pages; 1920 for a deck).
3. `design_lint` at 1440 (and 390 for mobile). Its findings are facts: carry them, with their selectors, into what you write. Its `Kit:` line says how much of the page is kit parts.
4. `design_kit_inspect page:"index.html"`: the parts the page uses, with their real library imports.

## Critique

Read `references/rubric.md` from this skill's folder. Score each lens 0–10; lint findings cap scores: a **contrast** or **targets** finding caps Accessibility at 6; a **kit**, **color** or **spacing** finding caps Kit & tokens at 7.

| Lens | Weight | What it asks |
| --- | --- | --- |
| Brief fit | 0.4 | Does it do what was asked: the right content, flows and states? |
| Kit & tokens | 0.2 | Built from the kit's parts and props; page CSS only for gaps, tokens only, on the 8pt scale, true to DESIGN.md? |
| Accessibility | 0.2 | Contrast, 44px targets, focus-visible, semantics, alt text |
| Copy | 0.2 | Real, specific, short; clear labels and errors |
| Layout | 0 | Hierarchy, alignment, rhythm (notes only) |

**Composite** = 0.4 × Brief + 0.2 × Kit + 0.2 × Accessibility + 0.2 × Copy, one decimal. **8.0 ships.** Reply with the composite line first, then the table, then at most 10 findings, most severe first (**Blocker**, **Major**, **Minor**), each naming the element (selector or `data-agent-id`) and the fix:

1. **Major · Kit** `.plan-card` redraws a card in page CSS → `<div data-ui="card" data-padding="lg">`, and drop the rule.

Save the composite, table and findings with `design_critique_save`, then give a 2–3 line summary in the chat.

**Fix** (when the user agrees, or asked "critique and fix"): Blockers and Majors first, preferring a kit part, prop or token over new CSS. Then look again, re-score and save that round. Stop at 8.0, or after 2 rounds: keep the best, list what's left, and end with each round's composite ("7.4 → 8.3").

## Handoff

Write `handoff.md` beside the page, from `assets/handoff-template.md`. A developer who never saw the canvas must be able to build it from this file plus the HTML.

- **Components**: from `design_kit_inspect page:`, one row per part used: the real import (`Button from @mui/material`), the props as the page sets them (`data-variant="ghost"` → `variant="ghost"`), and the count. Parts that came from page CSS instead are listed apart, as work the kit doesn't cover.
- **Tokens**: only the ones used (token, light / dark value, where); flag any literal value and suggest the token.
- **Layout** per breakpoint (390 / 768 / 1440), **states** per component, **interactions** and keyboard, **content** rules, **accessibility** (landmarks, heading order, focus order), **assets**, **open questions**.
- Measurements in px and as tokens (`24px / --space-6`). Tables and short bullets.

Say in one line that `handoff.md` is written and list the open questions. Don't paste it into the chat.
