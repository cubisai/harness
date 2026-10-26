# Sports Poster

## World
Match-day energy: condensed type at huge sizes, diagonal cuts, team red and navy, numbers that mean something (scores, times, distances). For sport, fitness and events.

## Colour: committed
- `--color-bg` stark white, `--color-surface-2` concrete grey bands, `--color-text` navy.
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
- Button: 52px, angled ends (clip-path) or square, red fill, uppercase label with `--tracking-label`.
- Stat block: number at display size with `--numeric-data`, a short label, a unit.
- Countdown: four digit blocks (days, hours, minutes, seconds), `--color-text` fill, `--color-bg` digits.

## Signature
A hero split by a diagonal: a duotone athlete photo or bold shape on one side, the event name and date in giant condensed type on the other.

## Rules
- Shout with scale: condensed display type huge, tight crops, hard edges.
- Use red and navy at full strength (not soft pastels or hairline elegance).
- Keep blocks square and solid (not rounded friendly UI or glass).
- Lay out like a fixture poster: one hero, then the schedule (not generic feature-card grids).

## Motion
Fast and punchy: one diagonal wipe on load (300ms), numbers tick up once. No floating elements.
