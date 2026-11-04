# Ant Design

This is an unofficial kit that follows Ant Design's look, component set and prop names. It is not affiliated with or endorsed by the Ant Design team, and every file here is written from scratch with no source copied.

Parts are `data-ui` attributes on plain HTML, configured with `data-*` props, so the markup reads like the React components without React. `components.json` records the matching `antd` import for each part, for handing off to a real project.

`tokens.css` holds the colour roles for light and dark, with the values Ant's own light and dark algorithms give. `ui.css` holds every part. `ui.js` runs the tabs, dialogs, select, cascader, date and time pickers, calendar, tree, transfer, sliders, rate, colour picker, table sorting, pagination, carousel, splitter, tour and notices. `blocks/` has five page sections, and `themes/` has seven of Ant's preset colours as the primary.

The icons are drawn for this kit in an Ant style; they are not the Ant Design Icons set. Text uses the system font stack, as the library does, so the kit ships no fonts.
