# shadcn/ui

## World
The library's current default look: neutral greys, compact 32px controls, 10px radii and 14px text. Cards and menus sit on a thin ring instead of a shadow or a border. Destructive actions are tinted, not solid. Quiet, tight and precise: the type does the work. Dark mode swaps the same roles, so no markup changes.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` whenever the page uses a calendar, tabs, dialogs, select, combobox, command, carousel, toast, toggles or resizable panels.
- Props are `data-<prop>` attributes: `<button data-ui="button" data-variant="outline" data-size="sm">`. The first value listed is the default, so leave the attribute off for it. Names match the library: variants default, outline, secondary, ghost, destructive, link.
- Icons: `<i data-ui="icon" data-name="search"></i>`, sized by their parent, drawn in the current text colour. Names: chevron-down, -up, -left, -right, chevrons-up-down, check, x, plus, minus, search, more-horizontal, more-vertical, calendar, circle, arrow-left, -right, -up, -down, arrows-up-down, info, alert-circle, alert-triangle, check-circle, clock, loader, settings, user, users, credit-card, log-out, mail, home, inbox, file, file-text, folder, image, copy, trash, pencil, panel-left, bold, italic, underline, bookmark, terminal, globe, sparkles, download, upload, paperclip, send, bell, star, sun, moon, filter, grip-vertical, chart-bar, layout-dashboard, link, external-link, trending-up, trending-down, tag.
- Calendar: write only `<div data-ui="calendar" data-month="2026-11" data-selected="2026-11-02"></div>`. ui.js draws the days, so they're always right.

## Composition
- Layout: `stack` for a column or row, `grid` for columns. Both take a gap of none, xs, sm, md, lg or xl.
- One default button per view. Other actions are outline, ghost or link.
- Every form control sits in a `field` with a label. Description and error come after the control. Use a horizontal field for checkboxes and switches.
- A card's parts: `header` (`title`, `description`, `action`), `content`, `footer`. Footers are tinted and sit flush with the edge.
- Status in a table is a `badge`. Figures get `data-align="end"` on their cell.
- Overlays: `<dialog>` for dialog, alert-dialog, sheet and drawer, opened by `data-dialog-open="<id>"`. Menus and popovers use the native `popover` attribute with `popovertarget` on the button.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), charts (`--chart-1` to `-5`), type (`--text-*`, `--leading-*`, `--tracking-*`), space (`--space-*`), control heights (`--control-*`), radius, shadow and motion.
- `--color-primary` is a fill; its text is `--color-on-primary`. `--color-surface-2` is the muted fill, `--color-text-muted` the muted text.
- `--hairline` is the ring on cards and menus: `box-shadow: 0 0 0 1px var(--hairline)`.
- `--ring` is the focus ring: `box-shadow: 0 0 0 var(--ring-width) var(--ring)`.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep page spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: the behaviour listed above.
- `blocks/`: a hero, a feature grid, pricing, login and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
