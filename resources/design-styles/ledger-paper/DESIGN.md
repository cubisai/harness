# Ledger Paper

## World
Money handled with care: a well-kept ledger on ruled off-white paper, ink navy, a brass accent. Trustworthy and exact, warm rather than corporate.

## Colour: restrained
- `--color-bg` paper, `--color-surface` white for statements and forms.
- `--color-primary` ink navy for actions and headings; `--color-accent` brass for one highlight per view.
- Money colours: `--color-success` for incoming, `--color-danger` for outgoing, always with a + or − sign too.

## Type
- `--font-display` Young Serif for page titles and big balances (one or two per view).
- `--font-sans` Hanken Grotesk for UI at 16/24; amounts in `font-variant-numeric: tabular-nums` aligned right.
- `--font-mono` for account numbers and references only.

## Layout
- Ruled tables: hairline `--color-border` rows like ledger lines, generous 52px rows.
- Statements read top to bottom: period, balance, then transactions grouped by day.
- Content max 1200; forms in a single 560px column.

## Components
- Buttons: `--radius-sm`, navy fill; secondary is a navy outline.
- Balance block: label above in `--text-sm`, amount in the display serif at 48–64.
- Badges: small caps-free labels with a tinted background.

## Signature
A statement header with a ruled line pattern behind the balance and a brass underline under the period.

## Refuses
Gradient cards, glowing charts, crypto-style neon, playful illustrations, ambiguous colour-only signals.

## Motion
Subtle: numbers count up once on first load (400ms); rows expand smoothly for details.
