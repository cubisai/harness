# Ant Design

## World
Ant Design as antd 6 ships it: dense enterprise screens in the system font at 14px, 32px controls with 6px corners, hairline borders and quiet grey fills. One blue, #1677FF, carries every action and selection. Surfaces barely lift; shadows belong to what floats. In dark mode the page is #141414, panels are #1F1F1F and the blue steps down to #1668DC.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` for the tabs, dialogs, select, cascader, pickers, calendar, tree, transfer, sliders, rate, colour picker, table sorting, pagination, carousel, splitter, tour and notices.
- Props are `data-<prop>` attributes with Ant's names and values: `<button data-ui="button" data-type="primary" data-size="small">`. The first value listed is the default, so leave the attribute off for it. Sizes are `small`, `middle` and `large`.
- Fields: put `data-ui="input"` on the `input` itself, or on a `span` holding a `data-part="field"` input with `prefix` and `suffix`. Join controls with `<div data-ui="space" data-compact="true">`, and use `data-part="addon"` inside it for a label.
- Icons: `<i data-ui="icon" data-name="search"></i>`, 1em wide, in the current colour. Set `font-size` to resize. Names: down, up, left, right, double-left, double-right, arrow-left, arrow-right, arrow-up, arrow-down, caret-down, caret-up, caret-right, caret-left, search, close, check, plus, minus, edit, delete, copy, filter, upload, download, cloud-upload, reload, sync, swap, logout, login, share-alt, link, printer, holder, vertical-align-top, loading, ellipsis, more, menu, check-circle, close-circle, info-circle, exclamation-circle, warning, minus-circle, plus-circle, question-circle, check-circle-outlined, close-circle-outlined, info-circle-outlined, exclamation-circle-outlined, question-circle-outlined, clock-circle, plus-circle-outlined, minus-circle-outlined, stop, home, user, team, mail, bell, calendar, setting, star, star-outlined, heart, heart-outlined, appstore, file, file-text, folder, folder-open, inbox, paper-clip, picture, eye, eye-invisible, lock, unlock, tag, global, message, comment, pushpin, dollar, credit-card, bank, shop, smile, frown, meh, bar-chart, pie-chart, line-chart, dashboard, rise, fall, form, table, unordered-list, truck, audit, wallet, safety.
- Calendar and date panels: write only `<div data-ui="calendar" data-month="2026-11" data-selected="2026-11-18"></div>`. ui.js draws the days. Time columns are drawn from `data-value` on `time-picker`.

## Composition
- Layout: `stack` for a column or row with named gaps, `grid` for columns, `flex` and `space` inside components. `layout` frames a whole app with a header, sider, content and footer.
- One primary button per view. Other actions are default, text or link. In a footer, buttons sit at the right with the primary last.
- Keep it dense. Forms and tables are the heart of this system: 32px controls, 16px table cells, 24px between form items. Use `data-size="middle"` on a table inside a card.
- Type is `typography`. Titles use `data-variant="title"` and `data-level` 1 to 5; working screens rarely need more than level 4. Text is 14px, secondary text is `data-type="secondary"`.
- Status in a table is a `tag`. Figures get `data-align="right"` on their cell.
- Cards have a hairline border, not a shadow. `data-hoverable` adds a shadow on hover. Anything that floats gets `--shadow-2`.
- Overlays: `<dialog>` for modal and drawer, opened by `data-dialog-open="<id>"`. Dropdowns, popovers and selects use the native `popover` attribute with `popovertarget` on the button.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), preset palettes (`--magenta-1` to `--purple-7`), charts (`--chart-1` to `-5`), type (`--text-*`, `--leading-*`, `--weight-*`), space (`--space-*`), controls (`--control-*`), radius, shadow and motion.
- `--color-primary` is a fill; its text is `--color-on-primary`. `-hover`, `-active`, `-bg`, `-bg-hover`, `-border` and `-text` are derived from it. Success, warning, danger and info work the same way.
- `--color-text-muted` is Ant's colorTextSecondary, `--color-text-tertiary` its colorTextTertiary. `--color-split` is for hairlines between content, `--color-border` for control edges.
- `--color-layout` is the grey behind an app; `--color-surface` is a card or the page.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep page spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: the behaviour listed above.
- `blocks/`: a hero, a feature grid, pricing, sign-in and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
