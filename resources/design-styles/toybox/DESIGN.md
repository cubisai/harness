# Toybox

## World
Learning and play for kids and families: saturated primaries on warm cream, rounded friendly type, big soft shapes, sticker badges. Joyful, but the controls are clear enough for a seven-year-old and their parent.

## Colour: full palette
- `--color-bg` warm cream, `--color-surface` white cards, `--color-surface-2` sunny yellow wells.
- `--color-primary` royal blue for main actions; `--color-accent` raspberry for rewards and highlights; success green for correct answers.
- Each section may take one bright field colour, but text stays on light surfaces.

## Type
- Fredoka for everything: headlines 48–80 weight 600, body 18/28 (a touch bigger than usual for young readers).
- Short lines, short words; one idea per sentence.

## Layout
- Big rounded blocks (`--radius-lg`) and blob shapes (inline SVG) behind content.
- Tap targets 56px+; generous spacing; one main action per screen.
- Illustrations are simple SVG characters or objects made from basic shapes.

## Components
- Buttons: pill (`--radius-full`), 56px tall, with a 3px darker bottom edge (`--shadow-1`) that presses down on active.
- Cards: white, `--radius-lg`, chunky 2px border in `--color-border`.
- Badges: round stickers with a white outline and a slight rotation.

## Signature
A progress path (stepping stones or a winding road in SVG) showing where the learner is, with a sticker on the current step.

## Refuses
Small text, thin hairlines, dark mode, corporate stock layouts, sarcasm in copy, hard-to-hit targets.

## Motion
Bouncy but short: buttons squash on press (scale 0.96), stickers pop in with a small overshoot; nothing loops.
