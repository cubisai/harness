# Newsroom

## World
A serious digital newspaper or magazine: front pages, section fronts, live blogs, long reads and newsletters. Authority from typography and ranking, not decoration.

## Colour: ink and one red
- White `--color-bg`, black `--color-text`; `--color-primary` is black (subscribe, read, follow).
- `--color-accent` breaking red for live/breaking labels, the section name and one rule per page; red text uses `--color-accent-text`.
- Photos carry the colour; the UI stays ink.

## Type
- `--font-display` Source Serif 4 for headlines: lead story `--text-3xl`–`--text-display` weight 700, `--tracking-display`; secondary stories 20/28 weight 600.
- Article body in Source Serif 4 18/30 at `--measure`; `--font-sans` Public Sans for UI, bylines, captions and datelines (13–14px).
- Kicker (section or "Live") in Public Sans 12/16 weight 700 in `--color-accent-text`, sentence case, beside or above a story group, never on every headline.

## Layout
- A 12-column front: lead story spans 8 columns with its image, a ranked rail of 4 in the other 4; below, section rows of unequal stories (one big, two or three small).
- 1px rules between columns and stories; a 4px `--color-border-strong` rule opens each section.
- Article pages: one centred column at `--measure` with images breaking out to 10 columns.

## Components
- Story: headline, a one-line standfirst in muted serif, byline and time in Public Sans 13px; no card box.
- Section head: 4px black top rule, section name 20/28 Public Sans weight 800, a "More" text link right.
- Live blog entry: time in `--numeric-data` in a 72px margin column, 1px rule above, newest first.
- Button: 40px, `--radius-sm`, black fill / 1px black outline; text label only.
- Newsletter box: `--color-surface`, no radius, serif headline, one email field 44px with a button.

## Signature
The masthead and section rules: a heavy 4px black rule above every section name and a thin 1px rule under the masthead's date line, so the page is ordered by rules instead of boxes.

## Rules
- Rank stories by size: one lead, then clearly smaller ones (not grids of equal cards).
- Separate with rules and white space (not shadows, rounded cards or tinted panels).
- Use red only for breaking/live and one section accent per page.
- Give every story a real-sounding headline, byline and timestamp in one consistent "today".

## Motion
Almost none: link underlines thicken in 120ms; live entries fade in at 220ms. No parallax.
