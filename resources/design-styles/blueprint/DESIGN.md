# Blueprint

## World
An engineering drawing: blueprint blue field, white linework and a fine grid, monospace annotations with dimension lines. For developer tools, APIs, hardware and anything that wants to show how it works.

## Colour: drenched
- `--color-bg` blueprint blue is the surface; `--color-surface` and `--color-surface-2` are slightly lighter plates.
- `--color-text` white, `--color-text-muted` pale blue for annotations.
- `--color-accent` signal yellow for one callout per view and focus.
- `--color-primary` is white: primary buttons are white with blue text.

## Type
- `--font-display` and `--font-sans` Archivo; headlines 56–88 weight 700, tracking -0.02em.
- `--font-mono` Martian Mono for annotations, labels, code and specs at 12–14.

## Layout
- A visible grid: a CSS background of 1px lines every 24px at 12% white, heavier every 120px.
- Diagrams drawn in SVG with 1.5px white strokes, dimension lines with arrowheads and mono labels.
- Content blocks are framed plates with corner ticks instead of rounded cards.

## Components
- Button: 44px, `--radius-sm`, white fill with `--color-on-primary`, or a 1px white outline; mono label optional.
- Plate: `--color-surface`, 1px `--color-border`, `--radius-md`, padding `--space-6`, a mono caption top-left.
- Tag: 24px, 1px border, mono `--text-xs` caps with `--tracking-label`.
- Code blocks: darker plate, mono 14/22, line numbers in muted blue.
- Spec tables: two columns, mono values, hairline rows.

## Signature
An exploded diagram of the product (layers, modules or an API flow) drawn as linework with labelled callouts.

## Rules
- Draw diagrams as line drawings on the grid: 1px white lines, dimension marks, mono callouts.
- Keep photos as flat duotone in the blueprint blue (not glossy gradients).
- Keep panels square and plated (not rounded bubbly cards); icons are line SVG (not emoji).
- Use the yellow accent once per view, for the one thing to look at.

## Motion
Lines draw in with `stroke-dashoffset` once (600ms); callouts appear after. Respect reduced motion.
