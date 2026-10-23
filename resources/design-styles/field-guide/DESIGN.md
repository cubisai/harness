# Field Guide

## World
A naturalist's field guide: moss, bark and sand on uncoated paper, topographic linework, careful labels. For outdoor brands, parks, travel and anything rooted in place.

## Colour: restrained, earthy
- `--color-bg` paper, `--color-surface` lighter sheets, `--color-surface-2` sand wells.
- `--color-primary` moss for actions and links; `--color-accent` rust for a single highlight (a trail, a date, a warning).

## Type
- `--font-display` Literata for headlines (48–84) and the italic for species names and quotes.
- `--font-sans` Archivo for labels, navigation and data at 14–16, weight 500.
- Captions in small caps feel; use `font-variant-caps: all-small-caps` sparingly for map labels only.

## Layout
- A reading column (max `--measure`) with a margin column for notes, coordinates and small figures.
- Topographic contour lines as a subtle SVG background in one hero or section divider.
- Sections numbered only if they are steps on a route.

## Components
- Buttons: `--radius-sm`, moss fill, or an outlined variant.
- Cards: specimen plates: an illustration or photo, a name in italic serif, a short label row (habitat, season).
- Maps and figures with thin 1px ink lines.

## Signature
A specimen plate layout: a large illustration with hairline callout leaders pointing to labelled parts.

## Refuses
Neon, glass, gradient blobs, tech-startup card grids, emoji icons.

## Motion
Slow and quiet: contour lines draw in once (800ms); images fade. Nothing bounces.
