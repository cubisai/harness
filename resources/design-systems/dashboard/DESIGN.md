# Dashboard

## 1. Visual theme and atmosphere
Dense, precise, data-first. A cool gray canvas with white panels, indigo for action, tabular numbers everywhere. Built for operators who scan dozens of values at once: admin consoles, analytics, monitoring.

## 2. Color palette and roles
Use the `--color-*` tokens; light and dark come from `prefers-color-scheme`.
- `bg` app canvas, `surface` panels and tables, `surface-2` header rows, hover, selected rows.
- `text` values and labels; `text-muted` units, axis labels, timestamps.
- `border` panel outlines and grid lines.
- `primary` indigo: primary buttons, active nav, selection, focus. `on-primary` text on it.
- `chart-1` … `chart-5` series colors, in that order; never reuse status colors for series.
- `success`, `warning`, `danger` deltas and status pills only (always with ▲/▼ or an icon).

## 3. Typography rules
- `--font-sans` with `font-variant-numeric: tabular-nums` on every number; `--font-mono` for IDs, hashes, code.
- Scale: `text-xs` (12/16) axis and meta, `text-sm` (14/20) default UI and tables, `text-md` (16/24) panel titles, `text-xl` (24/32) page title, `text-2xl` (32/40) KPI values.
- Weights: 400 values, 500 labels and column headers, 700 KPI numbers only.

## 4. Component stylings
- **KPI tile**: `surface`, 1px `border`, `radius-md`, padding 16; label `text-sm` muted, value `text-2xl` 700, delta pill below (`success`/`danger` tint + arrow), optional 32px sparkline.
- **Tables**: 40px rows (32 compact), `surface-2` sticky header, 1px row dividers, numbers right-aligned, row hover `surface-2`, selected row 2px `primary` left bar.
- **Charts**: inline SVG, 1px `border` gridlines, no 3D or gradients, legend top-left, direct labels where possible, axis text `text-xs` muted.
- **Buttons**: height 32 (dense) or 40, padding 0 12, `radius-sm`, `text-sm` 500. Icon buttons 32×32 with a 44 hit area on touch.
- **Filters bar**: 48 tall, segmented controls and selects in a row, gap 8.
- **Sidebar**: 240 wide, 36px items, section labels `text-xs` uppercase muted, active = `primary` text + `surface-2` fill.
- **Status pill**: height 20, padding 0 8, `radius-full`, `text-xs` 500, tint + dot.

## 5. Layout principles
- 8pt spacing only (`--space-*`); dense rhythm: 8 inside controls, 16 inside panels, 16–24 between panels.
- 12-column grid, 16 gutters; KPI row of 4 across, charts 6 or 8 columns, tables full width.
- Page header 64: title left, date range and primary action right.
- Align numbers on the decimal; keep units in muted text after the value.

## 6. Depth and elevation
Panels sit on `bg` with a 1px `border` and `shadow-1`. `shadow-2` for dropdowns and tooltips, `shadow-3` for dialogs and drawers. Tooltips are `text` on `surface` with a border, never black boxes.

## 7. Do's and don'ts
- Do show realistic data with believable variance, units and timestamps.
- Do design loading (skeleton rows), empty ("No events in this range"), and error panels.
- Don't use pie charts for more than 4 slices or dual y-axes.
- Don't color whole rows by status; use a pill.
- Don't let numbers jump: tabular figures, fixed column widths.

## 8. Responsive behavior
- Breakpoints 390, 768, 1024, 1440, 1920.
- Below 1024: sidebar collapses to icons (64), KPI row 2×2.
- Below 768: single column, tables scroll horizontally inside their panel (not the page) or become cards, filters move into a sheet.

## 9. Agent prompt guide
"Dashboard system: cool gray `--color-bg`, white `--color-surface` panels with 1px borders, indigo `--color-primary`, `--chart-1..5` series, tabular numbers, `text-sm` default, dense 8pt rhythm, KPI tiles + inline SVG charts + 40px table rows, every number with a unit and every delta with an arrow."
