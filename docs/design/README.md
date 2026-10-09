# CubiQ design docs: start here

Router for anyone (human or agent) about to touch `src/renderer/**`. It points at the docs that hold the rules; it holds none of its own. `bun run design:check` verifies this file's headings and every doc path the design skills cite.

## Read Order

1. [`DESIGN.md`](../../DESIGN.md): the contract. Principles, type, space, motion, per-surface rules, do and don't, the pre-ship checklist.
2. [`tokens.md`](tokens.md): every design token with its light and dark value. Generated from `src/renderer/src/styles/app.css`; never edit it by hand.
3. `components.md`: component inventory and state matrices (Phase 4, not written yet).
4. `patterns.md`: overlays, forms and validation, loading, empty and error states (Phase 5, not written yet).
5. [`quality-checklist.md`](quality-checklist.md): what `design:check` enforces, what stays judgment, and the review checklist.

Read 1 and 2 before any styling change. Read 5 before calling a UI change done.

## Design Highlights

- **Ink Flat**: flat surfaces, 1px hairlines and tint for structure. Only floating overlays get the float shadow.
- **Ink is primary, acid is a signal**: the acid green means "the agent is alive", nothing else.
- **Compact**: 13px body, 28px controls, 4px grid.
- **Nothing overflows**: every text-bearing flex or grid child gets `min-width: 0`.
- **One token source**: `app.css` is the only place a token value is written. Components use `var(--token)`.
- **Every state is designed**: hover, focus-visible, active, selected, disabled, loading, empty and error.

## Do

- Use existing tokens and components before adding new ones (`tokens.md`, then `components.md`).
- Change a token value in `app.css` only, then run `bun run design:docs` and `bun run design:check`.
- Give every async action a visible failure (`showNotice` or an inline error) and every list an empty state.
- Check light, dark and system themes, a 900px window, reduced motion, and keyboard-only use (DESIGN.md §9).
- Hand visual judgment to the human checkpoint. Report computed values and a11y snapshots as evidence, and mark anything unseen `needs-human-look`.

## Avoid

- Colour or font-size literals in components. `design:check` fails on new ones; the allowlist only shrinks.
- Shadows on static surfaces, inset shadows, glow, gradients, glass.
- Blue accents (the legacy picker blue), and acid text or lines on a light surface.
- Renaming tokens or IPC channels as part of a styling change.
- Restating rules from these docs inside skills or briefs. Point at the doc instead.
