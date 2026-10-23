# Sports Poster

## World
Match-day energy: condensed type at huge sizes, diagonal cuts, team red and navy, numbers that mean something (scores, times, distances). For sport, fitness and events.

## Colour: committed
- `--color-bg` off-white, `--color-text` navy.
- `--color-primary` team red carries big diagonal fields and the main action; navy (`--color-accent`) for the counter-field.
- Photography in duotone (navy + red) via CSS filters or SVG, when photos are used.

## Type
- `--font-display` Big Shoulders Display, uppercase allowed here for headlines only, 96–144, weight 800, tight leading.
- `--font-sans` Hanken Grotesk for body and UI at 16/24.
- Numbers huge and condensed: scores, countdowns, stats.

## Layout
- Diagonal section edges (`clip-path: polygon(...)`) at a consistent angle (about 6deg).
- Headlines overlap image edges; big numbers sit on the grid edge.
- Fixtures and results as tight tables with team names bold.

## Components
- Buttons: angled ends (clip-path) or square, red fill, bold uppercase label.
- Stat block: number at display size, a short label, a unit.
- Countdown: four large digits blocks for days, hours, minutes, seconds.

## Signature
A hero split by a diagonal: a duotone athlete photo or bold shape on one side, the event name and date in giant condensed type on the other.

## Refuses
Soft pastels, rounded friendly UI, hairline elegance, glass, generic feature-card grids.

## Motion
Fast and punchy: one diagonal wipe on load (300ms), numbers tick up once. No floating elements.
