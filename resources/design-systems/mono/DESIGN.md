# Mono

## 1. Visual theme and atmosphere
Black, white and one gray ramp. Monospace headings, square corners, hairline rules, no decoration. Precise and technical, like a well-typeset terminal or a Swiss poster: developer tools, docs, changelogs, portfolios.

## 2. Color palette and roles
Use the `--color-*` tokens; light and dark come from `prefers-color-scheme`.
- `bg` page, `surface` code blocks and panels, `surface-2` hover and selected rows.
- `text` everything important; `text-muted` meta, line numbers, captions.
- `border` 1px rules and outlines; this system is drawn with lines.
- `primary` is `text` itself: primary buttons are solid black (white in dark). `on-primary` text on it.
- `accent` mid-gray for secondary emphasis.
- `success`, `warning`, `danger` are the only hues allowed, and only for status.

## 3. Typography rules
- `--font-display` (mono) for headings, nav, buttons, labels, numbers; `--font-sans` for paragraphs; `--font-mono` for code.
- Scale: `text-xs` (12/16) meta, `text-sm` (14/20) UI, `text-md` (16/24) body, `text-xl` (24/32) section, `text-3xl` (48/56) hero.
- Weights: 400 and 700 only. Headings may be lowercase; labels uppercase `text-xs` with 0.08em tracking.
- Prefix markers are welcome: `##`, `→`, `[ ]`, `01`.

## 4. Component stylings
- **Buttons**: height 40 (44 touch), padding 0 16, `radius-sm` (0), mono `text-sm`. Primary = solid `primary`; secondary = 1px `text` outline; hover inverts.
- **Inputs**: height 40, 1px `border`, square, mono placeholder in `text-muted`, focus = 2px `focus` outline offset 2.
- **Cards / panels**: 1px `border`, square, padding 24, no shadow; a header row separated by a rule.
- **Code blocks**: `surface`, 1px `border`, padding 16, `text-sm` mono, line numbers in `text-muted`.
- **Lists / tables**: rules between rows, 40 rows, mono numbers right-aligned.
- **Nav**: 56 tall top bar, mono links, active = underline 2px.
- **Tags**: `[tag]` style text or 1px outline, square, `text-xs` uppercase.

## 5. Layout principles
- 8pt spacing only (`--space-*`); strict grid: 12 columns, 24 gutters, everything snaps.
- Content max 1200; text columns ≤ 68ch.
- Visible structure: rules separate regions, alignment does the rest.
- Asymmetry is fine (labels in a narrow left column, content right).

## 6. Depth and elevation
None. `shadow-1` is `none`; `shadow-2` is a 1px outline; `shadow-3` only for dialogs, which also get a 1px `text` border. Layers are shown by borders and inversion.

## 7. Do's and don'ts
- Do let type and alignment carry the design; use inversion (black block, white text) for emphasis.
- Do use ASCII-ish details sparingly (`→`, `—`, `[x]`).
- Don't add colors beyond status, gradients, rounded corners or soft shadows.
- Don't set long paragraphs in monospace.
- Don't mix more than two type sizes in one component.

## 8. Responsive behavior
- Breakpoints 390, 768, 1024, 1440.
- Below 768: single column, left label column moves above its content, nav collapses to a `menu` text button opening a full-screen list.
- Hero drops from 48/56 to 32/40.

## 9. Agent prompt guide
"Mono system: black/white with one gray ramp, `--font-display` monospace headings and labels, `--font-sans` paragraphs, square corners, 1px `--color-border` rules instead of shadows, solid black primary buttons that invert on hover, strict 12-column grid, 8pt spacing, status colors only."
