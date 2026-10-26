# Wayfinding

## World
Signage for complex public places: stations, airports, hospitals, campuses, and the apps that get people through them. Every element answers "where, which line, how long" before anything else.

## Colour: functional
- White field, near-black type. `--color-primary` route blue for the main line and actions; `--color-accent` signal yellow as a fill only (bands, tabs, the "now" marker) with `--color-on-accent` black type on it.
- Yellow is never text on white; use `--color-accent-text` if accent-coloured text is needed.
- Additional line colours are allowed for real routes, each as a solid square tab with a contrasting label, never as tints of the page.

## Type
- Overpass for everything; display and route numbers at weight 800, `--tracking-display`, tight leading. Labels weight 700 at `--text-sm`, sentence case.
- Times, platforms, gates and distances in `--font-mono` (Overpass Mono) with `--numeric-data`, sized as large as the destination.
- Hierarchy: destination > time > platform > everything else.

## Layout
- Bands, not cards: content is stacked full-width bands separated by 2px rules or a coloured band.
- A strong left edge: tabs and numbers sit in a fixed 56–72px column, text starts on one line after it.
- Mobile: one journey per screen, the next departure at the top in display size.

## Components
- Line tab: square, 32px (list) / 48px (header), `--radius-sm`, line colour fill, route number weight 800 centred.
- Departure row: 56px, tab, destination 18/24 weight 700, time right-aligned mono 20/28; delayed time in `--color-danger` with the old time struck through.
- Platform band: full width, 48px, `--color-accent` fill, black label left and platform number right.
- Button: 48px, `--radius-sm`, primary blue fill; secondary 2px `--color-text` border.
- Status: 24px pill in the `--color-*-soft` fill with an icon and a word (On time, Delayed, Cancelled).

## Signature
A full-width platform band with the route number in a square tab at its left edge, used as the only section divider on the page.

## Rules
- Put the destination and time first and largest (not marketing copy above them).
- Use square tabs and straight bands (not rounded map pins, skeuomorphic signs or drop shadows).
- Pair every colour with a word or number, so colour is never the only signal.
- Keep arrows and pictograms simple and from `system/icons.svg` (not emoji).

## Motion
Departure times tick over with a 160ms vertical flip; the "now" marker slides along a route line at 220ms. Nothing loops.
