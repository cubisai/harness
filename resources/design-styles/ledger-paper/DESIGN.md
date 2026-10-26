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
- Button: 44px, `--radius-sm`, navy fill, padding 0 `--space-6`; secondary 1px navy outline.
- Balance: label above in `--text-sm`, amount in the display serif at 48–64 with `--numeric-data`.
- Table: 44px rows, hairline rules, amounts right-aligned with `--numeric-data`.
- Badge: 24px, `--radius-sm`, `--color-*-soft` fill, sentence case.
- Balance block: label above in `--text-sm`, amount in the display serif at 48–64.

## Signature
A statement header with a ruled line pattern behind the balance and a brass underline under the period.

## Rules
- Show money like a ledger: ruled rows, right-aligned figures, signed amounts with a word (not colour alone).
- Keep surfaces paper-flat (not gradient cards or glowing charts).
- Use gold sparingly for the one figure that matters (not crypto neon).
- Illustrate with figures and tables (not playful illustrations).

## Motion
Subtle: numbers count up once on first load (400ms); rows expand smoothly for details.
