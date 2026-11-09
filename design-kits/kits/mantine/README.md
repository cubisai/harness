# Mantine

This is an unofficial kit that follows Mantine's look, component set and prop names. It is not affiliated with or endorsed by Mantine, and every file here is written from scratch with no source copied.

Parts are `data-ui` attributes on plain HTML, configured with `data-*` props, so the markup reads like the React components without React. `components.json` records the matching `@mantine/core` import for each part, so a page can be handed to a Mantine project part by part. That import is handoff information only: this kit loads no packages and has no build step.

`tokens.css` holds the colour roles for light and dark, `ui.css` holds every part, and `ui.js` runs tabs, dialogs and the select's option list. `blocks/` has a hero, a feature grid, pricing, sign-in and a dashboard, and `DESIGN.md` sets the rules. Files under `system/` are shared, so leave them alone.

The icons are drawn for this kit in an outline style; they are not Tabler icons. The font is Mantine's default system stack, so nothing is bundled.
