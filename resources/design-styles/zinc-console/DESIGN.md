# Zinc Console

## World
A product people run their work from at night: near-black zinc, panels separated by hairlines rather than shadows, white type with grey for everything secondary. Nothing is decorated; craft shows in alignment, figures that line up and states that are all drawn.

## Colour: restrained, dark
- `--color-bg` the app frame, `--color-surface` panels, `--color-surface-2` the selected nav row, table headers and hover, `--color-surface-3` pressed.
- `--color-primary` is near-white: the one solid button per view (Export, Save, Accept). Secondary buttons are outlined.
- `--color-accent` blue for links, the selected segment's text, focus and one data series.
- Severity and status only as tint: a 24px icon chip in `--color-*-soft` with the matching colour, the figure itself in that colour, a 6px legend dot. Never a coloured panel.

## Type
- Geist for UI (`--font-sans`, `--font-display`): 14/20 body and controls, 13/20 table cells and meta, panel titles 14 weight 500, one page title at 24 weight 600 with a 14 muted subtitle under it.
- `--font-mono` (Geist Mono) for figures, IDs, keys, timestamps and code, with `--numeric-data`. Uppercase mono labels at 12px with `--tracking-label` for stat-card captions only.
- Sentence case everywhere else; no all-caps headings.

## Layout
- App shell: a 240px sidebar on `--color-bg` (workspace switcher on top, groups with 12px muted labels, 32px nav rows with a 16px icon and 2px between them, an inset card for setup or credits at the bottom), a 48px header with breadcrumb and a ⌘K search field, the content on `--color-bg`.
- Optional 28px status bar along the bottom: links, version, one helper action.
- Content max `--content-max`, 24px page padding, 16px gaps between panels, panels in one row share a height.

## Components
- Button: 36px (44px touch area), `--radius-md`, 0 `--space-3`, 14/20 weight 500; primary white fill; outline 1px `--color-border-strong`; ghost for toolbars. A leading 16px icon when it helps.
- Segmented control: a `--color-surface` track with 1px border; the active segment `--color-surface-3` with `--color-text`, the rest muted. Used for 24h / 7d / 30d.
- Stat card: `--color-surface`, 1px `--color-border`, `--radius-lg`, padding `--space-4`; mono caption, a 32px figure, an optional delta (`+12.5%` in success) and one quiet link at the bottom.
- Table: 40px rows, hairline dividers, right-aligned mono figures, a muted header row on `--color-surface-2`.
- Chart: 1.5px lines or a stacked area at 20% fill, gridlines in `--color-border`, mono axis labels, a dot legend top right.
- Chip: 24px pill, 1px border, 12px text, an optional 14px icon or logo.
- Input: 36px, `--color-surface`, 1px `--color-border-strong`, focus ring 2px `--color-focus` with 2px offset.

## Signature
The numbers carry the page: every figure in mono, coloured only by its meaning, with its unit and range in grey beside it; a segmented range control that every panel on the page obeys.

## Rules
- Separate with 1px hairlines and surface steps (not drop shadows, glows or gradients).
- Give each stat card a caption, a unit and a range; vary the cards by what they hold (not a row of identical icon tiles).
- Use colour for state only: severity, delta, the selected series (not for decoration or section backgrounds).
- Keep radii small and consistent: 8 on controls, 12 on panels (not pill-shaped panels).
- Empty values show an en dash in muted grey (not 0 pretending to be data).

## Motion
120–180ms ease-out on menus, popovers and hover; a figure that changes counts to its new value once. Nothing loops.
