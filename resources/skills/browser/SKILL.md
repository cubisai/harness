---
name: browser
description: Check a web page or the app you are building in the harness's browser pane - open a dev server or URL, read the page, click and type, read console errors and failed requests, take screenshots. Use it after changing UI code, to reproduce a bug a user sees in the page, or when a task says "check it in the browser".
---

# Browser

The harness has a browser pane the user can see. You drive it with these tools (an MCP prefix such as `mcp__cubiq__` may be in front of the names):

| Tool | Use |
| :--- | :--- |
| `browser_open` | Open a URL (`localhost:5173`, `https://…`), wait for load, get a snapshot. Optional `device`: `mobile`, `tablet`, `desktop`. |
| `browser_snapshot` | The page as text with element refs like `e3`. Cheaper than a screenshot; use it first. |
| `browser_click` / `browser_type` | Act on a ref from the latest snapshot. |
| `browser_logs` | Console errors and warnings, and failed network requests, since the page loaded. |
| `browser_eval` | Run JavaScript in the page. Asks the user first in Ask mode. |
| `browser_screenshot` | Save a PNG (the user sees it in the pane). Returns the image only when you ask for it. |

If a tool answers "Browser pane not open", ask the user to open it (the globe button in the header, or Ctrl/Cmd+Shift+B), then retry.

## Checking a UI change

1. Make sure the dev server runs. Look in `package.json` scripts for `dev`/`start`/`preview` and the port it prints. Start it in the background if it isn't running; don't block on it.
2. `browser_open` the page you changed. Read the snapshot: is the new element there, with the right text?
3. `browser_logs`: fix any new console error or failed request before calling the change done.
4. Interact the way a user would (`browser_click`, `browser_type`), then snapshot again to confirm the result.
5. For layout or visual changes, `browser_screenshot`, and try `device: "mobile"` when the page is meant to be responsive.

Refs go stale after the page changes: take a fresh snapshot before the next click.

## Without the pane

If the browser tools aren't offered at all, and `agent-browser` is on PATH, use it instead (`agent-browser open <url>`, `agent-browser snapshot`, `agent-browser click <ref>`). Otherwise say what you couldn't check, rather than claiming the UI works.
