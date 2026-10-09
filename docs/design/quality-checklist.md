# UI quality checklist

How a UI change is judged. Rules marked **[checked]** are enforced by `bun run design:check` (code in brackets) and fail CI. Rules marked **[guidance]** need judgment: a reviewer checks them and records evidence. The rules themselves live in `DESIGN.md`; this file only says how each one is verified.

## Rules

### Tokens and literals
- **[checked]** `design/literal-color`: no hex, rgb or hsl colour outside `app.css` `:root` token declarations. Existing offenders are listed in `scripts/design-allowlist.json`, which may only shrink.
- **[checked]** `design/token-missing`: every `var(--x)` without a fallback resolves to a declared token or a JS-written variable.
- **[checked]** `design/token-stale`: `docs/design/tokens.md` matches `app.css` byte for byte (after line-ending normalisation).
- **[checked]** `design/token-collision` (warning): no token declared twice in one block, no two token names that differ only by case or dashes.
- **[checked]** `design/theme-drift` (warning): the system-dark and forced-dark blocks agree.
- **[checked]** `design/doc-value` (warning): `DESIGN.md` and the hand-written docs here carry no colour values; they point at `tokens.md`.

### Type
- **[checked]** `design/type-offscale`: every px font size is on the scale (DESIGN.md §3).
- **[guidance]** Weights 400/500/600 only; mono and tabular numbers for counts, times and diff stats.

### Surfaces, elevation, motion
- **[guidance]** Flat surfaces; the float shadow only on overlays; no inset shadows (DESIGN.md §5).
- **[guidance]** Motion uses the documented durations and easing, and honours reduced motion (DESIGN.md §6).

### States
- **[guidance]** Every interactive control has hover, focus-visible, active and disabled states; selectable ones have a selected state.
- **[guidance]** Every async action shows loading where it can take time, and a visible error with a way to retry. Nothing fails silently.
- **[guidance]** Every list or panel has an empty state that says what to do next.

### Accessibility and keyboard
- **[guidance]** Every control is reachable by keyboard with a visible `--focus` ring; no stray Tab stops inside composite widgets.
- **[guidance]** Escape closes the topmost overlay and returns focus to its trigger.
- **[guidance]** Tablists, listboxes and menus follow their ARIA pattern (roles, `aria-selected`/`aria-pressed`, arrow keys).
- **[guidance]** Icon-only buttons have an accessible name.

### Layout
- **[guidance]** No horizontal scroll at 900px wide with the panel open; text ellipsizes or wraps in its own box.

### Skills and docs
- **[checked]** `design/skill-invalid`, `design/skill-ref-unknown`: design skills have valid frontmatter, stay under 500 lines, and cite only docs that exist.
- **[checked]** `design/doc-structure`: `docs/design/README.md` keeps its four guarded headings.

## Review checklist

A reviewer (or the human checkpoint) fills in one verdict per item: `pass`, `fail` (with the defect) or `needs-human-look` (what to look at, and why the evidence can't settle it). Text-only agents never write "looks right": visual items they cannot measure are `needs-human-look`.

1. **Scope**: the change touches only the surfaces it claims to; behaviour and IPC are unchanged unless that was the point.
2. **Tokens**: `design:check` passes; no allowlist entries were added.
3. **Themes**: light, dark and system each checked (computed colours or screenshots).
4. **States**: each state in the component's matrix is shown or reached, including loading, empty and error.
5. **Keyboard**: Tab order, focus ring, Escape and arrow keys verified (a11y snapshot as evidence).
6. **Narrow window**: 900px with the panel open, no horizontal scroll, no clipped controls.
7. **Reduced motion**: no animation with reduced motion on (the running beam holds still).
8. **Platforms**: nothing macOS-only; Windows chrome insets and the opaque sidebar still work.
9. **Real app**: driven and screenshotted in the running app, not only the preview.
