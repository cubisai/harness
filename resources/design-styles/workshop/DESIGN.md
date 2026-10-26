# Workshop

## World
A workbench for makers and field technicians: repair guides, parts catalogues, job tickets, tool rental. Sturdy, labelled, a little loud where it matters, like a well-kept shop wall.

## Colour: grounded
- `--color-bg` is concrete grey and `--color-surface` lighter panels sit on it, the way parts sit on a bench.
- `--color-primary` safety orange for the one action and the active step. `--color-accent` oxide green for "in stock / done / fitted".
- No paper or kraft textures; the ground is a flat neutral.

## Type
- `--font-display` Alfa Slab One for page titles, part names on detail pages and big step numbers, never below `--text-xl`; it has one weight, so hierarchy comes from size.
- `--font-sans` Archivo for UI and text, 16/24; labels 12/16 weight 700 uppercase with `--tracking-label` (labels only, never sentences).
- Part numbers, torque, sizes and prices with `--numeric-data`.

## Layout
- A 12-column grid; a detail page puts the exploded view or photo in columns 1–7 and the spec table in 8–12.
- Step-by-step guides as numbered sections, one step per band, the number set big in the margin column.
- Catalogue grids vary: one large featured tile beside smaller ones, never rows of identical cards.

## Components
- Part label: 1px `--color-border-strong` box, `--radius-sm`, slab part number on top, name and size below; used on tiles and in diagrams.
- Button: 44px, `--radius-sm`, padding 0 `--space-6`; primary orange with `--color-on-primary`; secondary 2px `--color-text` border.
- Spec table: 40px rows, label left muted, value right with units; hairline `--color-border`.
- Step: a 64px slab numeral in the margin, title 20/28 weight 700, tools needed as a row of small part labels.
- Stock chip: 24px, `--color-success-soft` fill, dot and count.

## Signature
Every card or diagram carries a slab part-number label and a 1px exploded keyline that connects the label to the part it names.

## Rules
- Label things with real part numbers, sizes and units (not vague "Feature one" copy).
- Keep corners near square at 2–4px (not rounded product tiles or pill buttons).
- Use flat panels on the grey ground, with 1px keylines for structure (not paper textures, stitching or wood grain).
- Spend orange on one action per view.

## Motion
Mechanical and short: tabs and steps change in 160ms with a 4px slide; diagrams highlight the hovered part's keyline. No bounce.
