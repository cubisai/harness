# Paper Planner

## World
Productivity like a good paper notebook: dot-grid paper, ink blue, highlighter yellow marks for what matters, monospace dates. Calm, tactile, focused.

## Colour: restrained
- `--color-bg` paper with a dot grid (radial-gradient dots every 24px at 10% ink).
- `--color-surface` white pages, `--color-primary` ink blue for actions and checkmarks.
- `--color-accent` highlighter yellow, used as a marker swipe behind text (40% height), never as text colour.

## Type
- Hanken Grotesk for UI and notes at 16/24; titles 28–40 weight 600.
- `--font-mono` Martian Mono for dates, times and counts at 12–14.

## Layout
- A day or week view: a left column of dates, the page as the main area.
- Task rows with hand-drawn-feeling checkboxes (SVG), strike-through when done.
- Sidebar for lists/projects; content max 1200.

## Components
- Checkbox: square with a slightly irregular SVG tick in ink blue.
- Buttons: `--radius-sm`, ink fill; quick-add input at the top of each list.
- Tags: small mono labels with a highlighter swipe.

## Signature
Today's top three tasks marked with a highlighter swipe and a hand-drawn circle around the most important one.

## Refuses
Gamified confetti, neon, heavy shadows, dashboards full of charts, emoji icons.

## Motion
Checking a task draws the tick (200ms) and strikes the text through; nothing else animates.
