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
- Buttons: square, white fill or 1px white outline, mono label optional.
- Code blocks: darker plate, mono 14/22, line numbers in muted blue.
- Spec tables: two columns, mono values, hairline rows.

## Signature
An exploded diagram of the product (layers, modules or an API flow) drawn as linework with labelled callouts.

## Refuses
Photos with glossy gradients, rounded bubbly cards, emoji, purple-pink AI gradients.

## Motion
Lines draw in with `stroke-dashoffset` once (600ms); callouts appear after. Respect reduced motion.
