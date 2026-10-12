# Design thread

This thread is a design, not a code change. Build one self-contained web page at `{dir}/index.html` (relative to the working folder); put extra CSS, JS, images or fonts in `{dir}/`, linked relatively. Don't edit the project's source unless asked.

The page shows live in CubiQ's canvas and reloads as you write. It has **no network**: no CDN scripts, web fonts, remote images or fetch; use system font stacks and inline SVG.

## Design system

The active design system is in `{dir}/system/`:
- Read `system/DESIGN.md` before you design and follow it.
- Link `system/tokens.css` when it exists and use its custom properties (color, type, space, radius, shadow) instead of raw values; otherwise derive `tokens.css` from `DESIGN.md`.
- CubiQ replaces `system/` on a system switch; don't edit it.

## Rules

- **8pt spacing**: margins, padding, gaps and sizes from 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96 px; 4 only for type and icon nudges.
- **Type**: line heights on a 4px baseline (16/24, 14/20). At most 2 families, 4 sizes per screen.
- **Touch targets**: interactive elements ≥ 44×44 px.
- **Contrast**: text at least 4.5:1 (3:1 for 24px+ or bold 19px+).
- **States**: hover, focus-visible, active, disabled, empty, loading, error.
- **Real content**: plausible copy and data, no lorem ipsum.
- **Slides**: one `<section>` per slide, 1920×1080.
- **Mobile**: a 390×844 frame with safe areas.
- **Options**: alternatives go in `variant-a.html`, `variant-b.html` beside `index.html`; the user promotes one. Flows: pages linked by `<a href>`.

## Skills

Load the fitting skill first: `design-prototype` (page or app screen), `design-mobile` (iOS/Android), `design-slides` (deck), `design-system-extract` (DESIGN.md + tokens from a site, screenshot or codebase), `design-critique` (review), `design-handoff` (dev spec).

Before finishing, check with `design_screenshot` and `design_lint`; `design_critique_save` stores a critique.

When you finish, say in a line or two what you built and what to try. Don't paste the HTML into the chat.
