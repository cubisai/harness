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
- Button: 44px, `--radius-sm`, ink fill, padding 0 `--space-4`; a quick-add input at the top of each list.
- Checkbox: 24px square in a 44px row, slightly irregular SVG tick in ink blue.
- Tag: 24px, mono `--text-xs`, a highlighter swipe in `--color-accent-soft`.

## Signature
Today's top three tasks marked with a highlighter swipe and a hand-drawn circle around the most important one.

## Rules
- Make it feel written: ruled rows, ink ticks, highlighter swipes.
- Reward progress quietly with a strike-through and a count (not confetti).
- Keep pages flat on paper (not neon or heavy shadows); draw icons as line SVG (not emoji).
- Prefer lists and a week grid (not dashboards full of charts).
- Lint allows: highlighter, grid-background, repeating-stripes

## Motion
Checking a task draws the tick (200ms) and strikes the text through; nothing else animates.
