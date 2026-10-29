---
name: design-handoff
description: Write a developer handoff spec for a design in a CubiQ design thread - tokens used, layout and breakpoints, every component with its states and measurements, interactions, accessibility notes and assets - as handoff.md beside the design. Use when a design is ready to build.
mode: design
---

# Developer handoff

Write `handoff.md` in the design folder, next to `index.html`, using `assets/handoff-template.md` from this skill's folder as the outline. A developer who never saw the canvas must be able to build it from this file plus the HTML.

## 1. Read

The design's HTML/CSS/JS, `system/DESIGN.md` and `system/tokens.css`. Note which tokens the design actually uses.

## 2. Write

- **Overview**: what the screen/flow is, the design system, the files.
- **Tokens**: only the ones used, as a table (token, value light / dark, where). Flag any raw value that isn't a token and suggest the token.
- **Layout**: grid, max width, gutters, section spacing; per breakpoint (390 / 768 / 1440) what changes.
- **Components**: one subsection each. Size (height, padding, radius, font), variants, and every state (default, hover, focus-visible, active, disabled, loading, error, empty) with what changes. Reference the selector in the HTML.
- **Interactions**: what each control does, transitions (`--duration`, `--ease`), keyboard behavior.
- **Content**: copy rules, truncation, max lengths, number/date formats.
- **Accessibility**: landmarks, heading order, labels, focus order, contrast notes, reduced motion.
- **Assets**: inline SVGs and images, with suggested export names.
- **Open questions**: anything the design doesn't decide.

Measurements in px on the 8pt scale and as tokens (`24px / --space-6`). Keep it scannable: tables and short bullets, no prose padding.

## 3. Finish

Say in one line that `handoff.md` is written and list any open questions. Don't paste the whole spec into the chat.
