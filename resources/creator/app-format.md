# App format

A CubiQ app is a folder of plain HTML, CSS and JS plus an `app.json`. No bundler, no npm, no build step: what you write is what runs. It shows where its `placement` says (a centred modal, a floating widget, a full page, a strip above the composer, or a sidebar panel), inside a sandboxed frame with no network.

## Where you write it

Your draft folder is `<thread folder>/.cubiq/app-drafts/<name>/`. `creator_app_preview` returns the exact path (and can seed it from a template). Write files there with your normal file tools. Never write into an installed app folder (CubiQ's data folder); installs go through `creator_propose`, and apps always install globally, so prefer global connectors (a project-only connector works only in that project).

## app.json

```json
{
  "name": "sales-dashboard",
  "title": "Sales",
  "description": "Revenue, orders and top products for a chosen period.",
  "icon": "chart-bar",
  "entry": "index.html",
  "grants": [{ "server": "shop", "tools": ["sales_summary", "list_orders"] }],
  "cacheSec": 60
}
```

A floating widget adds:

```json
{
  "placement": "floating",
  "size": { "width": 260, "height": 150 },
  "style": "own"
}
```

- `name`: lowercase letters, digits, `-`; must equal the folder name.
- `title` (1-60 chars), `description` (1-300 chars): shown in the sidebar and on the review card.
- `icon`: a lucide name. Known: activity, chart-bar, chart-line, chart-pie, box, calendar, clock, gauge, kanban, layout-dashboard, list, map, notebook, package, shopping-cart, table, users, wallet. Others show a grid.
- `entry`: the page the frame opens (default `index.html`).
- `grants`: every connector tool the app may call, per server (exact names, no wildcards; at most 8 servers, 32 tools each). Calls to anything else fail. Ask for the fewest tools that do the job.
- `cacheSec` (0-3600): identical read-only calls within this many seconds reuse the last result. Use it for dashboards.
- `placement`, pick by how the user will use it:
  - `"modal"` (default): a centred window up to 900×700, opened from the sidebar. Dashboards, viewers, forms.
  - `"floating"`: a small widget that stays on screen, can be dragged and minimised to a chip in the top bar. Timers, counters, now-playing.
  - `"page"`: fills CubiQ's main area (under its header) when opened from the sidebar, until the user goes back to a thread. Workspaces: a kanban, a reader, an editor, a long list. Lay out for any width (about 600 to 1600 px).
  - `"dock"`: a short strip above the composer in every chat, as wide as the composer (about 680 px, narrower in a small window). One row: today's focus, a status line, quick actions.
  - `"panel"`: a block in the left sidebar above Apps (about 232 px wide), which the user can fold. Glanceable lists: next meetings, a queue, a mini chart.
  Enabled floating widgets, docks and panels show at start-up; the user can close one, and opening it from the sidebar brings it back.
- `size` (floating only): `{ "width": 160-480, "height": 80-600 }` in px, the frame below the widget's title strip. Default 280×200.
- `height` (dock or panel only): the frame's height in px. Dock 32-160 (default 48), panel 80-320 (default 160). The width is the host's: never assume a fixed one.
- `style`: `"cubiq"` (default: CubiQ's base font and background are set for you) or `"own"` (nothing is set and the frame is transparent: style the page yourself; the `--cq-*` variables still arrive).

No other fields are allowed.

## Files

- Text only: `.html .css .js .mjs .json .svg .md .txt`. At most 64 files, 512 KB each, 2 MB total. Dot files and symlinks are refused.
- Load scripts and styles by relative path (`<script src="app.js">`). Inline `<script>` and `<style>` work too.
- Nothing from the network loads: no CDN scripts, fonts, images or `fetch`. Draw charts with inline SVG or canvas.
- A `<form>` never submits in the sandbox (its submit event doesn't fire): handle a button's click and Enter in the inputs instead.

## Look

- Use CubiQ's theme variables so the app matches light and dark: `--cq-bg`, `--cq-bg-subtle`, `--cq-bg-chip`, `--cq-bg-hover`, `--cq-text`, `--cq-text-secondary`, `--cq-text-tertiary`, `--cq-hairline`, `--cq-hairline-strong`, `--cq-primary`, `--cq-on-primary`, `--cq-focus`, `--cq-success`, `--cq-danger`, `--cq-warning`, `--cq-signal-fill`, `--cq-signal-ink`, `--cq-add-bg`, `--cq-del-bg`. No hard-coded colours.
- With `style: "cubiq"` the base font is set for you (13px system UI). A modal is up to 900×700 and narrower in a small window; a floating widget is exactly its `size`: lay out for that. Use `font-variant-numeric: tabular-nums` for numbers.
- Always show a state: loading, empty ("No orders in this period."), and an error with a retry button.

## Templates

`creator_app_preview` with `template: "dashboard"` seeds a stat row, a bar chart and a table over one connector call. Only its `load()` knows the connector: change the server, tool and mapping, and update `grants` in app.json.

`template: "widget"` seeds a floating, own-style focus timer (no connector): state in `cubiq.store`, a countdown on the pill. Rename it and replace its content.

`template: "page"` seeds a full-page reading list (add, tick off, remove; empty and error states) kept in `cubiq.store`.

`template: "dock"` seeds a one-row, own-style "Today's focus" strip with a button that uses `cubiq.ask`.

## Managing installed apps

Library → Plugins opens, turns off or uninstalls apps; the sidebar's Apps rows open them. Disabling keeps saved data; uninstalling removes it but keeps connectors. **Edit with Creator** copies the installed files into a new Creator thread's draft and opens its preview. Edit only that draft, preview and check it, then propose the same name: the user reviews an **Update** card before the installed files are replaced. Nothing installs or runs a model turn automatically when Edit is clicked.
