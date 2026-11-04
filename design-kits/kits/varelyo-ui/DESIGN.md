# varelyo/ui

## World
The library's neutral brand: near-black ink on white, a 4px rhythm, 32px controls with 8px radii, system UI type with 600-weight labels, and soft shadows that appear only on raised surfaces. The brand is almost monochrome, so status is carried by containers, icons and text rather than hue. Dark mode swaps the same roles, so no markup changes. The `neutral` and `slate` themes are the library's own brands. The five accent themes (blue, green, violet, rose, orange) are this kit's own overrides, not the library's; each passes 4.5:1 for text on its accent.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` for tabs, dialogs, drawers and collapse toggles.
- Props are `data-<prop>` attributes with kebab-case names: `<button data-ui="button" data-variant="contained" data-size="sm">`. The first value listed is the default, so leave the attribute off for it. Button's default is `text`, as in the library.
- Icons: `<i data-ui="icon" data-name="search"></i>`, sized with `data-size` and drawn in the current text colour. Names are in `system/ui.css`: search, plus, check, close, chevron-down, arrow-right, mail, user, lock, calendar, bell, cart, settings, star, info, warning, error, menu, home, trash, edit, download, upload, more, eye, heart, truck, leaf, box, clock, pin, dashboard, and others.
- Menus and popovers use the native `popover` attribute with `popovertarget` on the button and `style="anchor-name:--id"`. Dialogs and drawers are `<dialog>` opened by `data-dialog-open="<id>"`.

## Composition
- Layout: `stack` for a column or row, `grid` for columns, `container` to cap width. Gaps use the `spacing` scale.
- One contained button per view. Other actions are outlined or text.
- Every form control sits in a `text-field` (or `form-control`) with an `input-label`. Helper and error text come after the control.
- A card's parts: `content` and `actions`. Actions sit at the foot of the card.
- Figures in a table get `data-align="end"` on their cell.

## Tokens
Use only the custom properties from `tokens.css`. Colour roles are `--color-*`: `--color-primary` is a fill and `--color-on-primary` its text. `--color-surface-2` and `--color-surface-3` are the muted wells. `--color-border-strong` is the input outline. Type is `--text-*` with `--leading-*`. Shadows are `--shadow-1` to `--shadow-3` and `--elevation-xs` to `--elevation-3xl`.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep page spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the tokens, light and dark.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: tabs, dialogs, drawers and collapse toggles.
- `blocks/`: hero, feature grid, pricing, login and dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
