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
- Menu item: full-width row, pixel label, value on the right for settings.
- Buttons: square-cornered, 2px border, a 2px inner highlight on top for a 'cartridge' feel.
- Progress: segmented bars (blocks), not smooth bars.

## Signature
A title screen with the game's name in large pixel type over a simple parallax of SVG shapes (stars, tiles), and a blinking "Press Enter" line.

## Refuses
Web-site chrome (top nav, footer links), stock gradients, glassmorphism, emoji, generic card grids.

## Motion
Selection moves instantly with a 2-frame flash; the "Press Enter" blink is the one looping animation. Respect reduced motion.
