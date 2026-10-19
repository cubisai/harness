I'll dispatch this to the researcher subagent.# P5 "browser" — code map

## P5.1 Auto-open

**Today, an agent's first browser call never opens the pane.** All seven tools go through `gated`, which only checks the controller's `enabled` boolean:

- `src/main/browser/tools.ts:14-17` — `gated`: `if (!browser.enabled) return Promise.resolve({ text: "Browser pane not open", isError: true });`
- Exact text returned while the pane is closed: **`Browser pane not open`** (`src/main/browser/tools.ts:15`), with `isError: true`.
- `enabled` starts `false` (`src/main/browser/controller.ts:37`) and is only set `true` in `attach()` when the renderer reports the `<webview>`'s webContents id (`src/main/browser/controller.ts:79`). It is never reset to `false` (grep `enabled =` found only init + attach). So after the user has opened the pane once this session, the tools work for the rest of it; before that, every call refuses without touching the browser.

**Auto-open only happens when already enabled but the webContents is gone.** If `enabled` is true and `this.wc` is null/destroyed, `page()` requests the pane and waits:

- `src/main/browser/controller.ts:163-179` — `page()`: if no live `wc`, pushes a waiter, calls `this.requestOpen(url)`, rejects after `setTimeout(..., 15_000)` with **`The browser pane didn't open.`** (`:169`).
- `requestOpen` is the constructor callback, wired to a broadcast: `src/main/index.ts:429-430` — `new BrowserController((url) => broadcast({ type: "browser-open", url }), ...)`.

**Handshake / how the pane opens:**

- Broadcast type: `src/shared/types.ts:1032` — `{ type: "browser-open"; url?: string }`.
- Store reaction: `src/renderer/src/store.ts:1276-1278` — `case "browser-open": set({ inspectorOpen: true, inspectorTab: "browser", browserMounted: true, browserUrl: update.url ?? null })`.
- Pane mount: `src/renderer/src/components/Inspector.tsx:53-56` renders `<BrowserPanel />` when `browserMounted`; `src/renderer/src/store.ts:1135` sets `browserMounted: s.browserMounted || tab === "browser"`.
- The `<webview>` element: `src/renderer/src/components/BrowserPanel.tsx:239` — `<webview ... src={initial} partition="persist:unskilled-browser" />`.
- `dom-ready` handshake: `src/renderer/src/components/BrowserPanel.tsx:106-110` — `onReady` sets `ready.current = true` and calls `void api().browserAttached(el.getWebContentsId())`; later URL changes load into the existing webview (`:142-147`).
- Preload bridge: `src/preload/index.ts:36` — `browserAttached: (webContentsId) => ipcRenderer.invoke("browser:attached", webContentsId)` (type at `src/shared/types.ts:1113-1114`).
- Main handler: `src/main/index.ts:1566` — `ipcMain.handle("browser:attached", (_e, webContentsId) => browser.attach(webContentsId))`; `attach` resolves the `page()` waiters (`src/main/browser/controller.ts:102`).
- Webview security posture: `src/main/index.ts:169-176` (`will-attach-webview` strips preload/Node, requires an allowed URL); `webviewTag: true` at `:164`.

**Tests that pin current behaviour:** `test/browser.test.ts` (`:64-85` gate answers `"Browser pane not open"` for all seven tools; `:79-84`), plus a UI-level smoke path in `src/main/index.ts:1762-1808` (`smokeBrowserWith`) which is not a vitest test.

## P5.2 Backend contract

`BrowserController` is the only browser backend; `browserTools(browser: BrowserController)` takes the concrete class (`src/main/browser/tools.ts:3,30`) — **no interface/abstraction exists today**. The roadmap itself calls for one later: `plan/docs/13-harness-optimization-roadmap.md:449` ("Introduce a browser interface supporting the visible Electron controller and a pinned, tested agent-browser CLI adapter") and `plan/docs/HARNESS.md:30`.

Public surface (`src/main/browser/controller.ts`) and return shapes:

- Fields: `device: DevicePreset` (`:35`), `enabled = false` (`:37`), `paused = false` (`:39`).
- `setPaused(paused: boolean): void` (`:56-58`); `assertNotPaused()` throws **`The user took over the browser pane and paused you. Ask them to press Resume in the pane, or carry on without the browser.`** (`:60-62`); `assertOpenAllowed()` (`:65-67`).
- `announce(action, ref): void` (`:70-72`); `attach(webContentsId: number): void` (`:74-103`); `detach(): void` (`:105-114`).
- `setDevice(preset): Promise<void>` (`:154-160`); `page(url?): Promise<WebContents>` (`:163-179`) — throws `The browser pane didn't open.` (`:169`).
- `navigate(input): Promise<void>` (`:181-194`) — throws `` Not allowed in the browser pane: ${url} `` (`:183`), or `The browser pane isn't open.` (`:185`); load failures are pushed as a log line, not thrown (`:190-193`).
- `snapshot(): Promise<string>` (`:209-213`) — runs `collectPage` in-page and returns `formatSnapshot(...)`.
- `click(ref): Promise<string>` (`:267-278`) — returns `` Clicked ${ref} ("${label}"). Now at ${wc.getURL()} `` (`:277`).
- `type(ref, text, submit): Promise<string>` (`:280-321`) — returns `` Typed into ${ref}${submit ? " and pressed Enter" : ""}. Now at ${wc.getURL()} `` (`:320`).
- `evaluateForAgent(expression): Promise<string>` (`:323-330`) — JSON-stringified value; over 4000 chars truncated with `… (truncated)` (`:329`).
- `readLogs(clear: boolean): Promise<string>` (`:332-340`) — lines as `[${level}] ${text}`, or `No console errors, warnings, or failed requests since the last page load.` (`:339`).
- `logsView(): LogEntry[]` (`:343-345`), `startPick(): Promise<void>` (`:348-352`), `nextPick(): Promise<string|null>` (`:357-359`), `screenshot(): Promise<{ path: string; png: Buffer }>` (`:393-403`), `listScreenshots(): string[]` (`:406-408`).

**Snapshot format / ref ids:** built by `collectPage` in `src/main/browser/snapshot.ts`; refs are assigned `e1, e2, …` via `r = \`e${++n}\`` written to a `data-unskilled-ref` attribute (`snapshot.ts:30-31,70-74`). Node kinds/types at `snapshot.ts:11-27`; rendering to text at `formatSnapshot` `snapshot.ts:131-162` (`Page:`, `URL:`, `[e7] button "…"`, etc.). The controller injects it as `(${collectPage.toString()})(400)` (`controller.ts:211`).

**Stale-ref errors:** `locate()` throws `` No element ${ref} on the page. Take a new browser_snapshot; refs change when the page does. `` (`controller.ts:215-228`, message at `:227`).

**agent-browser in the repo:** no source file shells out to it — grep for `agent-browser|AGENT_BROWSER` under `src/` returned no files. It appears only in docs/handoff and in the agent-facing skill `resources/skills/browser/SKILL.md:33` ("If the browser tools aren't offered at all, and `agent-browser` is on PATH, use it instead").

**Tests that pin current behaviour:** `test/browser.test.ts` — URL rules `:11-26`, `formatSnapshot` `:28-62`, `describePick` `:87-99`, device emulation + log buffer + pause refusal `:101-177`.

## P5.3 Session ownership

**One controller, one webview, app-wide — not per thread.**

- Single instance: `src/main/index.ts:429` `const browser = new BrowserController(...)`.
- One tool list shared by every thread: `src/main/index.ts:440` `const tools = browserTools(browser)`; `:444` `const allTools = [...tools, ...memoryTools]`; `:542-548` `harnessTools(thread)` returns `allTools` (plus design/team tools) — the same browser tools instance for chat, design and team threads.
- One panel: `Inspector.tsx:53-56` renders a single `<BrowserPanel />` (no thread id passed); it stays mounted once opened (`Inspector.tsx:12` comment; `store.ts:1135`).

**Two threads calling browser tools at once:** they hit the same `BrowserController.wc`, the same page, the same `logs` buffer and the same `requests` map. There is **no per-thread session or mutex**; the only serialization is each async method awaiting CDP commands. `enabled`/`paused` are single global booleans (`controller.ts:37,39`), so a takeover by one thread's user pauses every thread's browser tools.

**Takeover / pause:** `setPaused` (`controller.ts:56-58`) is called from the `browser:takeover` IPC (`src/main/index.ts:1568`; preload `src/preload/index.ts:40`). `click`/`type`/`evaluateForAgent` call `assertNotPaused()` (`controller.ts:268,281,324`); `browser_open` calls `assertOpenAllowed()` (`tools.ts:44`). Reads (snapshot, logs, screenshot) do **not** check paused. Renderer-side exclusive-lock state machine: `src/renderer/src/takeover.ts:22-39`; store actions `browserInput`/`resumeAgent`/`stopAgent`/`setWatch` at `store.ts:663-687` call `browserTakeOver(true/false)`; `stopAgent` also `interrupt()`s the thread (`store.ts:679-683`); agent actions reset state via `takeOverReducer` `agent-action` (`store.ts:1299-1300`), turn end at `store.ts:1249-1251`. Banner in `BrowserPanel.tsx:214-221` (`TakeOverBanner`), overlay `:257-272`.

**Tests that pin current behaviour:** `test/takeover.test.tsx` (`:4-48` reducer states; `:50-73` store actions incl. `browserTakeOver`), `test/takeover-banner.test.tsx`, and `test/browser.test.ts:152-177` (controller/paused + `browser_open` refusal).

## P5.4 Readiness and stale refs

**Waits are partly a fixed sleep, plus a load-event wait — no network-idle.**

- `settle()` after click/type: always `await new Promise((r) => setTimeout(r, 250))` (fixed 250 ms), then if `wc.isLoading()` waits for `did-stop-loading` with a 10 s cap (`controller.ts:231-243`).
- Navigation relies on `wc.loadURL(url)` (`controller.ts:189`) — Electron's own load promise; failures are caught and logged, not retried (`:190-193`).
- `browser_open` calls `browser.page(url)` then `snapshot()`; `snapshot()` calls `evaluate` immediately after (`controller.ts:209-213`), so it can snapshot mid-load if `settle` wasn't involved (only click/type call `settle`).
- Typing uses real `Input.insertText` then falls back to a native value setter + `input`/`change` events if the value didn't take (`controller.ts:284-304`); Enter is a synthesized `KeyboardEvent` + `form.requestSubmit()` (`:305-316`).

**Stale refs:** every snapshot call starts by stripping all old `data-unskilled-ref` attributes (`snapshot.ts:31`) and re-numbers from `e1` (`snapshot.ts:70-74`); so a ref from an old snapshot that now resolves to a different element silently targets the new one, while a ref that no longer exists throws the `No element … Take a new browser_snapshot` error (`controller.ts:227`).

**Truncation:** `snapshot()` passes `400` as `maxNodes` (`controller.ts:211`); `collectPage` stops at `nodes.length >= maxNodes`, sets `truncated = true` (`snapshot.ts:79-82,127`), and `formatSnapshot` appends `(snapshot truncated; scroll or narrow the page to see more)` (`snapshot.ts:160`); empty pages get `(no visible content)` (`snapshot.ts:161`).

**Logs:** buffer capped at `MAX_LOGS = 200` (`controller.ts:12,117-121`); console errors/warnings/asserts, uncaught exceptions, HTTP ≥400 and failed (non-canceled) requests are pushed via CDP events (`controller.ts:123-151`); in-flight request map capped at 500 (`:141`). `readLogs(clear)` returns the joined lines and optionally clears (`controller.ts:332-340`); `logsView()` is a never-clearing copy for the user's console tab (`:343-345`).

**Tests that pin current behaviour:** `test/browser.test.ts:28-62` (snapshot rendering + truncation/empty text), `:133-145` (log buffer not cleared by `logsView`).

## P5.5 Dev servers

**No code starts, detects, or port-scans a project dev server.** Searches for `dev server`, `devServer`, `npm run dev`, `vite`, `5173`, `detectPort`, `waitForPort` found only:

- `localhost:3000`/`localhost:5173` as example strings in tool descriptions and URL normalization (`src/main/browser/tools.ts:35,37`; `src/main/browser/url.ts:11-17`; `BrowserPanel.tsx:171,243`; `resources/skills/browser/SKILL.md:12`).
- `vite.preview.config.ts:9` (CubiQ's own mock UI preview server, port 5199) and `README.md:127` — the app's own dev tooling, not target-project servers.
- `evals/tasks/browser-smoke.json:12` prompts the agent to open `http://localhost:5173` and its reference says "Needs the app's browser pane; unavailable in the bun runner until P5 adds a headless backend" (`:33`) — i.e. the dev server is expected to be started externally, by the user/agent.
- `plan/docs/finding-research.md:501-503` notes agents can start a dev server only synchronously inside a turn (no async job support).

Process spawning/killing that does exist (not dev-server detection):

- `src/main/winspawn.ts` — `spawnCommand` (`:57-64`), `killTree` via `taskkill /T /F` on Windows / `child.kill()` elsewhere (`:86-93`), `killPidTree` (`:101-111`).
- `src/main/terminal.ts` — `TerminalManager` keyed by id (comment: "one per project", `:24,27-28`), `node-pty` spawn with the user's shell (`:37-46`), `close()` → `pty.kill()` (`:66-69`), `dispose()` kills all (`:71-74`). Wired at `src/main/index.ts:1577-1584`; the terminal is user-driven, nothing auto-runs a dev command.
- Agent shell commands: `src/main/harness/tools/bash.ts` spawns and `killTree`s (`:84,104-132`).

Nobody tracks or kills a project dev server as an app-owned process.

**Tests that pin current behaviour:** `test/winspawn.test.ts` and `test/terminal-drawer.test.tsx` exist but cover spawn helpers / terminal UI, not dev servers; no test asserts dev-server start/detect (not found in `test/` for those patterns).

## Tests covering `src/main/browser/*`

- `test/browser.test.ts` — directly imports `tools.ts`, `snapshot.ts`, `url.ts`, `controller.ts`, `picker.ts` (covers url rules, `formatSnapshot`, the `gated` "Browser pane not open" gate, `describePick`, device emulation, log buffering, paused refusals). `src/main/browser/picker.ts:selectorFor`/`startPicker` are additionally exercised by `test/design-canvas.test.tsx`, `test/design-outline.test.tsx`, `test/design-bridge-select.test.ts`, and `describePick` by `test/composer.test.tsx`.
- `test/browser-ui.test.tsx` — `ConsoleList` (from `BrowserPanel`) and `ScreenshotStrip`.
- `test/takeover.test.tsx`, `test/takeover-banner.test.tsx` — takeover reducer / banner (renderer-side pause behaviour).
- `test/smoke-checks.test.ts` — **does not** cover browser (no browser matches); the in-app `smokeBrowserWith` (`src/main/index.ts:1762-1808`) is a runtime smoke, not a vitest file.

## Open questions

- Whether `broadcast({ type: "browser-open" })` reliably reaches the renderer if the pane was never mounted (the waiter has a 15 s timeout); not verified without running the app.
- Behaviour of two concurrent agent turns writing `logs`/`wc` simultaneously is unverified (no locking code found), stated as absent-lock reasoning from reading only.