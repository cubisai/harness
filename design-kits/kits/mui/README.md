# MUI

This is an unofficial kit that follows Material UI's look, component set and prop names. It is not affiliated with or endorsed by MUI, and every file here is written from scratch with no source copied.

Parts are `data-ui` attributes on plain HTML, configured with `data-*` props, so the markup reads like the React components without React. `components.json` records the matching `@mui/material`, `@mui/lab` or `@mui/x-*` import for each part, so a page can be handed to a Material UI project and mapped part by part. That import is handoff information only: this kit loads no packages and has no build step.

`tokens.css` holds the colour roles for light and dark, `ui.css` holds every part, and `ui.js` runs the ripple, tabs, dialogs, select, autocomplete, sliders, rating, toggles, tree view, calendar, grid sorting and transfer list. `blocks/` starts a hero, a feature grid, pricing, sign-in and a dashboard, and `DESIGN.md` sets the rules. Files under `system/` are shared, so leave them alone.

The icons are drawn for this kit in a Material style; they are not the Material Icons set.

The fonts in `fonts/` are Roboto, by The Roboto Project Authors, included unchanged under the SIL Open Font License (`fonts/OFL.md`). The license covers those font files only.
