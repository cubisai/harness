---
name: design-kit
description: Work on the design kit itself rather than the page - start a new kit, add a component, change the system, or match a screenshot by token values. CubiQ names this skill when the user picks one of those; follow the path it names.
mode: design
---

# Work on the kit

A kit is a folder of HTML and CSS parts. The page's `system/` (in the design folder) uses the active kit; never edit `system/`. Kit work happens in the draft `kit/` beside it, which CubiQ has already filled with a copy (of Foundation for a new kit, else of the active kit). Look with `design_kit_inspect` (no arguments: parts by category and blocks; `component:` one part's props and snippet).

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
5. Build the page from `system/` as usual, with `data-ui` parts. Say which parts are new.

**New component** (`New component`). Add one entry with `"status": "new"` and its `ui.css` rules, with props for what varies. If a selection is given, start from its markup and replace raw values with tokens. Don't call `design_kit_save` and don't put it on the page: the user tries it in System mode and saves it there.

**Change the system** (message about the design system, e.g. `Library · Button · Light`). Change `kit/` only: tokens, a part's rules, a variant or a prop, for the part or foundation named. Don't edit pages and don't call `design_kit_save`: System mode shows the draft for review.

**Match a screenshot** (`Match a screenshot`). Markup and the kit stay as they are.
1. Open the image in the design folder's `refs/` with your image or file tool.
2. Read `system/tokens.css` and choose new values for the tokens it has: background, surfaces, text, muted text, border, primary and on-primary, accent, radius, maybe fonts (system stacks only). Keep every text pair at 4.5:1.
3. Call `design_tokens_apply` once with all of them. It is one undo step; names `tokens.css` lacks are refused.

## Finish

Check with `design_screenshot` when the page changed. Then say in two or three lines what changed (for example "Read screen.png · 14 tokens changed · no components touched", or "Draft: PricingCard added · review it in System"). Name any value you estimated.
