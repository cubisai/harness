---
name: token-change
description: Use when adding, changing or removing a CubiQ design token (a CSS custom property in src/renderer/src/styles/app.css), e.g. a colour, radius, shadow or beam strength. Covers where to edit, what to regenerate and what to verify.
---

# Change a design token (router)

The rules for what a token means are in `DESIGN.md` and the values are in `docs/design/tokens.md`. This skill is the procedure only.

## Steps

1. Look the token up in `docs/design/tokens.md`: its layer, its light and dark values, and any alias that points at it.
2. Edit the value in `src/renderer/src/styles/app.css` only, in every theme that declares it. Never edit `docs/design/tokens.md`, and never copy the value into `DESIGN.md` or a component.
3. Don't rename a token. If a new one is truly needed, add it next to its layer and give it a value in each theme.
4. JS reads some tokens by name at runtime (search `getPropertyValue(` under `src/renderer`). If you touch one of those, check that consumer still gets a usable value.
5. Regenerate and verify:

```bash
bun run design:docs    # rewrites docs/design/tokens.md from app.css
bun run design:check   # must report 0 errors
bun run test
```

6. Commit `app.css` and the regenerated `docs/design/tokens.md` together.

## Verify the result

Compare computed values before and after in light, dark and system themes (read them in the running app, e.g. `getComputedStyle(document.documentElement).getPropertyValue("--token")`). Then walk the themes and reduced-motion items of the review checklist in `docs/design/quality-checklist.md`.
