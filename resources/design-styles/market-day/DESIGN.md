# Market Day

## World
Food, cafes and markets: saffron and deep teal on warm cream, a soft display serif, hand-cut shapes and big photography slots. Generous, appetising, local.

## Colour: committed
- `--color-bg` warm cream; `--color-surface-2` saffron-tinted wells.
- `--color-primary` deep teal for actions and the menu headers; `--color-accent` saffron for highlights, prices and a section field.

## Type
- `--font-display` Young Serif for headings (40–88) and dish names.
- `--font-sans` Hanken Grotesk for body, menus and UI at 16/24.
- Prices aligned right in tabular figures; dietary marks as small letter badges (V, VG, GF).

## Layout
- Large photography slots (use SVG placeholders shaped like plates or blobs when there are no photos), text wrapping beside them.
- Menu sections as two-column lists with dotted leaders between dish and price.
- Hand-cut shapes: irregular blobs (inline SVG) behind images and headings.

## Components
- Button: 48px, `--radius-full`, teal fill, padding 0 `--space-6`; "Book a table" is the one primary.
- Image: `--radius-lg`, caption below in `--text-sm`; no frame.
- Tag: 28px, `--radius-full`, saffron `--color-accent-soft` with `--color-accent-text`.
- Cards: no heavy chrome; images with `--radius-lg` and a caption below.
- Opening hours as a clean table with today highlighted in saffron.

## Signature
A menu board section: the day's specials in large serif on a saffron field with hand-drawn underline strokes.

## Rules
- Lead with food and place: real dish names, prices, today's hours.
- Set body at 16px or larger (not tiny type).
- Keep the warm cream page; light is the default and the dark pair only follows the device setting.
- Lay out like a market board: photos and hand-set lists (not corporate SaaS layouts or icon grids).

## Motion
Warm and slow: images ease in (400ms); hover lifts a dish card slightly.
