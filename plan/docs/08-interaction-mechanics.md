## 8. Interaction Mechanics: Resizable Panels, Collapse, the Built-in Browser and the Agent Driving It, and One Rendering Contract for Four Agents

**Thesis.** Chapter 7 specified *what* the UI must say; this chapter specifies *how it must behave* — and the two hard requirements here are structural. First, the layout is currently frozen: `.app` is a CSS grid whose columns come from two constants, `--sidebar-w: 256px` and `--inspector-w: 460px` (`styles/app.css:40-41`, `:110`, `:114`). There is no drag handle, no minimum, no maximum, no persistence, no keyboard path, and no way to collapse the sidebar at all — `Sidebar.tsx`'s `collapsed` state collapses *project groups*, not the rail. Second, the four agents already share one browser pane and one transcript, but nothing in the UI tells the user that the agent is driving, and the rendering path has no cross-driver normalisation: `prettyTool` strips the `mcp__unskilled__` prefix that only Claude and Codex produce (`ThreadView.tsx:132-136`), and `markdown.tsx:14` re-parses the entire message on every delta. "It should work the same for text answers from any agent" is therefore not a styling task — it is a contract that has to be enforced in three places: the event vocabulary (Ch. 5), the driver adapters, and one renderer.

### 8.1 Resizable panels: the splitter contract

The accessibility baseline is the WAI-ARIA APG **Window Splitter** pattern: the divider is focusable, carries `role="separator"`, `aria-orientation`, `aria-valuenow`/`aria-valuemin`/`aria-valuemax` and `aria-controls` pointing at the primary pane, and responds to Left/Right (vertical splitter) or Up/Down (horizontal), with **Enter collapsing the pane or restoring its previous size**, and optional Home/End for min/max ([W3C APG](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)). MDN notes a *focusable* separator is treated as a widget, not a static rule ([MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/separator_role)).

The mechanics that make a splitter feel right, from the two libraries that ship this for real:

| Concern | Correct behaviour | Source |
|---|---|---|
| Hit target | 1px visual line inside a ≥27px invisible drag target (Apple HIG); Allotment uses a 20px feedback area | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels), [Allotment](https://github.com/johnwalley/allotment) |
| Clamping | explicit per-pane min/max; snap-to-zero below a threshold — Allotment calls it `snap`, react-resizable-panels `collapsedThreshold` | same |
| Reset | double-click the divider returns to the default size | same |
| Cursor | `col-resize` on hover, `grabbing` while dragging | desktop convention — the APG pattern does not specify cursor styling |
| Persistence | write on `pointerup`, **never** on every move — react-resizable-panels deliberately fires `onLayoutChanged` only on release | react-resizable-panels |
| Animation | **none during drag** (1:1 pointer tracking); animate only programmatic snap/collapse | [Chrome — animate to `height:auto`](https://developer.chrome.com/docs/css-ui/animate-to-height-auto) / desktop convention |

For this app the cheapest correct implementation keeps the existing CSS: leave `.app` as a grid and make the divider a sibling that writes `--sidebar-w` / `--inspector-w` on the root element. That preserves `app.css:108-114` untouched, keeps the inspector's `slide-in 220ms` (`app.css:524`) for open/close only, and avoids adopting a layout library into a repo that deliberately has no component library. Proposed bounds: sidebar 180–360 (rail 48), inspector 320–720, main pane never below 420. On window shrink the `1fr` main pane absorbs the change; when it would fall below its minimum, **auto-collapse the inspector** rather than overflowing — and restore it when the window grows back. That restore-on-grow rule is a design choice here, not a documented standard; Zed's panel system is the closest prior art ([Zed](https://zed.dev/blog/new-panel-system)).

### 8.2 Collapse and expand

Use the platform before inventing: native `<details>`/`<summary>` gives the twisty, keyboard activation and screen-reader open/closed announcements for free, and its `name` attribute groups several `<details>` into an accordion where only one is open ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details)). The reasoning block and each tool output are disclosures and should be `<details>` — they already are for reasoning (`ThreadView.tsx:79-85`) — but they must **not** be grouped with `name`, since a user can reasonably want two tool outputs open at once.

Controlled regions (the sidebar rail, the inspector) need an explicit toggle button with `aria-expanded` plus `aria-controls`; `aria-expanded` belongs on the focusable control, never on the region ([MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded)). Two details the docs are explicit about: `<details>` has **no built-in way to animate** open/closed, and the modern way to animate to intrinsic height is `interpolate-size: allow-keywords` (currently experimental; `calc-size()` where arithmetic is needed) rather than `max-height` hacks ([MDN `details`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details), [MDN `interpolate-size`](https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size), [Chrome](https://developer.chrome.com/docs/css-ui/animate-to-height-auto)). Add `content-visibility` so a collapsed 2000-line tool output costs nothing to keep in the DOM.

State policy: **panel geometry is a setting, disclosure state is view state.** Sidebar rail and inspector width persist in `settings.json` next to `theme`/`editor`; per-thread reasoning/tool disclosure stays in the renderer, keyed by thread id, and is not written to the database. `prefers-reduced-motion` disables all of it.

### 8.3 The built-in browser pane

The pane is a `<webview partition="persist:unskilled-browser">` (`BrowserPanel.tsx:117`) driven through the Chrome DevTools Protocol, with a toolbar of back/forward/reload/address/pick (`:82-116`). Two things to keep and four to add.

**Keep:** the sandbox posture. Electron's guidance for remote content is explicit — disable `nodeIntegration`, enable `contextIsolation`, keep the sandbox, strip preload in `will-attach-webview`, and set a permission handler ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)); `BrowserView` is deprecated in favour of `WebContentsView` ([Electron migration](https://www.electronjs.org/blog/migrate-to-webcontentsview)). The repo's existing choice — no Node access, no preload, http(s)/file/data only (`README.md`) — is the right one and should be asserted in the smoke test, not just documented.

**Add:**
1. **Device emulation.** `Emulation.setDeviceMetricsOverride` is the CDP domain for viewport/device emulation ([CDP](https://chromedevtools.github.io/devtools-protocol/)). Presets (mobile 390 / tablet 768 / desktop) matter more in this app than in a normal browser: an agent verifying responsive UI in a 460px column is verifying nothing. Both the user *and* the agent should be able to request a preset, which means it belongs in the tool surface too.
2. **A way to widen the pane.** "Move to main area" — the browser takes the full width beside the sidebar, and the conversation collapses to a rail. This is the single highest-value layout feature for a coding harness, because it is the only way to see a real desktop-width page while still watching the agent work.
3. **Console and network.** The controller already collects console errors, exceptions and failed requests for `browser_logs`; the pane should show the same data as a tab (fed by CDP `Log` and `Network`), so the user does not have to ask the agent what the console said.
4. **Screenshot strip.** `browser_screenshot` saves a file (`browser/tools.ts:78-89`); show thumbnails in the pane so the user sees the evidence the agent collected, and can open it at full size.

### 8.4 The agent driving the same page: a take-over model

Today the only signal is that opening the pane happens when the agent calls `browser_open` (`store.ts:316-318`). There is no indication that the page is *under agent control*, no way to pause, and no arbitration when the human clicks something mid-run. This is genuinely unsolved across the industry — the closest documented product model is Browserbase's Session Live View, an embeddable interactive window with explicit **read-only vs read-write** modes for "human in the loop — instantly take control or provide input" ([Browserbase](https://docs.browserbase.com/platform/browser/observability/session-live-view)); `chrome-devtools-mcp` shows the other half, letting an agent "control and inspect a live Chrome browser" while warning that it exposes the browser's content to the client ([chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp/)). Playwright's UI Mode and Trace Viewer are excellent human debugging surfaces but are not shared-control models ([Playwright UI Mode](https://playwright.dev/docs/test-ui-mode)). There is **no convention for who owns the pointer** `[U]`.

The specification, then: one tab state machine — `idle` · `agent-driving` · `human-driving` — with an **exclusive lock**.

- **`agent-driving`:** a persistent banner (not a toast) naming the agent, a step counter, a **Stop** button wired to the turn's abort, and an animated outline on the viewport. The address bar shows a lock; typing a URL or pressing Escape pauses the agent rather than fighting it.
- **Human input wins.** Any click or keypress inside the pane transitions to `human-driving` and *pauses* the agent, surfacing "You took over — the agent is paused · Resume". Two drivers on one pointer is a bug, not a feature.
- **Two-way highlight.** Every agent action already appears in the transcript as a tool row; add a brief ring on the element it acted on, so the pane and the transcript stay in sync.
- **Read-only watch mode** for people who want to see without risking a stray click.
- **One banner component, two modes.** The element picker (`picking`, `startPick`, `BrowserPanel.tsx:108-115`) is already a mode; it should reuse the same banner with a different label rather than inventing a second visual language.

### 8.5 One rendering contract for four agents

This is the "text answers should render the same regardless of the agent" requirement, and it is a contract with three parts.

**1. Pin the dialect.** One parser, one highlighter theme, for every driver. The reference is CommonMark 0.31.2 ([spec](https://spec.commonmark.org/0.31.2/)) plus GFM, "a strict superset of CommonMark" adding four documented extensions — tables (§4.10), task list items (§5.3), strikethrough (§6.5), autolinks (§6.9) — after which GitHub applies its own post-processing and sanitisation ([GFM](https://github.github.com/gfm/)). All four agents emit roughly GFM; if the harness parses them through different paths, they will visibly diverge.

**2. Normalise before rendering, in the adapters.** The canonical event vocabulary (Ch. 5) makes this possible; the work is choosing one representation per concept. Tool names: one mapping table, with `prettyTool`'s prefix-stripping moved into the driver adapters so a Codex `commandExecution`, an ACP `execute`, and Claude's `Bash` all render as the same *Run* row. File paths: one parser (the existing `fileref.ts` is already shared — keep it that way). Diffs: one renderer for `file_change`, `apply_patch` and ACP `tool_call_update` content. Results: one truncation rule, so a 10k-line command output looks the same whether it came from Codex or Claude.

**3. Stream without re-parsing.** Keep completed blocks frozen — memoised by content hash — and render only the **tail** as plain text until its block closes; that is precisely the problem purpose-built streaming renderers solve, handling "incomplete or unterminated Markdown blocks" ([Streamdown](https://github.com/vercel/streamdown)). This fixes partial code fences and partial tables, and it fixes the cost problem at `markdown.tsx:14`, where the whole string is re-parsed per delta. Safety: React's `dangerouslySetInnerHTML` performs **no** sanitisation, and model output is untrusted input, so every rendered node goes through a sanitiser ([DOMPurify](https://github.com/cure53/DOMPurify), or `rehype-harden` as Streamdown uses).

**The test that makes it real:** build one canonical event set, run it through all four driver adapters, snapshot the rendered DOM, and assert the four snapshots are identical. Anything that differs is a normalisation bug, and it is caught in CI rather than by a user noticing that OpenCode's output looks different from Claude's.

### 8.6 File manifest and acceptance tests

**New (proposed):** `Splitter.tsx` (APG-conformant divider writing the layout custom properties), `PaneRail.tsx` (collapsed sidebar), `TakeOverBanner.tsx` (driving / picking / paused), `BrowserToolbar.tsx` (zoom, device presets, console tab), `ScreenshotStrip.tsx`, `usePaneLayout.ts` (persist + clamp + window-shrink policy).
**Modified:** `styles/app.css` (separator, rail, banner, device frame), `App.tsx` (layout composition, keyboard), `Inspector.tsx` (`role="tabpanel"` + `aria-controls`, widen-to-main), `Sidebar.tsx` (rail), `BrowserPanel.tsx` (toolbar, banner, strip), `ThreadView.tsx` (disclosure state per thread), `markdown.tsx` (frozen blocks + plain-text tail), `store.ts` (pane layout, take-over state), `SettingsSheet.tsx` (pane geometry).

**Acceptance tests:** divider keyboard + `aria-value*` assertions; clamping when the window shrinks below the sum of minimums (inspector auto-collapses, then restores); double-click reset; persisted geometry survives restart; collapsed tool output is not rendered (`content-visibility`); the four-driver render-snapshot equality test above; partial-fence streaming renders without a flash of broken markdown; and take-over lock transitions — agent action → `agent-driving`, human click → paused → resume.

### 本章新增来源清单

1. [W3C APG — Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) `[P]` — `separator` role, `aria-value*`, arrow/Enter/Home/End keys.
2. [MDN — `separator` role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/separator_role) `[P]` — focusable separator is a widget.
3. [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) `[P]` — `collapsedThreshold`, 27px/37px hit target citing Apple HIG, persistence on release only.
4. [Allotment](https://github.com/johnwalley/allotment) `[P]` — VS Code-derived sash, `snap`, `minSize`/`maxSize`, 20px feedback area.
5. [Zed — new panel system](https://zed.dev/blog/new-panel-system) `[P]` — unified panel model in a shipping editor.
6. [MDN — `aria-expanded`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded) `[P]` — belongs on the controlling element, with `aria-controls`.
7. [MDN — `<details>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details) `[P]` — native disclosure, `name` accordion, no built-in animation.
8. [MDN — `interpolate-size`](https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size) · [Chrome — animate to `height:auto`](https://developer.chrome.com/docs/css-ui/animate-to-height-auto) `[P]` — animating to intrinsic height without `max-height` hacks.
9. [Electron — Security](https://www.electronjs.org/docs/latest/tutorial/security) `[P]` — `webview`/`WebContentsView` hardening for remote content.
10. [Electron — migrate to `WebContentsView`](https://www.electronjs.org/blog/migrate-to-webcontentsview) `[P]` — `BrowserView` deprecated since Electron 30.
11. [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) `[P]` — `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot`, `Log`, `Network`.
12. [Browserbase — Session Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view) `[P]` — watch/control a live session; read-only vs read-write; human-in-the-loop.
13. [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp/) `[P]` — agent controls a live Chrome; exposes browser content to the client.
14. [Playwright — UI Mode](https://playwright.dev/docs/test-ui-mode) `[P]` — time-travel debugging; a human tool, not a shared-control model.
15. [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) · [GFM spec](https://github.github.com/gfm/) `[P]` — the pinned dialect and its four extensions.
16. [Vercel Streamdown](https://github.com/vercel/streamdown) `[P]` — unterminated-block handling, memoisation, `rehype-harden`.
17. [DOMPurify](https://github.com/cure53/DOMPurify) `[P]` — sanitisation; React's `dangerouslySetInnerHTML` does none.
18. Local repository (verified in-place, 2026-09): `styles/app.css:40-41,108-114,524`, `components/BrowserPanel.tsx:82-117`, `components/Inspector.tsx:20-62`, `components/Sidebar.tsx:14`, `components/ThreadView.tsx:79-85,132-136`, `markdown.tsx:14`, `store.ts:316-318`, `src/main/browser/tools.ts:78-89`.
