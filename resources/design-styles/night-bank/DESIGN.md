# Night Bank

## World
A mobile money app: a deep navy hero card with the balance, a white sheet sliding over it with everything else. Confident about the one number that matters; quiet about the rest.

## Colour: restrained
- `--color-bg` soft grey-blue, `--color-surface` white sheet, `--color-primary` navy for the hero card and primary buttons.
- `--color-accent` green for incoming money and positive deltas; `--color-danger` for outgoing only when it needs attention (otherwise outgoing is plain text with a minus sign).

## Type
- Onest throughout. Balance at 40–48 weight 600 in tabular figures; section titles 18 weight 600; body 16/24.
- `--font-mono` for card numbers (masked) and references.

## Layout
- 390×844 mobile screen, safe areas, 16px gutters.
- Top: navy card with greeting, balance and a hide/show toggle. Below: a white sheet with rounded top corners (`--radius-lg`) holding quick actions (4 round buttons) and the activity list.
- Bottom tab bar: Home, Cards, Payments, Profile.

## Components
- Button: 52px, `--radius-md`, navy fill, full width at the bottom of a flow.
- Quick action: 56px round button with an SVG icon and a label below.
- Transaction row: 64px; logo circle, name, category and time; amount right-aligned with `--numeric-data` and a sign.
- Tag: 24px, `--radius-full`, `--color-*-soft` fill.

## Signature
The white sheet overlapping the navy card, with the balance large on navy and a thin green line showing this month's change.

## Rules
- Show the balance and the next action first; keep the rest of the dashboard calm (not cluttered).
- Sign every amount and name its direction (not colour alone).
- Keep cards flat on the cool field (not gradient credit cards or crypto neon).
- Give every control at least 44px (52 for primary actions).

## Motion
The sheet slides up 24px on open (250ms); numbers do not count up.
