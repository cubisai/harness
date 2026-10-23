---
name: design-prototype
description: Design a web page or app screen as a live HTML prototype in a CubiQ design thread - landing pages, dashboards, settings, forms, flows. Starts from a scaffold that links the active design system's tokens, follows the 8pt rule, and covers every interactive state.
mode: design
---

# Prototype a page or screen

You are building a high-fidelity, clickable prototype that the user watches appear in CubiQ's canvas. It has to look finished, not like a wireframe.

## 1. Start

1. Read `system/DESIGN.md` in the design folder (the guide names it). Note its colors, type, radii and the component rules.
2. If `index.html` doesn't exist yet, copy `assets/index.html` from this skill's folder into the design folder and build from it. It links `system/tokens.css` and sets a small base (box-sizing, body font and color, focus ring).
3. If the request is vague, pick a sensible concrete product and content yourself and say so in one line at the end; don't stop to ask unless the choice changes everything.
4. If the message names a reference image (`refs/ref-1.png` in the design folder), open it with your file or image tool before you design. Take its layout, hierarchy, density, palette and type feel; don't copy its text, logos or photos, and still use the active system's tokens. Say in one line what you took from it.
5. **Plan the direction** for a new page (skip it for a change to an existing one): write `.direction.md` in the design folder, at most 120 words, never linked from a page.
   - **Thesis**: the one idea this page owns, from the subject's own world (its objects, materials, publications, rituals), not the category's usual page.
   - **Colour strategy**: restrained (tinted neutrals + one accent; screens people operate or read), committed (one colour carries 30–60% of the surface), full palette (3–4 named roles) or drenched (the surface is the colour). Light or dark from where it's used, not the category.
   - **Type roles** from the style's faces; the one **signature moment** (a hero treatment, an interaction, a layout move); what it **refuses**.
   - Then check it: would a similar prompt land on the same plan? Change that part before you build.

## Refuse the defaults

These read as generated, whatever the subject. Use one only when the brief asks for it (`design_lint` flags most):
- a small uppercase or tracked label (eyebrow) above every heading; `A · B · C` meta strings; `→` on every link
- grids of same-size cards with icon + heading + text as the page's structure; nested cards
- the hero-metric row (big number, small label, a gradient accent); 01 / 02 / 03 on things that aren't a sequence
- gradient text, glass and glow as decoration, a coloured 2px+ stripe on one side of a card, zero-blur offset shadows outside a neo-brutalist style
- emoji standing in for icons; a fade-and-slide entrance on every section (one orchestrated moment beats many)

Spend boldness in one place and keep the rest quiet. Operate and read surfaces show craft through precision and restraint; persuade and experience surfaces commit to the style's world.

## 2. Build

- **Structure first**: semantic HTML (`header`, `nav`, `main`, `section`, `footer`, `button`, `label`), one `h1`.
- **Stable ids**: put a short kebab `data-agent-id` on every section root, component root and interactive element (`data-agent-id="pricing-card-pro"`, `data-agent-id="cta-start"`). Keep the same ids when you rewrite, so the user's selection in the canvas still finds them.
- **Tokens only**: colors `var(--color-*)`, type `var(--text-*)`/`var(--leading-*)`, spacing `var(--space-*)`, radii `var(--radius-*)`, shadows `var(--shadow-*)`. No raw hex or arbitrary px for these.
- **8pt rule**: every margin, padding, gap, width and height comes from the spacing scale (4 only for type and icon nudges). Line heights on a 4px baseline.
- **Content**: real, specific copy and plausible data (names, prices, dates). No lorem ipsum, no "Feature 1".
- **Icons**: inline SVG, 16/20/24 px, `stroke="currentColor"`. No icon fonts or CDNs.
- **Images**: inline SVG illustrations, CSS gradients from tokens, or `data:` URIs. Real photos the user asks for go in an `img/` folder beside the page, linked by relative path. The canvas has no network: remote image URLs never load there.
- **Interaction**: small inline `<script>` for tabs, menus, dialogs, toggles, form validation. Keep it vanilla.
- **Layout**: CSS grid/flex; content max `var(--content-max)`; it must work at 390, 768 and 1440 wide (use `@media`).

Write the page in a few passes (structure, then styling, then states) so the user sees it grow in the canvas.

## 3. States checklist

Before you finish, every interactive element has:
- [ ] hover and `:focus-visible` (2px ring, `var(--color-focus)`, offset 2)
- [ ] active/pressed and disabled
- [ ] targets ≥ 44×44 px
- [ ] empty, loading and error variants where data appears (show them in a "States" section or behind a toggle when there's no natural place)
- [ ] text contrast ≥ 4.5:1 (tokens already pass; don't put muted text on `surface-2` at small sizes without checking)

## Tweaks

Give the page 2–5 tweaks the user can change live in the canvas without a new turn: theme, density, accent, radius, a layout switch. Declare them in `<head>`:

```html
<script type="application/json" id="cubiq-tweaks">{"tweaks":[
  {"id":"theme","label":"Theme","type":"choice","options":["light","dusk"],"default":"light"},
  {"id":"density","label":"Density","type":"choice","options":["comfy","compact"],"default":"comfy"},
  {"id":"badges","label":"Badges","type":"toggle","default":true},
  {"id":"accent","label":"Accent","type":"color","var":"--color-accent","default":"#3b5bdb"},
  {"id":"radius","label":"Radius","type":"range","var":"--radius-md","min":0,"max":24,"step":4,"unit":"px","default":8}
]}</script>
```

- `choice` and `toggle` set `data-<id>` on `<html>` (a toggle is `on`/`off`). Write the defaults there too (`<html data-theme="light" data-density="comfy" data-badges="on">`) and style every value: `[data-theme="dusk"] { --color-bg: …; }`, `[data-density="compact"] main { … }`, `[data-badges="off"] .badge { display: none; }`.
- `color` and `range` set that CSS variable on `:root`; use the variable in your CSS.
- Ids are lowercase-kebab and options lowercase words. When the user clicks Keep, CubiQ writes the chosen values into the file; don't fight them on the next edit.

## Options and flows

- Asked for options, directions or variations: write 2–4 files `variant-a.html`, `variant-b.html`, … beside `index.html`, each a complete page from the same scaffold and tokens, and differing in layout and hierarchy (not only colour). Leave `index.html` as it is unless asked; the user promotes one from the canvas. Say in one line what each option tries.
- Several screens: one page per screen in the design folder, linked with relative `<a href="checkout.html">`. Keep shared CSS in one file beside them. For a step-by-step flow, or desktop and mobile versions side by side, name them `<section>--<NN>-<name>.html` (`checkout--01-cart.html`, `checkout--02-payment.html`, `mobile--01-cart.html`) so CubiQ's Board view shows each section as numbered artboards at the right size. A page that is one phone or tablet screen says so in its head: `<meta name="cubiq-device" content="mobile">` (or `tablet`).

## 4. Finish

Before you call it done, load every page you wrote (`design_screenshot`, or the browser tools) and fix each console error and broken image: one script error stops every interaction on the page. Don't report it working from reading the code.

Say in one or two lines what you built and what to try (e.g. "Open the pricing toggle; resize to Mobile"). Don't paste the HTML into the chat. If the message has a `Selected in …` block, change only those elements (find each by its `data-agent-id`, else its selector) and leave the rest of the page as it is; if the change needs more, say so instead.
