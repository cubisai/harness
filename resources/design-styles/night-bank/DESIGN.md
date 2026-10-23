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
- Quick action: 56px round button with an SVG icon and a label below.
- Transaction row: merchant initial or logo circle, name, category and time, amount right-aligned.
- Buttons: `--radius-md`, navy, 52px tall.

## Signature
The white sheet overlapping the navy card, with the balance large on navy and a thin green line showing this month's change.

## Refuses
Crypto neon, gradient credit cards, cluttered dashboards, colour-only amounts, tiny tap targets.

## Motion
The sheet slides up 24px on open (250ms); numbers do not count up.
