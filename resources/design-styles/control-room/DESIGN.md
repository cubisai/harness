# Control Room

## World
An operations console watched for hours: graphite panels in a dim room, status that reads at a glance, density without clutter. Amber means attention; cyan means live.

## Colour: restrained, dark
- `--color-bg` graphite, `--color-surface` panels, `--color-surface-2` table headers and hovers.
- `--color-primary` amber for the main action and warnings; `--color-accent` cyan for live/active state and focus.
- Success, warning, danger only as status: dots, small pills, row tints at 10–15% opacity.

## Type
- Hanken Grotesk 14/20 for UI; dense views may drop to 13/20 for table cells.
- `--font-mono` (JetBrains Mono) only for numbers, IDs, timestamps and code, always with tabular figures.
- Panel titles 14 weight 600; one page title at 24.

## Layout
- Full-width app with a 56px top bar and a collapsible 220px left rail.
- A 12-column dashboard grid with 16px gaps; panels share heights per row.
- Tables are the main component: sticky header, 36–40px rows, zebra via `--color-surface-2`.

## Components
- Button: 44px, `--radius-sm`, padding 0 `--space-4`; primary amber with `--color-on-primary`, secondary 1px `--color-border-strong`.
- Panel: `--color-surface`, 1px `--color-border`, `--radius-md`, title row 44px with a time range and one overflow menu.
- Table row: 40px, hairline divider, numbers right-aligned in `--font-mono` with `--numeric-data`.
- Status pill: 24px, dot + label, `--color-*-soft` fill.
- Charts: thin lines (1.5px), no fills except a 10% area under the selected series; gridlines in `--color-border`.

## Signature
A live strip along the top: the few numbers that matter right now, each with a sparkline-free delta and a timestamp of the last update.

## Rules
- Rank the screen: the one number that needs action is largest; everything else is quiet.
- Draw charts as thin 1.5px lines with a 10% fill only under the selected series (not neon glows).
- Keep panels flat and opaque (not glass); controls are compact and square-ish (not rounded bubbles).
- Label every number with a unit and a time range (not hero metrics with gradients).

## Motion
Values update in place with a brief cyan flash on the changed cell (300ms). No page-load animation.
