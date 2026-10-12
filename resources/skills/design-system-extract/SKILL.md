---
name: design-system-extract
description: Extract a design system from a website, a screenshot or this codebase into a DESIGN.md (9 sections) plus tokens.css on the 8pt scale, saved under .agents/design-systems/<name>/ so it appears in CubiQ's design-system picker. Use when the user wants to design "in the style of" something they already have.
mode: design
---

# Extract a design system

Output: a folder `.agents/design-systems/<name>/` in the project (kebab-case name) holding:
- `index.md`: frontmatter `type: design-system`, `name`, `description` (one sentence), `swatches` (4 colors, comma-separated: background, text, primary, accent).
- `DESIGN.md`: the 9 sections below.
- `tokens.css`: the token contract below.

Then build a one-page specimen at the design folder's `index.html` (linking `../../.agents/design-systems/<name>/tokens.css` won't load in the canvas, so copy `tokens.css` next to `index.html` as `tokens.css` for the specimen) showing colors, type scale, buttons, inputs, a card and a table, so the user can see the result. Tell the user to pick the new system in the composer's **System** menu to use it for later designs.

## 1. Gather

- If the message names a reference image (`refs/ref-<n>.png` in the design folder), open it with your file or image tool first and work from it.
- **Website** (URL): fetch it with your web or browser tools if you have them. Read the CSS: custom properties, the most-used colors (count them), font families, font sizes, line heights, paddings/gaps, radii, shadows, breakpoints. Ignore one-offs.
- **Screenshot**: estimate from the image; sample colors from large flat areas; infer the type scale from relative sizes. Say the values are estimates.
- **Codebase**: look for an existing theme (`tailwind.config.*`, CSS custom properties, `theme.ts`, SCSS variables, a `DESIGN.md`), and the most-used values in components.

## 2. Normalize

- Snap spacing to the 8pt scale 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96 (round to the nearest; note big shifts).
- Snap line heights to a 4px baseline. Map font sizes onto `xs sm md lg xl 2xl 3xl 4xl` (closest of 12 14 16 20 24 32 48 64; keep the source's value when it differs by more than 2px and say so).
- Name colors by role, not hue: `bg surface surface-2 text text-muted border primary on-primary accent success warning danger focus`. Check text pairs reach 4.5:1; if the source fails, darken/lighten and note it.
- Derive a dark theme when the source has none (invert surfaces, keep hue of primary, re-check contrast) and mark it as derived.
- Fonts: keep the source's family names first in the stack, then system fallbacks; the canvas has no network, so web fonts will fall back.

## 3. tokens.css contract (same names as CubiQ's built-ins)

`:root` with `color-scheme`, `--color-{bg,surface,surface-2,text,text-muted,border,primary,on-primary,accent,success,warning,danger,focus}`, `--font-{sans,display,mono}`, `--text-{xs..4xl}` + `--leading-{xs..4xl}`, `--weight-{regular,medium,bold}`, `--space-{1,2,3,4,6,8,10,12,16,20,24}` (4…96px), `--target-min: 44px`, `--content-max`, `--measure`, `--radius-{sm,md,lg,full}`, `--shadow-{1,2,3}`, `--duration-fast`, `--duration`, `--ease`; dark colors under `@media (prefers-color-scheme: dark)`; zero durations under `prefers-reduced-motion`. A built-in for reference: `system/tokens.css` in the design folder.

## 4. DESIGN.md sections

1. Visual theme and atmosphere (3–4 sentences: mood, density, references)
2. Color palette and roles (each token: value, role, where it's used)
3. Typography rules (families, scale with uses, weights, casing, measure)
4. Component stylings (buttons, inputs, cards, tables, nav, badges: sizes, radii, states)
5. Layout principles (grid, max width, gutters, spacing rhythm)
6. Depth and elevation (when each shadow/border is used)
7. Do's and don'ts (5–8 concrete rules)
8. Responsive behavior (breakpoints and what changes)
9. Agent prompt guide (one paragraph an agent can follow to design in this style)

## 5. Finish

List what you were unsure of (estimated values, derived dark theme, missing states) in 2–4 bullets.
