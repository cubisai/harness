# App format

A CubiQ app is a folder of plain HTML, CSS and JS plus an `app.json`. No bundler, no npm, no build step: what you write is what runs. It opens in the right panel's App tab, inside a sandboxed frame with no network.

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

- `name`: lowercase letters, digits, `-`; must equal the folder name.
- `title` (1-60 chars), `description` (1-300 chars): shown in the sidebar and on the review card.
- `icon`: a lucide name. Known: activity, chart-bar, chart-line, chart-pie, box, calendar, clock, gauge, kanban, layout-dashboard, list, map, notebook, package, shopping-cart, table, users, wallet. Others show a grid.
- `entry`: the page the frame opens (default `index.html`).
- `grants`: every connector tool the app may call, per server (exact names, no wildcards; at most 8 servers, 32 tools each). Calls to anything else fail. Ask for the fewest tools that do the job.
- `cacheSec` (0-3600): identical read-only calls within this many seconds reuse the last result. Use it for dashboards.

No other fields are allowed.

## Files

- Text only: `.html .css .js .mjs .json .svg .md .txt`. At most 64 files, 512 KB each, 2 MB total. Dot files and symlinks are refused.
- Load scripts and styles by relative path (`<script src="app.js">`). Inline `<script>` and `<style>` work too.
- Nothing from the network loads: no CDN scripts, fonts, images or `fetch`. Draw charts with inline SVG or canvas.

## Look

- Use CubiQ's theme variables so the app matches light and dark: `--cq-bg`, `--cq-bg-subtle`, `--cq-bg-chip`, `--cq-bg-hover`, `--cq-text`, `--cq-text-secondary`, `--cq-text-tertiary`, `--cq-hairline`, `--cq-hairline-strong`, `--cq-primary`, `--cq-on-primary`, `--cq-focus`, `--cq-success`, `--cq-danger`, `--cq-warning`, `--cq-signal-fill`, `--cq-signal-ink`, `--cq-add-bg`, `--cq-del-bg`. No hard-coded colours.
- The base font is set for you (13px system UI). Keep it compact: the panel is often 400-600 px wide. Use `font-variant-numeric: tabular-nums` for numbers.
- Always show a state: loading, empty ("No orders in this period."), and an error with a retry button.

## Templates

`creator_app_preview` with `template: "dashboard"` seeds a stat row, a bar chart and a table over one connector call. Only its `load()` knows the connector: change the server, tool and mapping, and update `grants` in app.json.

## Managing installed apps

Library → Apps opens, disables or uninstalls apps. Disabling keeps saved data; uninstalling removes it but keeps connectors. **Edit with Creator** copies the installed files into a new Creator thread's draft and opens its preview. Edit only that draft, preview and check it, then propose the same name: the user reviews an **Update** card before the installed files are replaced. Nothing installs or runs a model turn automatically when Edit is clicked.
