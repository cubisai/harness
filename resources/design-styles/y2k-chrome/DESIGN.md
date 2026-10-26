# Y2K Chrome

## World
The turn-of-the-millennium future, redrawn flat: MP3 players, mini-disc sleeves, clear plastic. For drops, music, fashion and launch pages that want to feel fun and a little shiny without fake 3D.

## Colour: two inks on lilac-white
- `--color-bg` lilac-white with white `--color-surface` planes; `--color-primary` violet for actions and the main shape; `--color-accent` hot pink for one highlight per view.
- Pink text uses `--color-accent-text`; `--color-accent` is for fills, stickers and the chrome edge.
- Dark is a deep violet-black where the same planes glow faintly at the edge.

## Type
- `--font-display` Michroma: wide, one weight; headlines `--text-3xl` to `--text-display`, short (2–5 words), never paragraphs. Small labels in Michroma 12/16 with `--tracking-label`.
- `--font-sans` Chivo 16/24 for everything readable, weight 400 / 700.
- Numbers (prices, track times, counts) in Chivo with `--numeric-data`.

## Layout
- Big rounded planes (`--radius-lg`) overlapping slightly on a loose grid; one plane per idea.
- Capsules and circles for controls; rectangles with large radii for content.
- Leave real negative space around the hero object; one product or cover image as the focus.

## Components
- Plane: `--color-surface`, `--radius-lg`, `--shadow-1` (the chrome edge: 1px white top highlight, 1px violet bottom edge), padding `--space-8`.
- Button: 48px capsule (`--radius-full`), padding 0 `--space-6`; primary violet fill; secondary `--color-surface` with `--shadow-1`.
- Sticker: a pink circle or capsule, 28–40px, `--color-on-accent` label, rotated −6° at most, one per view.
- Track/list row: 52px, index, title, time right in `--numeric-data`, hover `--color-surface-3`.
- Chip: 32px capsule, `--color-accent-soft` when selected.

## Signature
The hard chrome edge: every raised plane has a 1px white top highlight and a 1px violet bottom edge, so it looks moulded without blur or gradients.

## Rules
- Draw chrome with flat 1px edges (not glassmorphism blur, gradient chrome or lens flares).
- Keep Michroma to short headlines and labels (not paragraphs or buttons with long text).
- Use pink once per view, as a sticker or highlight (not as a second accent everywhere).
- Make the hero a real object: a cover, product or player (not abstract blobs).

## Motion
Springy but quick: planes rise 4px on hover in 160ms; stickers pop in at 220ms with a slight overshoot. Respect reduced motion.
