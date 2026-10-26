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
- Button: 44px (52 in the hero), `--radius-md`, ink fill, padding 0 `--space-6`; secondary is text with an underline.
- Product frame: `--color-surface`, `--radius-lg`, `--shadow-3`, 1px `--color-border`.
- Tag: 24px, `--radius-full`, `--color-accent-soft` with `--color-accent-text`.
- Pricing: a comparison table, not three floating cards.

## Signature
The product UI in the hero is live-ish: one element in it (a status, a counter, a chart line) updates every few seconds.

## Rules
- Explain features by zooming into the product frame with callouts (not three-column icon grids).
- Keep the field icy and flat; the one colour is the clear blue (not gradient blobs or purple-pink AI gradients).
- Prove with named customers and one quote (not hero metric rows).
- Start sections with the headline itself (not eyebrow labels).

## Motion
One: the product frame rises 16px and fades in on load; the live detail in it updates quietly.
