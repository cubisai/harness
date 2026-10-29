# Riso Print

## World
A risograph zine: two spot inks on warm uncoated paper. Shapes overprint and slip out of register; type is set big and a little unruly. It feels made by hand in a small studio, friendly and loud at the same time.

## Colour: committed, two inks
- `--color-bg` paper; `--color-surface` lighter sheet for forms and tables.
- `--color-primary` (blue ink) and `--color-accent` (fluoro pink) are the two inks. Let one of them carry a whole section; overprint them with `mix-blend-mode: multiply` where shapes cross.
- Text is `--color-text` ink-violet, never pure black.

## Type
- `--font-display` (Bricolage Grotesque) for headlines at `--text-display`, weight 800, tight tracking (-0.03em), allowed to break onto 3–4 lines.
- `--font-sans` (Hanken Grotesk) for everything else, 16/24.
- `--font-mono` only for issue numbers, dates and prices.

## Layout
- A loose 12-column grid that headlines and shapes may break out of.
- Halftone or grain on large ink fields (a small inline SVG `feTurbulence` pattern at low opacity).
- Offset duplicate shapes 3–6px in the other ink to fake misregistration, on one or two elements, not everything.

## Components
- Button: 44px, `--radius-sm`, flat ink fill; secondary 2px ink outline.
- Card: paper sheet, 1px `--color-border`, no shadow; tilt one per view by 1–2deg at most.
- Badge: a stamped circle or tape strip in the accent ink, 48px.

## Signature
One hero where the headline sits over a big overprinted shape in both inks, slightly out of register.

## Rules
- Print in two inks with visible overlap and grain (not gradients or glass).
- Keep sheets flat on the paper (not soft drop shadows).
- Let one or two elements sit slightly off the grid on purpose (not stock-SaaS card grids).

## Motion
One: the hero shapes slide 4px into register on load. Hover on links shifts the underline colour between the two inks.
