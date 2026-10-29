# Atelier

## World
A fashion house: dove grey and bone, black, one oxblood. An italic Didone, asymmetric editorial layouts, images cropped with intent, lots of restraint. Luxury through confidence, not ornament.

## Colour: restrained
- `--color-bg` dove grey, `--color-surface` bone, `--color-text` black.
- `--color-accent` oxblood for one detail per view (a price, a mark, a hover).
- `--color-primary` black for the single action.

## Type
- `--font-display` Bodoni Moda at very large sizes (96–128), mixing roman and italic within a title.
- `--font-sans` Schibsted Grotesk for UI and copy at 14–16, letter-spacing 0.01em.
- Product names in the italic; prices in the sans with tabular figures.

## Layout
- Asymmetric: a tall image on columns 1–7, text placed low on columns 9–12; white space as a material.
- Images cropped tight on detail (a sleeve, a stitch) next to a full look.
- Collections as an editorial sequence, not a grid of identical tiles; vary image sizes.

## Components
- Button: 48px tall, `--radius-sm` (square), padding 0 `--space-8`, ink fill with `--color-on-primary`; secondary is text with a 1px underline.
- Input: 48px, 1px `--color-border-strong` bottom rule only, label above in `--text-sm`.
- Product tile: image at 4:5, name below in italic display, price in `--text-sm`; no frame, no border.
- Navigation: a few words, centred logo wordmark in the display face.

## Signature
A cover-like hero: one image, the collection name in giant italic Didone overlapping its edge.

## Rules
- Let the photograph carry the page: one image per view at full bleed or a strict 4:5 grid (not icon rows or busy UI).
- Mark sale and status with a short word in `--color-accent-text` (not badges or stickers).
- Keep every corner square and every surface flat (not rounded cards or gradients).
- Space generously: `--space-16` or more between sections.
- Lint allows: italic-serif-display

## Motion
Slow crossfades (500ms) between images; hover reveals a second image of the product. Nothing bounces.
