# MUI

## World
Material Design as Material UI ships it: Roboto, uppercase buttons at 36.5px, 56px fields with floating labels, 4px corners and layered shadows that say what floats above what. Blue primary, purple secondary, a ripple under every press. In dark mode surfaces are #121212 and lift with a white overlay instead of a darker shadow, so no markup changes.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` for the ripple, tabs, dialogs, select, autocomplete, sliders, rating, toggles, tree view, calendar, grid sorting and transfer list.
- Props are `data-<prop>` attributes with MUI's names and values: `<button data-ui="button" data-variant="contained" data-color="success" data-size="small">`. The first value listed is the default, so leave the attribute off for it. A button is `text` unless you say otherwise.
- Text fields: keep `placeholder=" "` on the input so the label can float, and copy the `fieldset` with the label's text inside it: that hidden copy cuts the notch in the outline. Filled and standard fields have no fieldset.
- Icons: `<i data-ui="icon" data-name="search"></i>`, 24px, in the current colour. Names: menu, search, close, add, remove, check, edit, delete, check-circle, success-outlined, info, info-outlined, warning, warning-outlined, error, error-outlined, expand-more, expand-less, chevron-left, -right, first-page, last-page, arrow-drop-down, -up, arrow-back, -forward, -upward, -downward, more-vert, more-horiz, home, person, group, settings, mail, notifications, favorite, favorite-border, star, star-border, share, bookmark, folder, description, image, inbox, drafts, send, calendar, schedule, cloud-upload, download, upload, attach-file, content-copy, filter-list, sort, dashboard, bar-chart, local-shipping, directions-car, place, phone, link, open-in-new, visibility, visibility-off, format-bold, -italic, -underlined, format-align-left, -center, -right, -justify, logout, light-mode, dark-mode, trending-up, trending-down, print, save, refresh, lock, payment, build, speed, route, ev-station.
- Calendar: write only `<div data-ui="date-calendar" data-month="2026-11" data-selected="2026-11-18"></div>`. ui.js draws the days.

## Composition
- Layout: `stack` for a column or row, `grid` for columns. Both take a gap of none, xs, sm, md, lg or xl. `container` centres a page.
- One contained button per view. Other actions are outlined or text. In a dialog or card footer, actions are text buttons, right-aligned.
- Type is `typography` with a `data-variant`. Page titles are h4 or h5 at most on a working screen; h1 to h3 are for marketing pages.
- Elevation means something: cards 1, app bars 4, menus 8, drawers 16, dialogs 24. Don't raise a surface to decorate it.
- Lists fill their surface edge to edge; put padding on what's inside them, not around them.
- Status in a table is a `chip` with `data-size="small"`. Figures get `data-align="right"` on their cell.
- Overlays: `<dialog>` for dialog, modal and drawer, opened by `data-dialog-open="<id>"`. Menus and popovers use the native `popover` attribute with `popovertarget` on the button.

## Tokens
Use only the custom properties from `tokens.css`. They cover colour roles (`--color-*`), MUI's action layers (`--action-*`), charts (`--chart-1` to `-5`), type (`--text-*`, `--leading-*`, `--tracking-*`), space (`--space-*`), controls (`--control-*`), radius, elevation (`--shadow-1` to `-24`) and motion.
- `--color-primary` is a fill; its text is `--color-on-primary`; `-dark` is its hover. Secondary, success, warning, danger and info work the same way.
- `--color-text-muted` is MUI's text.secondary. `--color-border` is its divider.
- A raised surface in dark mode also needs its overlay: `background-image: var(--paper-8)` with `box-shadow: var(--shadow-8)`.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep page spacing on the `--space-*` scale: multiples of 8px, with 4px for tight gaps.

## Files
- `system/tokens.css`: the tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: the behaviour listed above.
- `system/fonts/`: Roboto, already loaded by `ui.css`. Don't add a font link.
- `blocks/`: a hero, a feature grid, pricing, sign-in and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
