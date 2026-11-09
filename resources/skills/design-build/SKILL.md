---
name: design-build
description: Build a design in a CubiQ design thread from its kit - a web page, app screen or dashboard, phone screens (390x844), or a slide deck (1920x1080) - as live HTML composed from the kit's data-ui parts and blocks, with the kit theme's tokens, every state and real content. Use for any new page, screen or deck, and for big changes to one.
mode: design
---

# Build from the kit

The user watches the page appear in CubiQ's canvas. It must look finished, and it is made of the kit's parts.

## 1. Start

1. Read `system/KIT.md` (how to build with the kit) and `system/DESIGN.md` (the theme's look: colour, type, mood). Without `KIT.md`, `DESIGN.md` covers both. Read `system/patterns.md` for the surface's anatomies.
2. Run `design_kit_inspect` once: the parts by category and the blocks. Use `search:` to find a part ("date", "table", "pricing") and `component:` for its props and snippet before you use it.
3. If the message names a reference image (`refs/ref-1.png`), open it first. Take its layout, hierarchy, density and type feel; keep the kit's parts and tokens. Say in one line what you took from it.
4. A vague request: pick a concrete product and content yourself and say so in one line at the end.
5. A new page: write `.direction.md` (at most 120 words, never linked): the one idea the page owns, from the subject's own world; the colour strategy (restrained, committed, full palette or drenched); the signature moment; what it refuses. Would a similar prompt land on the same plan? Change that part first.
6. Copy the scaffold for the surface from this skill's `assets/` into the design folder as `index.html` (deck: `deck.html` as `index.html`, plus `deck.css` and `deck.js`). It links `system/tokens.css`, `system/ui.css` and `system/ui.js`.

## 2. Compose

- **Grounding rule**: use only parts, props and prop values that `components.json` declares. A part you can't find with `design_kit_inspect` doesn't exist: compose it from existing parts, or write plain HTML with page CSS.
- **Order**: big asks go layout and navigation first (`navbar`, `section`, `stack`, `grid`), then one section at a time, so the user sees it grow.
- **Blocks first**: start a section from a file in `system/blocks/` when one fits; copy it and change its content.
- **Parts**: a part is `data-ui` on plain HTML; props are `data-<prop>` attributes, and the default needs no attribute. A variant or prop beats new CSS.
- **Page CSS** only for what the kit lacks: page layout, a signature moment, a part the kit has no version of. Tokens only (`var(--color-*)`, `--space-*`, `--text-*`, `--radius-*`, `--shadow-*`), no literal colours or sizes. Never restyle a part through `[data-ui="…"]`; `design_lint` flags it.
- **Stable ids**: a short kebab `data-agent-id` on every section root, component root and interactive element; keep them when you rewrite, so the user's selection still finds them.
- **Content**: real, specific copy and data; names, prices and dates that agree. **Icons**: symbols from `system/icons.svg`, `stroke="currentColor"`, never emoji. **Images**: inline SVG or `data:` URIs; photos the user gives go in `img/`. No network.
- **Interaction**: `system/ui.js` runs tabs, accordion and dialog; anything else is a small vanilla inline `<script>`.

## Refuse the defaults

Unless the brief asks for one: eyebrow labels above every heading, `A · B · C` meta strings, same-size icon-card grids as the page's structure, the hero-metric row, gradient text, glass and glow as decoration, side stripes on cards, emoji icons, a fade-in on every section. Spend boldness in one place. Before → after:
- **Hero**: "Elevate your mornings" + two buttons → "This week: Ethiopia Guji, batch 214", a spec strip, the price in the button ("Shop the roast · $22").
- **Features**: three icon cards → the product itself in HTML (a board with real tickets) and two callouts pointing at it.
- **Dashboard**: four equal KPI cards → the one number that needs action, large, then a ranked `table` with `data-numeric` figures.
- **Copy**: "Unlock seamless collaboration" → what it does, for whom ("Assign a ticket from the pull request").

## 3. Surfaces

**Page, screen, workspace** (`page.html`): one `h1`; content inside `var(--content-max)`; works at 390, 768 and 1440 (`@media`). Several screens: one page each, linked with relative `<a href>`; for a flow name them `<section>--<NN>-<name>.html` so the Board shows numbered artboards.

**Mobile** (`mobile.html`): one `<section class="phone" aria-label="…">` per screen with `.status-bar`, a scrolling `.screen`, optional `.tab-bar`, `.home-indicator`. iOS unless asked: large title 32/40, tab bar 49 with 4–5 items; Android: 64 top bar, 80 bottom navigation. Targets 44 (iOS) / 48 (Android); 16 side margins; full-width primary `button` 48–56 tall; status bar time 9:41. A flow of four or more screens: one page each, `mobile-flow--01-<name>.html`, with `<meta name="cubiq-device" content="mobile">` and no frame (the canvas draws the device); only `.screen` scrolls.

**Deck** (`deck.html`): one `<section class="slide">` per slide at 1920×1080. Plan the titles first, one idea per slide, the title stating the takeaway ("Churn fell 18% after onboarding v2"). Mix title, divider (full `--color-primary` ground), statement, big number, chart, quote, comparison and closing slides. At most ~30 words of body. Charts in inline SVG with direct labels. Don't rewrite `deck.js` or `deck.css`. Speaker notes: `<aside class="notes" hidden>`.

## 4. States and tweaks

- Every interactive element: hover, `:focus-visible`, active, disabled, targets ≥ 44×44. Data views: empty, loading and error, in a "States" section when there's no natural place. Text contrast ≥ 4.5:1.
- Tweaks (not on the Quick tier): 2–5 in `<head>`, live in the canvas:

```html
<script type="application/json" id="cubiq-tweaks">{"tweaks":[
  {"id":"density","label":"Density","type":"choice","options":["comfy","compact"],"default":"comfy"},
  {"id":"accent","label":"Accent","type":"color","var":"--color-accent","default":"#3b5bdb"}
]}</script>
```

  `choice`/`toggle` set `data-<id>` on `<html>` (write the defaults there and style every value); `color`/`range` set that variable on `:root`.
- Options: 2–4 complete pages `variant-a.html`, `variant-b.html`, differing in layout and hierarchy; leave `index.html` alone.

## 5. Finish

Run `design_lint` on each page and fix every `kit`, contrast and targets finding; its `Kit:` line says how much of the page is kit parts. Load each page with `design_screenshot` (390 and 1440; 1920 for a deck) and fix console errors and broken images. Delete scratch files you made. Then say in one or two lines what you built and what to try. If the message has a `Selected in …` block, change only those elements.
