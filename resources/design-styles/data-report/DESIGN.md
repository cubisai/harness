# Data Report

## World
Slides for numbers: white, charcoal and one orange for the series that matters. Charts are the hero; every title is the takeaway, not the topic.

## Colour: restrained
- `--color-bg` white, `--color-text` charcoal, greys from `--color-text-muted` and `--color-border` for context series.
- `--color-primary` orange only for the highlighted series, the key number and the takeaway marker.

## Type
- Archivo: takeaway titles 56–64 weight 700 ("Revenue grew 18% on repeat buyers"), body 28/40, chart labels 20.
- Numbers in tabular figures; units smaller than the number.

## Layout
- 1920×1080, one `<section>` per slide, 96px margins, a title band then the chart area.
- Slide types: KPI (3 numbers max), chart + takeaway, table (max 6 rows), comparison, next steps.
- Source line bottom-left in muted text.

## Components
- Charts in inline SVG: direct labels on lines instead of legends; gridlines in `--color-border`; only the highlighted series in orange.
- KPI block: number at 120, label, delta with an arrow drawn in SVG.
- Tables: hairline rows, right-aligned numbers.

## Signature
A chart slide where the orange series is labelled directly at its end point with the number, and everything else is grey.

## Refuses
Pie charts with many slices, 3D charts, rainbow palettes, decorative icons, titles that only name the topic.

## Motion
None; builds may reveal the highlighted series last.
