# Chalk Keynote

## World
Slides for a talk: a deep green board, chalk-white type at billboard size, one idea per slide, one warm yellow for emphasis. Made to be read from the back row.

## Colour: drenched, dark
- `--color-bg` deep green fills every slide; `--color-surface` slightly lighter for quote or code panels.
- `--color-text` chalk white; `--color-accent` warm yellow for the one emphasised word or line on a slide.

## Type
- Schibsted Grotesk only. Slide titles at `--text-display` (152–160) weight 800 for statement slides, 72–96 for titled slides.
- Body text at 40/52 minimum; never more than ~30 words per slide.

## Layout
- 1920×1080 slides, one `<section>` each; 120px margins.
- Slide types: statement (one sentence), title + 3 points, big number + label, quote, diagram, section break.
- Chalk-like hand-drawn underlines and arrows in SVG (1 per slide at most).

## Components
- Slide: one idea, 1–2 lines of display text at `--text-display`, a footer row in `--text-sm` muted.
- Diagram: boxes and arrows in 3px `--color-text` lines, labels in the sans at `--text-lg`.
- Highlight: chalk-yellow underline or circle drawn in SVG behind one word.
- Numbers: huge (240px) with a small label.
- Footer: talk title and slide number in small muted text.

## Signature
A statement slide: one sentence in huge chalk type with the key word in yellow and a hand-drawn underline.

## Rules
- Say one thing per slide in a short sentence (not a wall of bullets).
- Draw the picture with chalk lines (not clip art or stock photos).
- Leave the board dark green and flat (not gradients); the talk title appears in the footer only.
- Lint allows: highlighter

## Motion
Slide-to-slide: none or a quick fade. Builds reveal one point at a time.
