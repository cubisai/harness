# Memphis Pop

## World
1980s Memphis Group: squiggles, confetti, terrazzo and bold geometric shapes in pink, teal and yellow, framed by black outlines. Loud on purpose, witty, a little absurd.

## Colour: full palette
- `--color-bg` warm cream; fields of `--color-accent` pink, teal (success token) and sunny yellow (`--color-surface-2`).
- `--color-text` and `--color-border` are deep ink; outlines are 2–3px ink.
- `--color-primary` ink: buttons are ink with cream text.

## Type
- `--font-display` Unbounded, wide and rounded, at 64–96, weight 700.
- `--font-sans` Hanken Grotesk for body at 16/24.

## Layout
- Sections as coloured panels with inline-SVG pattern overlays (squiggles, dots, triangles) at the edges, never under body text.
- Shapes (circles, half-circles, zigzags) placed off-grid around headlines.
- Asymmetric, collage-like compositions; one tilted element per section.

## Components
- Button: 48px, `--radius-md`, ink fill, 2px ink border, hard offset `--shadow-2` that shifts on press.
- Card: cream fill, 2px ink outline, `--radius-lg`, padding `--space-6`, one coloured corner shape.
- Badge: an SVG star or burst, 48px, rotated a few degrees.

## Signature
A hero collage: the headline in Unbounded surrounded by Memphis shapes in all three colours, with one squiggle crossing the text block edge.

## Rules
- Commit to colour: pink, teal and yellow blocks with ink outlines.
- Cast hard offset shadows in ink (not soft blurred shadows or glass).
- Use the bold display weights (not thin type); draw shapes in SVG (not stock photos).

## Motion
Shapes wobble or rotate a few degrees on hover; one entrance where shapes pop in staggered (each 80ms). Respect reduced motion.
