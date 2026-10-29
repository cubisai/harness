# Terminal

## World
A tool developers keep open beside their shell: deploy logs, job runs, API keys, CLI docs. It reads like good terminal output, structured, quiet and exact, without pretending to be a terminal window.

## Colour: restrained
- Light is a white field with `--color-surface` insets; dark is near-black with a faint green cast. Both are real; neither is a novelty.
- `--color-primary` prompt green is the one action colour and the "ok/live" signal. `--color-accent` amber is for one highlighted thing (a pending step, a changed line), never decoration.
- Status words carry colour; panels do not.

## Type
- `--font-display` is Geist Mono: page titles at `--text-3xl`–`--text-display`, weight 600, `--tracking-display`. Section titles are Geist Mono 15/24 weight 600.
- `--font-sans` Geist 15/24 for UI and prose; `--font-mono` for commands, IDs, paths, durations and every figure (`--numeric-data`).
- Log lines 13/20 mono. Never set running prose in mono.

## Layout
- App: 48px top bar, 240px left rail, content in a single column up to `--content-max`; docs pages hold prose at `--measure`.
- Density over air: 8px rhythm inside panels, 32–48px between sections.
- Logs and run steps are full-width rows, not cards.

## Components
- Button: 36px compact / 44px default, `--radius-sm`, padding 0 `--space-4`; primary green fill with `--color-on-primary`; secondary 1px `--color-border-strong`, transparent.
- Command block: `--color-surface` inset, 1px `--color-border`, `--radius-md`, a `$` prompt in `--color-primary`, a copy button 32px at top right.
- Log row: 28px, timestamp mono `--color-text-muted`, level as a 6px square pip, message mono; the failing line gets `--color-danger-soft`.
- Step list: 40px rows with a status pip, name, duration right-aligned in mono.
- Key/value table: label column `--text-sm` muted, value mono; hairline rows.

## Signature
The prompt rule: a line that starts with a green `$` or `>` glyph and runs as a 1px `--color-border-strong` rule to the edge, used to open each section the way a command opens its output.

## Rules
- Show real output: commands, paths, durations and exit codes with plausible values (not `0x0000` or `ACTIVE_SYNC` filler).
- Keep panels flat with 1px borders and `--color-surface` insets (not glow text, scanlines or fake window chrome).
- Use mono for data and commands only, and Geist for sentences.
- One green action per view; amber marks at most one thing.

## Motion
Instant. New log lines append without animation; a running step's pip pulses at 1s; copy confirms with a 120ms check swap.
