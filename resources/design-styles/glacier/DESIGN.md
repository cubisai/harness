# Glacier

## World
A B2B product site that doesn't look like every other one: icy white-blue air, deep ink type, one large real product surface instead of a grid of feature cards. Crisp and confident.

## Colour: restrained
- `--color-bg` icy white-blue, `--color-surface` white for the product frame, `--color-surface-2` pale blue bands.
- `--color-primary` deep ink for the main action; `--color-accent` clear blue for links, highlights and the one live detail in the product shot.

## Type
- `--font-display` Bricolage Grotesque for headlines (56–88) at weight 700, tracking -0.03em.
- `--font-sans` Onest for body and UI at 16/24.
- `--font-mono` for code snippets and API names.

## Layout
- Hero: headline left (columns 1–6), a large product surface built in HTML (not an image) that bleeds off the right edge.
- Features explained by zooming into parts of that product (callouts on the same UI), not by icon cards.
- One proof section: a few real customer names set as text and a single quote.

## Components
- Buttons: `--radius-md`, ink fill; secondary is text with an underline.
- Product frame: white, `--radius-lg`, `--shadow-3`, a thin `--color-border`.
- Pricing: a comparison table, not three floating cards.

## Signature
The product UI in the hero is live-ish: one element in it (a status, a counter, a chart line) updates every few seconds.

## Refuses
Three-column icon feature grids, gradient blobs, purple-pink AI gradients, hero metric rows, eyebrow labels.

## Motion
One: the product frame rises 16px and fades in on load; the live detail in it updates quietly.
