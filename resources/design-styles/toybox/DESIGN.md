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
- Button: 56px, `--radius-full`, 3px darker bottom edge (`--shadow-1`) that presses down.
- Card: `--color-surface`, `--radius-lg`, 2px `--color-border`, padding `--space-6`.
- Badge: round sticker, white outline, rotated a few degrees.

## Signature
A progress path (stepping stones or a winding road in SVG) showing where the learner is, with a sticker on the current step.

## Rules
- Make it easy to hit and read: big targets, text at 18px or more (not small text or thin hairlines).
- Write warmly and plainly (not sarcasm).
- Keep the bright cream page; light is the default and the dark pair only follows the device setting.
- Draw characters and shapes in SVG (not corporate stock layouts).

## Motion
Bouncy but short: buttons squash on press (scale 0.96), stickers pop in with a small overshoot; nothing loops.
