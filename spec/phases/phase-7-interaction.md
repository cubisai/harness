# Phase 7 — Interaction mechanics: splitters, collapse, browser, take-over, rendering contract

**Plan:** Ch. 8 (all), Ch. 9 §9.2 (shell regions). **Depends on:** 0 (and 4 for T7.12's streaming tail). **Risk:** med.

**Ownership with Phase 8.** This phase owns the shell mechanics — the splitter (T7.1), the sidebar rail (T7.3) and the terminal drawer (T7.4). Phase 8's Pass 1 lists the same user-visible outcomes (T8.6, T8.7) and defers to these tasks; do not build them twice.

Chapter 7 said *what* the UI must say; this phase makes it *behave*. Two structural requirements: the layout is currently frozen (`app.css:40-41` defines `--sidebar-w: 256px` / `--inspector-w: 460px`, consumed at `app.css:108-114`) and the four agents share one pane and one transcript with no cross-driver normalisation (`ThreadView.tsx:132-136`, `markdown.tsx:14`).

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/08-interaction-mechanics.md`](../../plan/docs/08-interaction-mechanics.md) — the whole chapter: §8.1 the splitter contract and the library findings behind it, §8.2 collapse, §8.3 the browser pane, §8.4 the take-over model, §8.5 the four-agent rendering contract.
- [`HARNESS.md`](../../plan/docs/HARNESS.md) — item 7 is the browser-tool contract (`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_logs`, `browser_screenshot`) and the rule that they attach only once the user has opened the browser. That rule is exactly the cache-cost tradeoff §8.3 and Phase 5 §5.3 address.
- [`plan/docs/09-ui-refinement.md`](../../plan/docs/09-ui-refinement.md) — §9.2, since the terminal drawer and the rail are specified there as shell requirements and implemented here.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 1 §1.4 (WorkBuddy's right-hand results panel with a browser tab and device toolbar) and §1.1 (T3 Code's tabbed right panel plus separate terminal drawer).

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — none.

---

### T7.1 — `Splitter.tsx`: an APG-conformant window splitter
- **What:** a focusable `role="separator"` carrying `aria-orientation`, `aria-valuenow`/`aria-valuemin`/`aria-valuemax` and `aria-controls` pointing at the primary pane; Left/Right move, **Enter collapses/restores**, Home/End jump to min/max, double-click resets. A ≥27px invisible hit target around a 1px visual line; `col-resize` on hover, `grabbing` while dragging; persist on `pointerup` only; **no animation during drag**. The divider writes `--sidebar-w`/`--inspector-w` on the root element so the existing grid is untouched.
- **Files:** `src/renderer/src/components/Splitter.tsx` (new), `src/renderer/src/styles/app.css` (modify — separator only; `app.css:108-114` unchanged), `test/splitter.test.ts` (new)
- **Acceptance:** a pure `splitterKeys(state, key)` reducer test asserts Enter toggles collapsed, arrows move by 8px, Home/End clamp, and the resulting `aria-valuenow` equals the written width; `renderToStaticMarkup(<Splitter …/>)` (a `.tsx` test, Phase 0 T0.10) contains `role="separator"`, `aria-orientation="vertical"` and `aria-controls`; a pure `dragReducer` test asserts exactly one persistence call after N `pointermove` events followed by one `pointerup` (real pointer events need a DOM — see Risks).
- **Notes:** Ch. 8 §8.1 (W3C APG, MDN focusable-separator, 27px hit target, persist-on-release). No layout library — the repo deliberately has none.

### T7.2 — `usePaneLayout.ts`: bounds, clamping, window-shrink policy, persistence
- **What:** sidebar 180–360 (rail 48), inspector 320–720, main pane never below 420. When shrinking would push the main pane below its minimum, **auto-collapse the inspector** and restore it on grow. Panel geometry persists in Settings; per-thread disclosure state does not.
- **Files:** `src/renderer/src/hooks/usePaneLayout.ts` (new), `src/shared/types.ts` (modify — `Settings.paneLayout`), `src/main/settings.ts` (modify), `src/renderer/src/store.ts` (modify), `test/pane-layout.test.ts` (new)
- **Acceptance:** a pure `clampLayout(width, layout)` test: at 900px with sidebar 256 + inspector 460 (main 184 < 420) the inspector collapses and the restore width is remembered; growing back to 1200 restores 460. After `updateSettings` and a fresh `SettingsStore`, `getSettings().paneLayout` equals what was written.
- **Notes:** Ch. 8 §8.1 (restore-on-grow is a design choice; Zed's panel system is the prior art), §8.2 ("panel geometry is a setting, disclosure state is view state"). Settings live in `settings.json` (`settings.ts:19-30`).

### T7.3 — Sidebar rail and controlled-region toggles
- **What:** `PaneRail.tsx` is the collapsed sidebar (48px). The sidebar and inspector get explicit toggle buttons with `aria-expanded` **on the control** plus `aria-controls` pointing at the region — never `aria-expanded` on the region.
- **Files:** `src/renderer/src/components/PaneRail.tsx` (new), `src/renderer/src/components/Sidebar.tsx` (modify — `collapsed` at `Sidebar.tsx:14` collapses project groups, not the rail), `src/renderer/src/App.tsx` (modify), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** `renderToStaticMarkup` asserts the toggle has `aria-expanded` and `aria-controls` and the region carries the matching `id`; activating the toggle swaps `Sidebar` for `PaneRail` and the grid still reads `--sidebar-w`.
- **Notes:** Ch. 8 §8.2 (MDN `aria-expanded` belongs on the focusable control). Keep the existing project-group collapse distinct from the rail.

### T7.4 — Move the terminal into a bottom drawer
- **What:** remove Terminal from the inspector's tab set (`Inspector.tsx:20-62`; tab button `:29-31`, bodies `:45-56`) and render a height-draggable bottom drawer toggled by the existing ⌃` shortcut (`App.tsx:55-57`), remembering its height. Terminals already stay mounted per project (`store.ts:279`), so this is a layout move, not a lifecycle change.
- **Files:** `src/renderer/src/components/Inspector.tsx` (modify), `src/renderer/src/App.tsx` (modify), `src/renderer/src/components/TerminalPanel.tsx` (modify), `src/renderer/src/store.ts` (modify — `inspectorTab` `store.ts:52` loses `"terminal"`), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** the inspector renders exactly Changes and Browser (Phase 8 T8.9 later adds Files); ⌃` toggles the drawer; `pnpm typecheck` fails if `showInspector("terminal")` remains; a test asserts `TerminalPanel` stays mounted (a `hidden` attribute, not an unmount) while the drawer is closed; the drawer height survives a restart.
- **Notes:** Ch. 8 §8.6 (modified `App.tsx`, `Inspector.tsx`), Ch. 9 §9.2; root `README.md:67` (Terminal ⌃`) needs its wording updated ("Terminal tab" → drawer). The drawer height uses T7.1's splitter in its horizontal orientation.

### T7.5 — Collapse with native `<details>`, `interpolate-size`, `content-visibility`
- **What:** reasoning and every tool output become `<details>` (reasoning already is at `ThreadView.tsx:79-85`), explicitly **not** grouped with `name` so two tool outputs can be open at once. Add `interpolate-size: allow-keywords` for the height animation (`<details>` has none built in) and `content-visibility` so collapsed output costs nothing. Per-thread disclosure state lives in the renderer, keyed by thread id.
- **Files:** `src/renderer/src/components/ThreadView.tsx` (modify), `src/renderer/src/styles/app.css` (modify), `src/renderer/src/store.ts` (modify), `test/collapse.test.ts` (new)
- **Acceptance:** `renderToStaticMarkup` of a `tool-use` row contains `<details>` with **no** `name` attribute; with a disclosure collapsed, its body is absent from the static markup; disclosure state is keyed by thread id and never appears in `settings.json` after a write.
- **Notes:** Ch. 8 §8.2 (MDN `<details>`, `interpolate-size`, Chrome animate-to-`height:auto`).

### T7.6 — Browser device emulation
- **What:** add CDP `Emulation.setDeviceMetricsOverride` presets (mobile 390 / tablet 768 / desktop) to the toolbar **and** to the agent's tool surface, so an agent verifying responsive UI can request a preset instead of verifying nothing in a 460px column. Clear the override on desktop and when widening (T7.7).
- **Files:** `src/main/browser/controller.ts` (modify — beside `attach` `controller.ts:38-66`), `src/main/browser/tools.ts` (modify), `src/renderer/src/components/BrowserPanel.tsx` (modify), `test/browser.test.ts` (modify)
- **Acceptance:** a controller unit test asserts `setDeviceMetricsOverride` is sent with `{width:390, height:844, deviceScaleFactor:3, mobile:true}` for mobile and `Emulation.clearDeviceMetricsOverride` for desktop; the tool list exposes the preset argument; the smoke run (`index.ts:482-512`) still passes.
- **Notes:** Ch. 8 §8.3 add-1. Keep the sandbox posture (T7.6 note below); CDP `Emulation.*` is already reachable through `wc.debugger`.

### T7.7 — Widen the browser to the main area
- **What:** a "Move to main area" toggle — the browser takes the full width beside the sidebar and the conversation collapses to a rail. This is the only way to see a real desktop-width page while still watching the agent work.
- **Files:** `src/renderer/src/store.ts` (modify), `src/renderer/src/App.tsx` (modify), `src/renderer/src/components/Inspector.tsx` (modify — `role="tabpanel"` + `aria-controls`), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** toggling sets a `browserWide` layout flag; the grid becomes `var(--sidebar-w) 1fr` with the browser in the `1fr` column and the thread as a rail; the flag survives restart via Settings; any active device override is cleared on widening.
- **Notes:** Ch. 8 §8.3 add-2, §8.6 (`Inspector.tsx` `role="tabpanel"`).

### T7.8 — Console and network view
- **What:** show the data `browser_logs` already collects (`LogEntry` `controller.ts:13-16`, `readLogs` `:252-257`) as a pane tab, fed by the same CDP `Log`/`Network` events, so the user does not have to ask the agent what the console said.
- **Files:** `src/main/browser/controller.ts` (modify — expose a read-only view), `src/main/index.ts` (modify — IPC), `src/preload/index.ts` (modify), `src/shared/types.ts` (modify), `src/renderer/src/components/BrowserPanel.tsx` (modify)
- **Acceptance:** with the smoke page the console tab shows the `smoke-console-check` entry without a `browser_logs` call; a test asserts the tab does **not** clear the agent's buffer (read-only).
- **Notes:** Ch. 8 §8.3 add-3. Reuse the existing collection; do not add a second CDP subscription.

### T7.9 — Screenshot strip
- **What:** a thumbnail strip listing the files `browser_screenshot` saved (`browser/tools.ts:78-89`, `controller.screenshot()` `:305-313`), each openable at full size.
- **Files:** `src/renderer/src/components/ScreenshotStrip.tsx` (new), `src/main/browser/controller.ts` (modify — list saved screenshots), `src/shared/types.ts` (modify), `src/renderer/src/components/BrowserPanel.tsx` (modify)
- **Acceptance:** after one `browser_screenshot` call the strip renders one `<img>` whose `src` resolves to the saved path; a call-count assertion shows the listing is not re-read on every render.
- **Notes:** Ch. 8 §8.3 add-4.

### T7.10 — Take-over model: an exclusive lock and one banner
- **What:** a per-tab `idle | agent-driving | human-driving` state machine with an **exclusive lock**. A persistent banner (not a toast) names the agent, shows a step counter, a **Stop** wired to the turn's abort (`service.interrupt`), and an animated outline. Any click/keypress in the pane transitions to `human-driving` and **pauses** the agent ("You took over — the agent is paused · Resume"); typing a URL or Escape pauses rather than fighting. A brief ring on the element the agent acted on. A read-only watch mode. The element picker (`picking`, `startPick` `BrowserPanel.tsx:108-115`) reuses the same banner with a different label.
- **Files:** `src/renderer/src/components/TakeOverBanner.tsx` (new), `src/renderer/src/store.ts` (modify), `src/renderer/src/components/BrowserPanel.tsx` (modify), `src/main/browser/controller.ts` (modify — emit `agent-driving` per action, add a highlight command), `src/renderer/src/styles/app.css` (modify), `test/takeover.test.ts` (new)
- **Acceptance:** a pure reducer test: `agent-driving` + human click → `human-driving` + `paused`, and no second transition is possible while the lock is held; `resume()` returns to `agent-driving` only from the banner. Stop calls `interrupt()` for the running thread. With `watch: true`, pointer events never leave `agent-driving`.
- **Notes:** Ch. 8 §8.4 (Browserbase read-only vs read-write; **no convention for who owns the pointer** `[U]`); Ch. 7 §7.9 (anything the user must act on gets a banner, not the 3.5 s toast). Two drivers on one pointer is a bug.

### T7.11 — One rendering contract: pinned dialect, adapter normalisation, sanitisation
- **What:** one parser for all four agents — CommonMark 0.31.2 + GFM — and one highlighter theme. Move normalisation into the driver adapters: one tool-name mapping (`prettyTool` `ThreadView.tsx:132-136` moves out), one path parser (`fileref.ts` stays shared), one diff renderer for `file_change`/`apply_patch`/ACP `tool_call_update`, one truncation rule (today `summarize.ts:3`, `MAX = 160`). Output is sanitised; never raw model HTML.
- **Files:** `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `src/main/agents/summarize.ts` (modify), `src/renderer/src/markdown.tsx` (modify), `src/renderer/src/components/ThreadView.tsx` (modify), `src/shared/types.ts` (modify), `test/render-parity.test.ts` (new)
- **Acceptance:** a table-driven test runs one canonical tool concept through all three adapters (Claude, Codex, ACP — OpenCode/Antigravity/DeepSeek/Cursor share the ACP one; see spec README repo fact 4) and asserts one normalised `{name, summary}` per concept (`commandExecution` / ACP `execute` / `Bash` → `Run`); a diff from `file_change` and from ACP `tool_call_update` renders byte-identical markup; no `dangerouslySetInnerHTML` exists anywhere in the renderer (grep assertion).
- **Notes:** Ch. 8 §8.5 parts 1–2. **Dependency note:** pinning CommonMark+GFM means adopting a parser — today `markdown.tsx` is a small hand-rolled subset that builds React elements and is therefore already injection-safe. If a parser+HTML path is adopted, a sanitiser (DOMPurify or `rehype-harden`) is required; record the new runtime dependency in this phase per `../README.md`.

### T7.12 — Four-driver render-snapshot equality and the streaming tail
- **What:** build one canonical event set, express it as each adapter's native input (Claude SDK messages, Codex notifications, ACP updates — plus an OpenCode-flavoured ACP fixture), run each through its adapter, render with `renderToStaticMarkup`, and assert the snapshots are identical. The streaming tail itself (frozen blocks + plain-text tail) is Phase 4 T4.6's `streaming.ts`; this task only asserts it holds across adapters — do not re-implement it.
- **Files:** `test/render-parity.test.tsx` (new), `test/fixtures/canonical-events.ts` (new), `test/fixtures/mock-acp-agent.mjs` (modify)
- **Acceptance:** the per-adapter `renderToStaticMarkup` outputs are string-equal; a partial fence arriving through each adapter's delta channel renders as plain text with no `<pre>` (reusing T4.6's assertions, not duplicating them).
- **Notes:** Ch. 8 §8.5 part 3, §8.6. No new dependency — `react-dom/server` ships with `react-dom`.

---

## Risks & rollback

- **Layout regression.** Keeping the grid means every column must still be driven by the custom properties; one hard-coded width breaks clamping. Mitigation: the `clampLayout` unit test plus a `pnpm smoke` run.
- **No DOM test environment.** `package.json` has no jsdom/happy-dom and no testing-library, so splitters and take-over are tested as pure reducers plus `renderToStaticMarkup` (enabled by Phase 0 T0.10). Decide in T7.1 whether to add jsdom as a devDependency; if not, do not write pointer/keyboard tests that need a real DOM.
- **Terminal move changes a store shape.** `inspectorTab` (`store.ts:52`) loses `"terminal"`; keep `terminals[]` (`store.ts:279`) untouched so live shells survive. Revert by restoring the tab value.
- **Device override leaking.** An emulated viewport must be cleared on widening and on desktop so the agent never measures a mobile frame as a desktop page.
- **Take-over.** No industry convention for pointer ownership `[U]`; the exclusive lock is the safety property — never let two drivers hold the pointer.
- **Rendering is a security boundary.** The current renderer is sanitisation-safe by construction; adopting a parser without a sanitiser is a regression. Revert T7.11/T7.12 independently.
- **Rollback.** Every task is independently revertable; only T7.4 changes a persisted shape, and only T7.11 adds a dependency.

## Exit criteria

- [x] `pnpm typecheck && pnpm test && pnpm build` green (2026-09-27, bun; the two known Windows-PC failures only; `electron . --smoke` green).
- [x] The divider is keyboard-operable with correct `aria-value*`; Enter collapses/restores; double-click resets (T7.1). Checked in the app.
- [x] Window shrink below the sum of minimums auto-collapses the inspector and restores on grow (T7.2). Checked in the app.
- [x] Geometry survives restart; disclosure state does not (T7.2, T7.5).
- [x] Collapsed tool output is not rendered (T7.5).
- [x] Terminal is a bottom drawer; the inspector tabs are Changes and Browser only (T7.4).
- [x] The browser keeps its sandbox posture — no Node, no preload, http(s)/file/data only (`index.ts:103-109`, `README.md:99`) — asserted in the smoke test, not just documented (T7.6). `smoke: browser sandbox ok`.
- [x] The per-adapter render snapshots are identical (T7.12): `test/render-parity.test.tsx` renders one canonical set from Claude, Codex, ACP and OpenCode-flavoured ACP and asserts string equality.
- [x] Take-over lock transitions are enforced by tests (T7.10).

**Carried forward:** OpenCode's real ACP stream may send `rawInput`/`locations` only on a later `tool_call_update`, after the tool-use row was emitted from the bare `tool_call` (title "bash"/"edit"); the mock sends them up front. Check against a real OpenCode run in Phase 8 and, if so, update the row's summary from the first update that carries them.
