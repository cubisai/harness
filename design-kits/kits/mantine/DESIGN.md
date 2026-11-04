# Mantine

## World
Mantine's default theme: a system font stack, 8px default radius, 36px small controls, blue primary (#228be6), grey text and dimmed captions, Mantine's shadow steps. Dark mode uses Mantine's dark surfaces (body #242424, inputs #2e2e2e, borders #424242), so no markup changes between the two.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` for tabs, dialogs and the select's option list.
- Props are `data-<prop>` attributes with Mantine's names: `<button data-ui="button" data-variant="light" data-size="sm">`. The first value listed is the default, so leave the attribute off for it. A button is `filled` and `sm` unless you say otherwise.
- Colour props (`data-color`) take `blue` (the default), `teal`, `yellow` or `red`. They map to the success, warning and danger roles.
- Icons: `<i data-ui="icon" data-name="check"></i>`, 1.125em, in the current colour. Names: chevron-down, chevron-up, chevron-left, chevron-right, check, x, plus, minus, search, eye, eye-off, bell, info, alert-triangle, circle-check, alert-circle, arrow-left, arrow-right, home, settings, user, mail, calendar, star, download, upload, file, dots, dots-vertical, logout, refresh, bolt, chart-bar, table.
- Overlays: `<dialog>` for modal and drawer, opened by `data-dialog-open="<id>"`, closed by `data-dialog-close`. Popovers and menus use the `popover` attribute with `popovertarget` on the button.

## Composition
- Layout: `stack` for a column, `group` for a row that wraps, `simple-grid` for equal columns, `container` for a centred width. Gaps are `xs`, `sm`, `md`, `lg` or `xl`.
- One filled button per view. Other actions are default, light or subtle. In a card or dialog footer, put the primary action last.
- Headings are `title` with `data-order`. Body text is `text`; dimmed text is for captions only.
- Elevation means something: cards and papers use `shadow` only when they float. Dialogs take the largest shadow.
- Status is a `badge` with a `data-color`. Tables put figures in cells as plain text.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), type (`--text-*`, `--leading-*`, `--weight-*`), space (`--space-*`), radius (`--radius-*`), shadows (`--shadow-1` to `-3`) and motion.
- Spacing is Mantine's scale: `--space-xs` is 10px, `--space-sm` 12px, `--space-md` 16px, `--space-lg` 20px and `--space-xl` 32px. The numbered names keep the same values. This is not a 4px grid.
- `--color-primary` is a fill, `--color-accent-text` is accent text on light and dark, and `--color-accent-soft` is the light variant's background.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours. Keep page spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: tabs, dialogs and the select's option list.
- `blocks/`: a hero, a feature grid, pricing, sign-in and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under system/: they are shared by every page.
