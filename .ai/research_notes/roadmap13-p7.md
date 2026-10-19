# Code map: local-first scheduled automations

## 1. `src/main/db.ts` — tables, migrations, Store API, temp stores
- Only one table set, created inline in the constructor: `projects`, `threads`, `events`, `blobs`, `injection_ledger` at `src/main/db.ts:44-92`; PRAGMAs (WAL, foreign_keys) at `:41-43`.
- Schema version lives in its own table: `CREATE TABLE schema_version (version INTEGER NOT NULL)` at `:62`; version read at `:285-287`.
- `migrate()` is additive, an ordered `steps[]` array indexed by version, each gated on `applied()` (idempotent column/table check) then `UPDATE schema_version` at `:97-293`.
- Recently added example table `background_runs` is migration step 28 at `db.ts:266-283` (columns `purpose, project_id, day, agent, model, tokens, estimated, ok, escalated, at`; index `background_runs_project_day`). Precedent: steps 23-26 create `turn_scores/lessons/learn_replays/learn_budget` at `:212-263`.
- Helpers: `hasColumn` `:296`, `hasTable` `:301`; raw connection exposed as `get sql()` `:306`.
- Store API style: methods on a `Store` class (`:31`); each does `this.db.prepare(...).run/get/all(...)` with snake_case columns, mapped to camelCase domain types via module-level `toProject` `:988`, `toThread` `:992`, `toStoredEvent` `:979`; row shapes declared as private interfaces `:901-969`.
- Thread creation: `Store.createThread(...)` `:387`; event append `appendEvent` `:485`; `threadTotals` `:850`; `turnUsage` `:878`.
- Temp stores for tests: **not verified** — I did not open a test file that constructs `new Store(...)`. Evidence that a fresh in-memory DB is built with this schema exists at `src/main/smoke-checks.ts:102-103`.

## 2. Programmatic thread/turn without the UI
- `Service.createThread(projectId, agent?, kind?, designSystem?, expertId?)` resolves a driver + default model/permission and calls `store.createThread` — `src/main/service.ts:211-218`.
- `Service.send(req: SendRequest)` runs one turn — `service.ts:658`; it sets `this.running.set(threadId, controller)` and broadcasts `running:true` `:727-728`, calls `driver.runTurn({...})` `:804-934`, and clears in `finally` `:1039-1055`.
- `isRunning(threadId)` returns `this.running.has(threadId)` `:648-650`; `interrupt` calls `controller.abort()` `:1058-1060`.
- Per-turn cost/usage: `turn-end` events carry `inputTokens/outputTokens/usage/costUsd`, stored via `this.emit` (`appendEvent`) at `:869`; aggregate is `threadTotals` (`db.ts:850-871`, summing `costUsd` at `:858`).
- Turn queueing is **renderer-side**, not in main: `store.ts:1354-1360` drains `outbox[threadId][0]` and calls `send` again; main-process automatic follow-ups (check-fix rounds) chain `void this.send(next)` at `service.ts:1046-1050`; async answers queue via `this.afterTurn` `:1043-1045`.
- IPC surface: preload `createThread` `src/preload/index.ts:15`, `send` `:30`, `interrupt` `:31`, `listEvents` `:25`, `threadTotals` `:27`, `pendingState` `:35`. Handlers in `src/main/index.ts:1419` (`threads:create` → `service.createThread`/`createWorktreeThread`), `:1544` (`turn:send` → `service.send(...).catch`, resolves once started), `:1551` (`turn:interrupt`), `:1417/:1418/:1533/:1534/:1541` (list/all/events/page/totals), `:1556` (`pending:get`).

## 3. App lifecycle (`src/main/index.ts`)
- `app.whenReady()` awaited at `:222`; post-ready setup (userData, `Store` at `:237`, `SettingsStore` at `:249`) follows.
- `createWindow()` returns a `BrowserWindow` at `:133-191`; `ready-to-show` shows it `:177`; the `windows` set + `broadcast()` (webContents.send `"unskilled:update"`) at `:302-305`.
- `app.on("activate")` `:1712`; `window-all-closed` quits on non-mac `:1715-1717`.
- `before-quit` disposes updater/extractor/learner/service/previews/watcher/shooter/terminals/MCP and `store.close()` — `:1718-1732`.
- Scheduled-timer precedents in main: `setInterval(...limits.tick..., 60_000)` `:653`; `LimitsTracker` in `src/main/limits-refresher.ts:44-51`; `src/main/watchdog.ts:37`; `src/main/updater.ts:52`.
- **powerMonitor (suspend/resume): not found** — grep for `powerMonitor` in `src` returned no matches.
- **Tray: not found** — grep for `Tray`/`new Tray` in `src/main` returned no matches.
- **Single-instance lock: not found** — grep for `requestSingleInstanceLock`/`second-instance` in `src` returned no matches.
- **`will-quit`: not found** — only `before-quit` exists.

## 4. Message Center
- UI: `InboxBell` `src/renderer/src/components/MessageCenter.tsx:16`; `MessageCenter` sheet `:34`; reads store via `useInbox` `:7-13` (`permissions`, `finished`, `threads`, `selectedThreadId`).
- Row model + logic: `InboxRow` `src/renderer/src/inbox.ts:11-13`; `inboxRows()` `:27`; `turnEnded()` `:45`; `threadSeen()` `:52`; `FinishedTurn` `:4-8`. Note doc: "Transient notices never land here" `:25`.
- Renderer store state: `permissions` `src/renderer/src/store.ts:148`, `finished` `:154`, `inboxOpen` `:157`; reducer `apply()` `:1277`; a main event becomes a Finished row in `case "running"` (`turnEnded(...)`) `:1334-1352`; permission card insert `case "permission"` `:1367-1372`.
- Main → renderer channel: `LiveUpdate` union `src/shared/types.ts:1041-1083` (`running`, `permission`, `thread`, `event`, …); delivered over `onUpdate` (`preload/index.ts:128`, `shared/types.ts:1235`).
- There is **no OS notification / `new Notification`** path found; Message Center is in-app only (derived from `permissions` + `finished`).

## 5. Settings
- `Settings` interface: `src/shared/types.ts:181-220` (`defaultAgent` `:194`, `defaultPermissionMode` `:195`, `memory` `:205`, `learn` `:219`).
- Stored by `SettingsStore` (`src/main/settings.ts:60`), one JSON file at `settings.json` — path passed in `src/main/index.ts:249`; `read()` `:72-86`, atomic `write()` `:88-93`; `get()` applies defaults `:144-147`; `view()` `:149-157`; validating `update()` `:159-199`; one-shot schema migrations `migrate()` `:100`, `migrateDeepseekDefault()` `:132`.
- Read in main via `settings.get()` (e.g. `index.ts:272,282,310`); IPC `settings:get`/`settings:update` `index.ts:1227-1228`; preload `getSettings/updateSettings` `preload/index.ts:48-49`.
- Per-project settings exist only as maps inside global settings, not a table: `learn.enabledProjects`, `learn.backgroundByProject` (`src/shared/learn.ts:107-119`), and `memory.disabledProjects` (`types.ts:205`). Sanitizers: `sanitizeLearn` `settings.ts:434-448`.

## 6. Background spending (P4.1)
- Table `background_runs` created in migration 28 — `db.ts:266-283`. Typed access in `src/main/learn/db.ts`: `recordRun()` `:254-258`, `runTokens(projectId, day, purpose)` `:261-263`, `runs()` `:267-268`.
- Token budget fields `dailyTokens` / `memoryDailyTokens` in `src/shared/learn.ts:112,119`; `LEARN_DEFAULTS = { …, dailyTokens: 50_000, memoryDailyTokens: 200_000, … }` `learn.ts:119`.
- Consumed at `src/main/index.ts:1024` (`budgetLeft` = `memoryDailyTokens − learnDb.runTokens(pid, today(...), "memory")`).
- A background call: `backgroundShot(bg, prompt, signal)` — `src/main/learn/background.ts:75-111`; returns `{ text, tokens }` (reported tokens else `estimateTokens` = chars/4, `:68`); model chosen by `pickBackground()` `:45-65` (uses `oneShot` if available, else a tool-denied plan turn in a temp dir).
- Note: `learn_budget` (`db.ts:261-263`) and its `spent/spend` (`learn/db.ts:241-251`) are a **separate** token ledger from `background_runs`.

## 7. Time zone / date helpers and cron/schedule parsing
- Time-zone-aware APIs: **not found** — grep across `src` for `Intl.DateTimeFormat`, `timeZone`, `getTimezoneOffset` returned no matches.
- Day strings are passed in (e.g. `today(Date.now())` at `index.ts:1024`); the `today` definition itself was **not located** within the budget.
- Cron/rrule parsing: **not found** — no `cron`/`rrule` matches in `src/main`.
- Recurring-timer precedents (`setInterval`), all in main: `src/main/index.ts:653` (limits, 60s), `src/main/limits-refresher.ts:44-51`, `src/main/watchdog.ts:37`, `src/main/mcp-http.ts:67`, `src/main/mcp/router.ts:136` (60s sweep), `src/main/updater.ts:52`.
- No restart/sleep-surviving scheduler exists (no persistence of timers; only `settings.json`, `limits.json` at `index.ts:369-377`).

## Test files
Name-based only (**not opened/verified** — the `**/*.test.ts` listing was truncated at 100 entries and I did not grep tests for `new Store`, `Service`, or `MessageCenter`):
- DB-adjacent: `test/migrate-data.test.ts`, `test/settings-migration.test.ts`, `test/history-fixtures.test.ts`, `test/event-order.test.ts`, `test/streaming-ui.test.ts`, `test/sections.test.ts`.
- Service/turn-adjacent: `test/capabilities.test.ts`, `test/switch.test.ts`, `test/usage.test.ts`, `test/watchdog.test.ts`, `test/fake-openai.test.ts`, `test/harness-driver.test.ts`, `test/inject-regression.test.ts`.
- MessageCenter/inbox: **not found** by filename; no `inbox*.test.ts` was observed.
- **Recommendation**: confirm coverage by grepping tests for `new Store(`, `createThread(`, and `inboxRows`/`MessageCenter` (I did not complete this step).

## Unknowns / gaps
- Exact test-harness temp-store helper and any `Service`/`MessageCenter` test coverage — unverified.
- `today()`/date-format helper definition — not located.
- `open()` (window-creation orchestration), tray check across `src/renderer`, and `SendRequest`/`ThreadEvent` field details — not read.
- No existing automation/schedule/cursor/delivery tables or scheduler were found in the code I read; the closest precedents are `background_runs`, `injection_ledger` (cursor-like state at `db.ts:82-91`), and the renderer `outbox` queue.
