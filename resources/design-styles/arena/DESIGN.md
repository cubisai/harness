# Arena

## World
An after-hours broadcast package for esports and live competition: brackets, scoreboards, player cards, match pages and stream overlays. Dark by design: it lives on a stage screen.

## Colour: dark, two signals
- `--color-bg` near-black stage, `--color-surface` panels, `--color-surface-2` strips.
- `--color-primary` violet and `--color-accent` cyan double as the two team colours and the action/live signals; a real team's colour may replace one of them.
- `--color-danger` red is reserved for LIVE and eliminations. No neon glow: colour is flat fill.

## Type
- `--font-display` Chakra Petch 700, squared and technical: scores, team tags, headlines; scores at `--text-display` with `--numeric-data`.
- `--font-sans` Sora 15/24 for UI and copy; labels 12/16 weight 600 with `--tracking-label`.
- Player handles in Chakra Petch; real names in Sora, muted.

## Layout
- A 12-column broadcast grid; the scoreboard strip spans the full width at the top.
- Brackets read left to right with 2px connector lines in `--color-border-strong`; the winner's path in the team colour.
- Mobile: score strip sticky at the top, then timeline, then stats.

## Components
- Score strip: 64px, `--color-surface-2`, chamfered 12px corners (`clip-path`), team colour blocks 8px wide at each end, scores centred.
- Player card: `--color-surface`, `--radius-md`, portrait slot 4:5, handle 24/28 display, role and K/D/A in `--numeric-data`.
- Button: 44px, chamfered or `--radius-sm`, primary violet with `--color-on-primary`; secondary 1px `--color-border-strong`.
- Live badge: 24px, `--color-danger` fill, white dot + LIVE, the only uppercase pill.
- Stat bar: 8px track in `--color-surface-3`, team-colour fill, value at the end.

## Signature
The chamfered scoreboard strip: a full-width bar with cut corners and solid team-colour blocks at each end, used for every score or matchup.

## Rules
- Use flat team-colour fills and cut corners (not neon glow, glass panels or gradient orbs).
- Make the score or matchup the largest thing on screen.
- Show plausible match data: team tags, maps, rounds, times (not `PLAYER_01` placeholders).
- Keep one LIVE badge per view.

## Motion
Broadcast cuts: strips slide in 180ms from the side; score changes flip at 160ms with a short team-colour flash. No looping ambient motion.
