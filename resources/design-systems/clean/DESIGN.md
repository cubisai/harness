# Clean

## 1. Visual theme and atmosphere
Neutral, calm, quietly confident. White and near-white surfaces, one blue for action, generous whitespace. Content leads; chrome recedes. Think a well-made SaaS settings page: nothing shouts, everything is easy to scan.

## 2. Color palette and roles
Use the `--color-*` tokens; light and dark come from `prefers-color-scheme`.
- `bg` page, `surface` cards and panels, `surface-2` wells, hover fills, table stripes.
- `text` body and headings; `text-muted` secondary text, captions, placeholders.
- `border` hairlines (1px) between regions and around inputs.
- `primary` the one action color: primary buttons, links, selected states. `on-primary` text on it.
- `accent` sparing secondary highlight (badges, chart second series).
- `success`, `warning`, `danger` status only, never decoration. `focus` the focus ring.
One primary button per view. Color is never the only signal: pair it with an icon or label.

## 3. Typography rules
- `--font-sans` for everything; `--font-mono` for code and IDs.
- Scale: `text-sm` (14/20) secondary, `text-md` (16/24) body, `text-lg` (20/28) card titles, `text-xl` (24/32) section, `text-2xl` (32/40) page title, `text-3xl` (48/56) hero only.
- Weights: 400 body, 500 labels and buttons, 700 headings. Sentence case everywhere.
- Body measure ≤ `--measure` (68ch).

## 4. Component stylings
- **Buttons**: height 40 (44 on touch), padding 0 16, `radius-md`, `text-sm` 500. Primary = `primary` fill; secondary = `surface` fill + `border`; ghost = text only, `surface-2` on hover. Disabled = 40% opacity, no hover.
- **Inputs**: height 40, padding 0 12, `border`, `radius-md`, label above in `text-sm` 500, help/error text below in `text-sm`. Focus = 2px `focus` ring with 2px offset.
- **Cards**: `surface`, 1px `border`, `radius-lg`, padding 24. No shadow at rest; `shadow-2` only when lifted (menus, popovers).
- **Tables**: 48px rows, `border` row dividers, header in `text-sm` 500 `text-muted`, numbers right-aligned with `tabular-nums`.
- **Nav**: top bar 64px or sidebar 240px; active item = `surface-2` fill + `text`, others `text-muted`.
- **Badges**: height 24, padding 0 8, `radius-full`, `text-xs` 500, tinted background.

## 5. Layout principles
- 8pt spacing only (`--space-*`). Related items 8–16 apart, groups 24–32, sections 64–96.
- Content max `--content-max` (1200), centered, side gutters 24 (16 on mobile).
- 12-column grid with 24 gutters on desktop; align everything to it.
- Left-align text; center only short hero lines.

## 6. Depth and elevation
Flat by default. Separation comes from `border` and `surface` changes, not shadow. `shadow-1` for sticky bars, `shadow-2` for dropdowns and popovers, `shadow-3` for dialogs (with a 40% black scrim).

## 7. Do's and don'ts
- Do keep one primary action per view; make the next step obvious.
- Do show empty, loading (skeletons), and error states.
- Don't use more than one accent hue on a screen.
- Don't use pure black text on white or gradients on buttons.
- Don't center long paragraphs or justify text.

## 8. Responsive behavior
- Breakpoints: 390 (mobile), 768 (tablet), 1024, 1440 (desktop).
- Below 768: single column, sidebar becomes a bottom bar or menu sheet, tables become stacked cards, targets ≥ 44.
- Type steps down one size for `text-2xl`+ below 768.

## 9. Agent prompt guide
"Clean system: white surfaces, `--color-primary` blue for the single main action, 1px `--color-border` hairlines instead of shadows, `--font-sans`, 16/24 body, 8pt spacing from `--space-*`, `--radius-md` controls and `--radius-lg` cards, generous whitespace."
