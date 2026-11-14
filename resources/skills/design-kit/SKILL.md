---
name: design-kit
description: Work on the design kit itself rather than the page - start a new kit, add a component, change the system, match a screenshot by token values, or extract a kit from a website, screenshot or codebase so later designs use it. CubiQ names this skill when the user picks one of those; follow the path it names, or the extract path when the user asks to design "in the style of" something they have.
mode: design
---

# Work on the kit

A kit is a folder of HTML and CSS parts. The page's `system/` (in the design folder) uses the active kit; never edit `system/`. Kit work happens in the draft `kit/` beside it, which CubiQ has already filled with a copy (of Foundation for a new kit, else of the active kit). Look with `design_kit_inspect` (no arguments: parts by category and blocks; `search:` parts by words; `component:` one part's props and snippet). When no draft is there yet, `design_kit_inspect start_draft: true` makes one.

## The draft folder

- `components.json`: `kitId` (lowercase slug), `name`, `version`, and `components[]`. Each entry: `name`, `ui` (the `data-ui` value, a slug), `category`, `description` (≤300 chars), `props[]`, `snippet`, and `"status": "new"` on parts you add.
- A prop is `{ name, label, type: "choice" | "boolean" | "text", options?, default? }`. A choice needs `options`, and its `default` must be one of them. A prop `size` is written `data-size="md"` on the element; never name one `ui`.
- `snippet`: the HTML a page gets, with `data-ui="<ui>"` on its root and the default props as attributes. Real content, ≤4096 chars.
- `ui.css`: every part's rules inside `@layer cubiq-ui { … }`, scoped `[data-ui="x"]`, variants as `[data-ui="x"][data-variant="ghost"]`. Every component needs at least one `[data-ui="x"]` selector. Use only tokens: no literal colours, fonts, sizes or radii (0, 1px hairlines and percentages are fine). Cover hover, `:focus-visible`, disabled, and the dark scheme through tokens.
- `tokens.css`: the token names `system/tokens.css` uses (it must define `--color-bg` and `--color-text`), with the dark pair under `@media (prefers-color-scheme: dark)`. Check text pairs reach 4.5:1.
- `DESIGN.md`: the kit's rules; `index.md`: frontmatter `type: design-kit`, `name`, `description`.
- Allowed files: .md .css .js .json .html .svg .woff2 .png .jpg .webp. No network, no CDN.

Reuse before adding: a variant or prop on an existing part beats a new part, and a new part is built from existing ones and tokens.

## Paths

**New kit** (`Start a new kit`). `kit/` is Foundation renamed `my-kit`.
1. From the request, pick a name; set `kitId` (slug), `name` and `index.md`.
2. Rewrite `tokens.css` for the product (colour roles, type, radius, spacing, light and dark) and `DESIGN.md` to match. Keep Foundation's parts and its token names.
3. Add only the parts the page needs that the kit lacks (`"status": "new"`, rules in `ui.css`).
4. Call `design_kit_save`. It validates, saves the kit to the project and switches this design to it; fix what it lists and call it again.
5. In the same turn, build the page: load the `design-build` skill and follow it from its scaffold step (no `design_set_direction`: the kit is the direction), with `data-ui` parts from `system/`. The kit isn't done until `index.html` uses it. Say which parts are new.

**New component** (`New component`). Add one entry with `"status": "new"` and its `ui.css` rules, with props for what varies. If a selection is given, start from its markup and replace raw values with tokens. Don't call `design_kit_save` and don't put it on the page: the user tries it in System mode and saves it there.

**Change the system** (message about the design system, e.g. `Library · Button · Light`). Change `kit/` only: tokens, a part's rules, a variant or a prop, for the part or foundation named. Don't edit pages and don't call `design_kit_save`: System mode shows the draft for review.

**Match a screenshot** (`Match a screenshot`). Markup and the kit stay as they are.
1. Open the image in the design folder's `refs/` with your image or file tool.
2. Read `system/tokens.css` and choose new values for the tokens it has: background, surfaces, text, muted text, border, primary and on-primary, accent, radius, maybe fonts (system stacks only). Keep every text pair at 4.5:1.
3. Call `design_tokens_apply` once with all of them. It is one undo step; names `tokens.css` lacks are refused.

**Extract a kit** (a website, a screenshot or this codebase, "in the style of …"). The kit's parts stay; its tokens and rules come from the source.
1. Start a draft (`start_draft: true`) if `kit/` is empty, then name it: `kitId`, `name`, `index.md`.
2. Gather: a website's CSS (custom properties, the most-used colours, families, sizes, line heights, paddings, radii, shadows; ignore one-offs); a screenshot by eye from large flat areas (say they're estimates); a codebase's theme (`tailwind.config.*`, CSS variables, `theme.ts`, SCSS variables).
3. Normalize: spacing to 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96; line heights to a 4px baseline; colours by role, not hue, with text pairs at 4.5:1 (adjust and say so); a derived dark pair when the source has none, marked as derived. Fonts: the source's families first, then system fallbacks (no network).
4. Write them into `kit/tokens.css` under the token names it already has, and the source's look and rules into `kit/DESIGN.md` (atmosphere, colour roles, type, component styling, layout, elevation, dos and don'ts).
5. A part the source has and the kit lacks: add it (`"status": "new"`) as above. Then `design_kit_save`, and build a one-page specimen from the kit's parts (colours, type scale, buttons, inputs, a card, a table). List what you were unsure of in 2–4 bullets.

## Finish

Check with `design_screenshot` when the page changed. Then say in two or three lines what changed (for example "Read screen.png · 14 tokens changed · no components touched", or "Draft: PricingCard added · review it in System"). Name any value you estimated.
