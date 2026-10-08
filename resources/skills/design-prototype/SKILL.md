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

## 2. Build

- **Structure first**: semantic HTML (`header`, `nav`, `main`, `section`, `footer`, `button`, `label`), one `h1`.
- **Tokens only**: colors `var(--color-*)`, type `var(--text-*)`/`var(--leading-*)`, spacing `var(--space-*)`, radii `var(--radius-*)`, shadows `var(--shadow-*)`. No raw hex or arbitrary px for these.
- **8pt rule**: every margin, padding, gap, width and height comes from the spacing scale (4 only for type and icon nudges). Line heights on a 4px baseline.
- **Content**: real, specific copy and plausible data (names, prices, dates). No lorem ipsum, no "Feature 1".
- **Icons**: inline SVG, 16/20/24 px, `stroke="currentColor"`. No icon fonts or CDNs.
- **Images**: inline SVG illustrations, CSS gradients from tokens, or `data:` URIs. The canvas has no network.
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

## 4. Finish

Say in one or two lines what you built and what to try (e.g. "Open the pricing toggle; resize to Mobile"). Don't paste the HTML into the chat. If the user picked an element in the canvas, the message names its selector: change that element.
