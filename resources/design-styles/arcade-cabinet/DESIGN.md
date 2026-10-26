# Arcade Cabinet

## World
The game's own front end, not a website about it: a deep indigo night, pixel type, a chunky menu you drive with arrow keys, one glowing selection. Playful but readable.

## Colour: committed, dark
- `--color-bg` indigo night, `--color-surface` and `--color-surface-2` for panels and the selected row.
- `--color-primary` coin yellow for the selected item and primary action; `--color-accent` mint for highlights, health and focus.
- `--color-danger` for lives lost and destructive choices.

## Type
- `--font-display` Pixelify Sans for the title and menu items (24–88), never for paragraphs.
- `--font-sans` Onest for descriptions, settings and help text at 16/24.
- Numbers (scores, levels) in the pixel face with tabular alignment.

## Layout
- Centred stage at 16:9 for the main menu; a left menu column, a right preview panel.
- Big, keyboard-first menu items (56px rows); the selected row gets a solid yellow bar and a ▶-style pixel cursor drawn in SVG.
- Footer hints for controls (Enter, Esc, arrows) drawn as small key caps.

## Components
- Button: 48px tall, `--radius-sm`, 2px `--color-border-strong` border, padding 0 `--space-6`; pixel label in caps with `--tracking-label`.
- Panel: `--color-surface`, 2px `--color-border`, `--radius-md`, padding `--space-4`; no shadow.
- Status: 24px block chips, `--color-*-soft` fill, the matching status colour for the text.
- Menu item: full-width row, pixel label, value on the right for settings.
- Progress: segmented bars (blocks), not smooth bars.

## Signature
A title screen with the game's name in large pixel type over a simple parallax of SVG shapes (stars, tiles), and a blinking "Press Enter" line.

## Rules
- Build every screen as a game menu: a framed stage, full-width rows, the focused row inverted (not web chrome: top nav, footer links).
- Draw depth with 2px bevels and stepped blocks (not gradients or glass).
- Draw icons as pixel SVG on the 4px grid (not emoji).
- Show progress as segmented blocks that fill one at a time.

## Motion
Selection moves instantly with a 2-frame flash; the "Press Enter" blink is the one looping animation. Respect reduced motion.
