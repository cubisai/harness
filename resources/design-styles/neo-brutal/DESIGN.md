# Neo Brutal

## World
Neo-brutalism with intent: flat white and signal yellow, thick black borders, hard offset shadows, heavy grotesque type. Honest, raw, fast. For indie tools, launches and anything that wants attitude.

## Colour: committed
- `--color-bg` white, `--color-surface-2` signal yellow for big fields and highlights.
- `--color-border` and `--color-text` black; `--color-accent` orange-red for one hot spot.
- `--color-primary` black: primary buttons are black with yellow text.

## Type
- Archivo at heavy weights (800–900) for headlines, 72–104, tight leading; body Archivo 16/24 weight 450.
- `--font-mono` for small labels, prices and code.

## Layout
- Visible structure: 2–3px black borders around every block, hard shadows (`--shadow-1`/`--shadow-2`) offset down-right.
- Blocks stack like stickers on a board; slight misalignment allowed.
- Big yellow highlight bars behind key words (a `linear-gradient` underline at 40% height).

## Components
- Button: 48px, square, 3px `--color-border-strong`, `--shadow-1`; on press the shadow goes and the button moves 4px.
- Card: `--color-surface`, 3px border, `--shadow-2`, square, padding `--space-6`.
- Input: 48px, 3px border, square; focus fills `--color-surface-2`.

## Signature
A hero where the headline sits in a bordered yellow block with a big hard shadow, next to a product screenshot in a black-bordered frame.

## Rules
- Make structure visible: thick borders, hard offset shadows, square corners (not soft shadows or rounded pills).
- Use flat saturated fills: yellow, orange, black and white (not gradients, glass or pastels).
- Shift on press instead of fading.
- Lint allows: hard-offset-shadow, highlighter

## Motion
Mechanical: press states shift by the shadow offset (80ms); no easing curves beyond linear-ish.
