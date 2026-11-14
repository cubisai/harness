# Chakra UI

This is an unofficial kit that follows Chakra UI's look, component set and prop names. It is not affiliated with or endorsed by Chakra, and every file here is written from scratch with no source copied.

Parts are `data-ui` attributes on plain HTML, configured with `data-*` props. `components.json` records the real `@chakra-ui/react` import for each part, for handoff only: this kit loads no packages and has no build step. The colour values come from Chakra's default theme; the font is Inter, which Chakra's theme names as its default, so text will not match the Chakra docs site exactly.

`tokens.css` holds the palettes and neutrals, `ui.css` holds every part, and `ui.js` runs tabs, dialogs, the calendar, carousel, steppers, select and tags. `blocks/` has a hero, a feature grid, pricing, sign-in and a dashboard. The fonts in `fonts/` are Inter, under the SIL Open Font License (`fonts/OFL.md`).
