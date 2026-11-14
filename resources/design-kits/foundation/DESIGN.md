# Foundation

## World
The base kit every page starts from. Neutral, calm and complete: layout, type, forms, navigation and feedback, with no personality of its own. Character comes from the theme: swap `system/tokens.css` and the same parts take on a different style.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML.
- Link `system/tokens.css`, then `system/ui.css`. Add `system/ui.js` only when the page uses tabs, accordion or dialog.
- Props are `data-<prop>` attributes: `<div data-ui="grid" data-columns="3" data-gap="md">`. The first value listed for a prop is the default, so leave the attribute off for it.
- Use `stack` and `grid` for layout instead of writing flex or grid CSS.
- Start from a file in `blocks/` when one fits, then edit its copy.

## Composition
- Layout: `stack` for a column of blocks, `grid` for columns of equal parts; both take a `gap` of none, xs, sm, md, lg or xl.
- One primary button per view. Other actions are secondary or ghost.
- Every form control sits in a `field` with a label. Put the hint above the error.
- Cards separate with a border or a fill, not both with a shadow.
- Numbers in tables get `data-numeric="true"`.
- Headline figures are a `stat`; an empty list or view is an `empty-state` with one action.
- Deck slides: put a `slide` part inside each 1920x1080 `.slide`; it draws the same parts at twice their screen size, so don't hand-size slide type.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), type sizes and leading (`--text-*`, `--leading-*`), space (`--space-*`), radius, shadow and motion.
- `--color-primary` is a fill; its text is `--color-on-primary`.
- `--color-accent-text` for accent text, `--color-accent-soft` behind it.
- `--color-border-strong` for inputs; `--color-border` for hairlines.
- `font-variant-numeric: var(--numeric-data)` on figures.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the default tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: tab switching and dialog open and close.
- `blocks/`: starting points. Pages: site header and footer, hero, feature grid, stats, logo row, testimonials, pricing, FAQ, CTA band. Forms: sign in, settings. Apps: dashboard shell. Decks: title, content, metric and quote slides.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
