# shadcn/ui

## World
Quiet zinc neutrals, hairline borders and tight controls. Every part is a thin outline on white, with one dark fill per view. Nothing shouts: the type does the work, at 14px in controls and medium weight on labels. Dark mode swaps the same roles, so no markup changes.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML.
- Link `system/tokens.css`, then `system/ui.css`. Add `system/ui.js` only when the page uses tabs or dialogs.
- Props are `data-<prop>` attributes: `<button data-ui="button" data-variant="outline" data-size="sm">`. The first value listed is the default, so leave the attribute off for it.
- Variants use the names shadcn/ui gives them: default, destructive, outline, secondary, ghost, link.

## Composition
- Layout: `stack` for a column of blocks, `grid` for columns of parts. Both take a gap of none, xs, sm, md, lg or xl.
- One default button per view. Other actions are outline, ghost or link.
- Every form control sits in a `field` with a label. Description above, message below.
- Card and its friends carry `data-part` names: `header`, `title`, `description`, `action`, `content`, `footer`.
- Status in a table is a `badge`: outline for Paid, secondary for Pending, destructive for Overdue. Figures get `data-numeric="true"`.
- Numbers in tables use `font-variant-numeric: var(--numeric-data)`.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), type (`--text-*`, `--leading-*`, `--tracking-*`), space (`--space-*`), control heights (`--control-*`), radius, shadow and motion.
- `--color-primary` is a fill; its text is `--color-on-primary`.
- `--color-accent-text` for accent text, `--color-accent-soft` behind it.
- `--color-border-strong` for inputs and the focus border; `--color-border` for hairlines.
- Overlays use `--overlay` behind them.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the zinc tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: tab switching and dialog open and close. Dropdowns and popovers use the native `popover` attribute, so they need no script.
- `blocks/`: a hero, a feature grid, pricing, login and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
