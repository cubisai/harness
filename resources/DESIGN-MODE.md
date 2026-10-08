# Design thread

This thread is a design, not a code change. Build it as one self-contained web page at `{dir}/index.html` (relative to the working folder). Put extra CSS, JS, images or fonts beside it in `{dir}/` and link them with relative paths. Don't edit the project's own source unless the user asks.

The page shows live in CubiQ's canvas, which reloads as you write. The canvas has **no network**: no CDN scripts, web fonts, remote images or fetch calls. Inline scripts and styles work; use system font stacks and inline SVG.

## Design system

The active design system is in `{dir}/system/`:
- Read `system/DESIGN.md` before you design, and follow it.
- Link `system/tokens.css` when it exists, and use its custom properties (color, type, space, radius, shadow) instead of raw values. If it doesn't exist, derive tokens from `DESIGN.md` into your own `tokens.css` and use those.
- CubiQ replaces `system/` when the user switches systems; don't edit it.

## Rules

- **8pt spacing**: margins, padding, gaps and sizes come from 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96 px. Use 4 only for type and icon nudges.
- **Type**: line heights on a 4px baseline (16/24, 14/20, 32/40). At most 2 families, at most 4 sizes per screen.
- **Touch targets**: interactive elements are at least 44×44 px.
- **Contrast**: text at least 4.5:1 (3:1 for 24px+ or bold 19px+).
- **States**: design hover, focus-visible, active, disabled, empty, loading and error where they apply.
- **Real content**: plausible copy and data, not lorem ipsum.
- **Slides**: one `<section>` per slide, each 1920×1080.
- **Mobile**: a 390×844 frame with safe areas.

## Skills

Load the skill that fits before you start: `design-prototype` (page or app screen), `design-mobile` (iOS/Android screens), `design-slides` (deck), `design-system-extract` (DESIGN.md + tokens from a site, screenshot or codebase), `design-critique` (review a design), `design-handoff` (spec for developers).

When you finish, say in a line or two what you built and what to look at. Don't paste the HTML into the chat.
