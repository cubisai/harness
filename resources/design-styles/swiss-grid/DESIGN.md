# Swiss Grid

## World
International Typographic Style: objective, rational, confident. The grid is visible in the result; type does the work; one red marks what matters.

## Colour: restrained
- White `--color-bg`, black `--color-text`, `--color-primary` red used for one thing per view (the key action, a rule, a number).
- `--color-border` is black: rules are 1px or 2px solid black lines, used to divide, never decorative boxes.

## Type
- `--font-display` and `--font-sans` are both Schibsted Grotesk. Headlines at `--text-display`, weight 800, tracking -0.04em, flush left, ragged right.
- Hierarchy from size and weight jumps (16 → 32 → 112), not colour.
- Numbers in tabular figures; captions at `--text-sm` weight 500.

## Layout
- A strict 12-column grid with 24px gutters; every block starts on a column line. Asymmetric: content in columns 1–7, captions or numbers in 9–12.
- Generous top margins above headings (2× the space below).
- Horizontal rules span the full grid to separate sections.

## Components
- Button: 44px, square, black fill, or red for the single primary; text label only.
- Ruled block: 2px `--color-text` top rule, padding-top `--space-4`; no box.
- Nav link: plain text in a row; the active one red or with a 2px underline.
- Lists and tables over cards. If a card is unavoidable it is a ruled block, not a floating box.
- Navigation: plain text links in a row, the active one in red or underlined 2px.

## Signature
A giant number or word set at display size that bleeds to the grid edge, paired with a small precise caption.

## Rules
- Align everything to the 12-column grid and a flush-left edge (not centred layouts).
- Use lists and tables with rules (not cards with shadows or rounded corners).
- Use one accent: red (not a second accent or gradients).
- Let type carry meaning (not decorative icons).

## Motion
Almost none: instant state changes, a 120ms underline grow on links.
