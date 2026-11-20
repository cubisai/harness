# Building and checking an app

The loop: look at the data, build, preview, check, propose.

1. **Look at the data.** `creator_inspect` topic `installed` lists the connectors. `creator_connector_test { server }` lists a connector's tools (read-only or not, inputs); `creator_connector_test { server, tool, args }` runs one read-only tool and returns the result's shape and a sample. Write the app against that shape, not a guess. If the default query is empty, try another permitted filter or period for representative rows before choosing table columns or chart fields. Never create production records just to populate a preview. If the connector the user means isn't installed, propose it first (kind `connector`).
2. **Build.** `creator_app_preview { name, template? }` creates or opens the draft and shows it to the user where it will open (a modal, floating widget, dock or panel; a page draft previews in the modal); it reloads by itself each time you save a file. Edit with your file tools. Keep changes small and save often; the user watches it change.
3. **Check.** `creator_app_check { name }` renders the draft off screen with real read-only data and returns:
   - `errors`: console errors and warnings, uncaught exceptions.
   - `calls`: each bridge call with `ok` / `error` / `not-run` (data-changing calls are never run by the check) and its time.
   - `empty`: true when the page shows almost nothing (no text, image, svg or canvas).
   - `text`: the start of the page's visible text, `size`, `timedOut`, and a screenshot at the placement's size (900x700 for a modal or page) when the model takes images.
   - `ok`: no errors, no failed calls, not empty, not timed out.
   Fix everything it reports and check again. Check the dark theme too (`scheme: "dark"`) when the app draws its own colours.
   A passing `ok` proves the render works, not that its values are correct. Compare visible metrics with the actual connector response, including numeric zero. Verify the meaning of restriction/visibility flags from that connector's schema; test unrestricted and restricted cases, plus missing or invalid values, in isolated fixtures. Do not turn unavailable values into fabricated zeroes or display restricted amounts.
4. **Propose.** `creator_propose { kind: "app", name, scope: "global" }` stages the draft's files as they are now for the user's review. Apps always install globally (sidebar → Apps, in every project). The card lists the files and the connector tools the app can use (read, or can change data). Re-proposing an installed app's name shows **Update** with what changed per file. Edits after proposing need a new proposal.

Then say in one or two lines what the app shows and where it is (sidebar → Apps). Don't claim it is installed until the card says so.

Apps with tools also have their `cubiq.onTool` registration checked in `toolEntry` (or `entry`), without executing a handler. A card specimen uses `card: "name", cardData: "<JSON>"` and renders its declared entry at 680px wide. Both checks refuse writes. Read `plugin-tools` / `chat-card`; render checks alone do not prove agent-callable behaviour.
