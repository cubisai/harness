# Foundation

Foundation is CubiQ's base design kit: plain HTML and CSS parts for layout, content, forms, navigation, data and feedback. It is written from scratch for the app, bundled with CubiQ, and copies no other library's source.

A page is composed from the parts listed in `components.json`, each marked with a `data-ui` attribute and configured with `data-*` props. The CSS uses only the custom properties in `system/tokens.css`, so the same markup works with any theme.

Themes work by swapping `tokens.css`. Every style in `resources/design-styles/` defines the same token names as `system/tokens.css`; link a style's tokens in its place and `ui.css` takes on that style's colours, type and spacing. No markup changes.

`DESIGN.md` explains the workflow, `blocks/` holds starting points for common page sections, and `system/` is shared by every page, so it is read-only.
