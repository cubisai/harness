# Clean Inset

## World
A calm workspace for a product that does work for you: a soft grey frame with the navigation, and the work itself on one white sheet inset into it with a large radius. Pages read like documents, not dashboards; everything has room and nothing shouts.

## Colour: restrained
- `--color-bg` the grey frame (sidebar and outer margin), `--color-surface` the inset sheet and cards, `--color-surface-2` hover rows and wells, `--color-surface-3` the selected nav row.
- `--color-primary` near-black: one solid button per view (Copy, Accept all, Save as report).
- `--color-accent` blue for links, selected chips (on `--color-accent-soft`) and the first data series.
- Status as small soft pills and coloured deltas (`+12.5%`), never as filled panels.

## Type
- Public Sans for UI (`--font-sans`, `--font-display`): 14/20 body and controls, 13/20 meta, page titles 32–40 weight 700 with `--tracking-display`, a 16/24 muted lede under them.
- `--font-serif` (Literata) only for long reading: notes, drafts and documents, 17/28 at `--measure`.
- `--font-mono` (Geist Mono) for tool names, keys and code in small grey pills.
- Sentence case; section labels 12px muted, not uppercase.

## Layout
- Inset shell: the frame on `--color-bg` with a 240px sidebar (workspace switcher, search with ⌘K, nav with 16px icons, collapsible groups), and the content sheet inset 8px from the window edges with `--radius-xl` and a 1px `--color-border`.
- Inside the sheet: a breadcrumb row, then a page title, a lede, and the content in one column at `--content-max`; a right rail (320px) only for details or approvals.
- Generous: 48px above page titles, 24px between blocks, cards in one row share a height.

## Components
- Button: 36px (44px touch area), `--radius-md`; primary near-black fill; secondary white with 1px `--color-border`; pill-shaped ghost toggles for Preview / Code.
- Card: `--color-surface`, 1px `--color-border`, `--radius-lg`, padding `--space-4`; a small tag pill top left, a count or status top right, the preview, then title and one line of muted description.
- Pill: 24px, `--radius-full`, 1px border, 12px text; selected = `--color-accent-soft` with `--color-accent-text`.
- List row: 32px, 16px icon, label, a muted count or shortcut on the right; hover `--color-surface-2`.
- Stat: caption 12 muted, figure 24 weight 600 with `--numeric-data`, delta 12 in success or danger, an optional tiny bar spark.
- Chart: 1.5px lines in accent, pink-red and violet tints, no area fill, muted axis labels, the legend as plain text under it.
- Input: 40px, white, 1px `--color-border-strong`, `--radius-md`, focus ring 2px `--color-focus`.

## Signature
The inset sheet: one white surface with a big radius floating on the grey frame, so the app reads as a single calm document; small proof of work inside it (steps with timings, tool names in mono pills, a diff with soft red and green marks).

## Rules
- One white sheet per screen on the grey frame (not a grid of floating cards on white).
- Separate with hairlines and space (not shadows, gradients or glass).
- Keep colour for meaning: links, selection, deltas, one series per colour (not tinted section backgrounds).
- Write it like a document: a real title and a one-line lede on every page (not a dashboard of unlabeled tiles).

## Motion
140–200ms ease-out on hover, menus and the sidebar collapse; a working state uses one small spinner or a shimmer on the active row. Nothing else moves.
