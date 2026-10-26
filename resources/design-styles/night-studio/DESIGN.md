# Night Studio

## World
Music and creative tools after dark: aubergine rooms, coral and lilac light, wide display type, waveforms and grain. Warm, expressive, a little nocturnal.

## Colour: committed, dark
- `--color-bg` aubergine, `--color-surface` and `--color-surface-2` deeper plum panels.
- `--color-primary` coral for actions and the playhead; `--color-accent` lilac for selection, focus and secondary highlights.

## Type
- `--font-display` Unbounded at 64–96 weight 600, wide and round.
- `--font-sans` Onest for UI and body at 16/24.
- Track times and BPM in tabular figures.

## Layout
- Full-bleed sections with a subtle grain overlay (inline SVG noise at 6% opacity).
- Waveforms drawn as SVG bars; album or project art in square frames.
- Asymmetric hero: the display title large on the left, a player or waveform on the right.

## Components
- Button: 44px, `--radius-md`, coral fill with `--color-on-primary`; play/pause icon buttons round, 48px.
- Player bar: `--color-surface-2`, coral progress, lilac hover.
- Track row: 56px; number, title, artist, time in `--numeric-data`; the playing row tinted with `--color-accent-soft`.

## Signature
A big waveform across the hero that lights up in coral up to the playhead.

## Rules
- Set the mood with plum and coral on deep night (not pure black with neon green).
- Use artwork as the colour source: square covers, real titles and durations.
- Keep surfaces solid (glass only for the one floating player bar, not everywhere).
- Build with rows and covers (not generic SaaS cards or stock gradients).

## Motion
The waveform animates gently while playing; everything else is instant or 200ms. Respect reduced motion.
