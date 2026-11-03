# shadcn/ui

This is an unofficial kit that follows shadcn/ui's look, component set and prop names. It is not affiliated with or endorsed by shadcn/ui, and every file here is written from scratch with no source copied.

Parts are `data-ui` attributes on plain HTML, configured with `data-*` props, so the markup reads like the React components without React. `components.json` records the matching `@/components/ui/*` import for each part, with the file and the component name, so a page can be handed to a shadcn/ui project and mapped part by part. That import is handoff information only: this kit loads no packages and has no build step.

`tokens.css` holds the zinc colour roles for light and dark, `ui.css` holds every part, and `ui.js` is only needed for tabs and dialogs. `blocks/` starts a hero, a feature grid, pricing, login and a dashboard, and `DESIGN.md` sets the rules. Files under `system/` are shared, so leave them alone.
