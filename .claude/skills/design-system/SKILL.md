---
name: design-system
description: Use before changing anything under src/renderer/** in this repo (CSS, components, layout, copy). Routes to CubiQ's design contract, token reference and quality checklist, and to the checks that must pass.
---

# CubiQ design system (router)

This skill holds no design rules. It tells you what to read and what to run; the rules live in the docs below, so they can't drift.

## Read first

1. `docs/design/README.md`: read order, highlights, do and avoid.
2. `DESIGN.md`: the contract. Find the section for the surface you're changing (§7) and the pre-ship list (§9).
3. `docs/design/tokens.md`: pick tokens from here. Never write a colour or font-size literal in a component.
4. `docs/design/quality-checklist.md`: what is enforced, what needs judgment, and the 9-item review checklist.

## While you work

- Changing a token value, or adding one? Use the `token-change` skill instead.
- New state or component pattern? Reuse what an existing component does first, and note it for `components.md`.
- Keep behaviour and IPC unchanged unless the task is about them.

## Before you call it done

```bash
bun run design:check   # stable codes; errors fail CI
bun run typecheck
bun run test
```

Then walk the review checklist in `docs/design/quality-checklist.md`, with evidence per item. Anything visual you can't measure is `needs-human-look`, not "looks right".
