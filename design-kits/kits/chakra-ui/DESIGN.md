# Chakra UI

## World
Chakra UI 3's default theme: neutral grey surfaces, 40px buttons, 4px radii, 14px body text, and a colour palette on every control. Solid colour fills are the palette's 600 shade, and the surface tints are its 50 to 200 shades. Dark mode swaps the neutrals and the palette shades; no markup changes.

## Using the kit
- Compose pages from the parts in `components.json`. Each part is a `data-ui` attribute on plain HTML. Sub-elements are `data-part`.
- Link `system/tokens.css` then `system/ui.css`. Add `system/ui.js` whenever the page uses tabs, dialogs, drawers, a calendar, a carousel, steppers, tags or a select.
- Props are `data-<prop>` attributes: `<button data-ui="button" data-variant="outline" data-size="sm">`. The first value listed is the default, so leave the attribute off for it. Names match Chakra: `variant`, `size`, `color-palette`.
- `data-color-palette="teal"` sets the palette for a part and everything inside it. Ten palettes: gray, red, orange, yellow, green, teal, blue, cyan, purple, pink.
- Icons: `<i data-ui="icon" data-name="search"></i>`, sized by their parent, drawn in the current colour.
- Calendar: write only `<div data-ui="calendar" data-month="2026-11" data-selected="2026-11-14"></div>`. `ui.js` draws the month.

## Composition
- Layout: `stack` for a column or row, `flex` and `wrap` for rows, `grid` for columns, `simple-grid` for fluid columns. Stack gap is 8px by default.
- One solid button per view. Other actions are outline, subtle, ghost or plain.
- Every form control sits in a `field` with a label. Helper text comes after the control.
- A card's parts: `header`, `content`, `footer`. The footer sits at the bottom of the card.
- Status is a `badge`, `tag` or `status`. Figures in a table get `data-align="end"`.
- Overlays: `<dialog>` for dialog and drawer, opened by `data-dialog-open="<id>"`. Menus, popovers, selects and hover cards use the native `popover` attribute with `popovertarget` on the trigger.

## Tokens
Use only the custom properties from `tokens.css`.
- `--cp-solid` is the palette fill and `--cp-contrast` its text. `--cp-fg` is palette text, `--cp-subtle` and `--cp-muted` are its tints, `--cp-emphasized` is hover, `--cp-border` is an outline, `--cp-focus-ring` is the focus ring.
- `--color-text`, `--color-text-muted` and `--color-text-subtle` are the three text greys. `--color-border` is the default border.
- `--hairline` is the ring on menus and cards: `box-shadow: 0 0 0 1px var(--hairline)`.
- `--ring-width` is the focus ring width, 2px, drawn 2px outside the control.

## Page CSS
Put page-specific CSS in the page. Tokens only, no literal colours or sizes. Keep page spacing on the `--space-*` scale.

## Files
- `system/tokens.css`: the tokens, light and dark, and the palettes.
- `system/ui.css`: every part, in the `cubiq-ui` layer so page CSS wins.
- `system/ui.js`: the behaviour listed above.
- `system/fonts/`: Inter, already loaded by `ui.css`. Don't add a font link.
- `blocks/`: a hero, a feature grid, pricing, sign-in and a dashboard.
- `components.json`: the parts, their props and snippets.

Never edit files under `system/`: they are shared by every page.
