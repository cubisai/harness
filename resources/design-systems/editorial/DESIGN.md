# Editorial

## 1. Visual theme and atmosphere
A printed magazine on warm paper. Serif display type with real hierarchy, long comfortable measure, rust and ink accents. Unhurried and literate: built for reading, storytelling, essays, landing pages and decks.

## 2. Color palette and roles
Use the `--color-*` tokens; light and dark come from `prefers-color-scheme`.
- `bg` paper, `surface` pull-quote and sidebar panels, `surface-2` captions band, code wells.
- `text` ink; `text-muted` bylines, dates, captions.
- `border` thin rules between sections and columns.
- `primary` rust: links, the main call to action, drop caps, section numbers. `on-primary` text on it.
- `accent` ink blue: secondary links, footnote markers, a second chart series.
- `success`, `warning`, `danger` status only.

## 3. Typography rules
- `--font-display` (serif) for headlines, standfirsts and pull quotes; `--font-sans` for UI, labels, captions; `--font-mono` for code.
- Body is serif or sans by context: long-form articles use `--font-display` at `text-lg` (20/28); UI copy uses sans at `text-md` (16/24).
- Headlines: `text-4xl` (64/72) hero, `text-3xl` (48/56) article title, `text-2xl` (32/40) section. Tight tracking (-0.01em) on 48+.
- Kickers/eyebrows: sans `text-xs` 500, uppercase, letter-spacing 0.08em, `primary`.
- Measure 60–68ch. Paragraph spacing 24, no first-line indent on web.

## 4. Component stylings
- **Buttons**: height 44, padding 0 24, `radius-sm`, sans `text-sm` 500. Primary = `primary` fill; secondary = 1px `text` outline. Links underline with 1px offset 4.
- **Pull quote**: `font-display` `text-2xl` italic, 4px `primary` rule on the left, padding-left 24.
- **Cards (story tiles)**: no border; image (aspect 3:2) then kicker, headline (`text-xl` display), standfirst (`text-sm` muted). Rule above the grid.
- **Figure**: full-bleed or column-width image, caption below in sans `text-sm` muted.
- **Nav**: masthead 80 tall, centered wordmark in display face, section links in sans `text-sm`.
- **Inputs**: underline style (1px `border` bottom), 44 tall, label above in sans.

## 5. Layout principles
- 8pt spacing only (`--space-*`). Sections separated by 96 and a hairline rule.
- Asymmetric grids: 12 columns, text in 7–8 columns, notes or images in the remaining 4.
- Generous margins: side gutters 32 desktop, 24 tablet, 16 mobile.
- Hierarchy through size and space, not boxes.

## 6. Depth and elevation
Almost none. Paper is flat: separation comes from rules (`border`), whitespace and `surface` panels. `shadow-2` only for menus; `shadow-3` for dialogs.

## 7. Do's and don'ts
- Do let headlines be big and use real typographic contrast (64 vs 16).
- Do use real images or tasteful inline SVG placeholders with captions.
- Don't use rounded pill buttons, gradients or drop shadows on cards.
- Don't set long text in all caps or below 16px.
- Don't crowd: when in doubt add space, not a box.

## 8. Responsive behavior
- Breakpoints 390, 768, 1024, 1440.
- Below 768: single column, hero 48/56, article title 32/40, side notes move under the paragraph they belong to.
- Images go full width on mobile; captions stay below.

## 9. Agent prompt guide
"Editorial system: warm paper `--color-bg`, `--font-display` serif headlines with big size contrast, sans for UI and captions, rust `--color-primary` for links and the single call to action, hairline rules not boxes, 60–68ch measure, 8pt spacing, small radii, no shadows."
