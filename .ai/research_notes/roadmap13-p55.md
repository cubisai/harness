Researcher output (raw):

**1. Native harness shell commands**
- `bashTool` declared at `src/main/harness/tools/bash.ts:51`; `access: "shell"` at `:65`. Guard check via `checkCommand` before spawn at `:76`; spawn at `:84` (`detached: platform !== "win32"`, `stdio: ["ignore","pipe","pipe"]`).
- Timeouts: `DEFAULT_TIMEOUT_MS=120_000`, `MAX_TIMEOUT_MS=600_000` (`bash.ts:12-13`); clamped at `:78`; timer fires `killTree` at `:126-129`.
- Kill: inline `killTree` at `bash.ts:104-125` (POSIX `process.kill(-pid,"SIGTERM")` then `SIGKILL` after 2s; Windows `taskkill /T /F`). Abort handling `:130-134`.
- No true background/long-running support: a `server &` is handled by settling 250ms after shell `exit` (`bash.ts:162-167`). Output bounded to 10MB in memory (`:15,:95-98`).
- `shellFor` picks bash/sh or Git Bash/PowerShell (`bash.ts:25-42`).
- `winspawn.ts`: `spawnCommand` `:57-64`; `launchSpec` `:48-54`; `killTree(child)` `:86-93` (Windows taskkill, else `child.kill()`); `killPidTree(pid)` `:101-111`; `execCommandSync` `:67-78`.
- `terminal.ts`: `TerminalManager` class `:27`; `open` (node-pty) `:32-52`; `close` `:66-69`; `dispose` `:71-74`; `defaultShell` `:7-15`.
- Tests: `test/harness-tools-bash.test.ts` (bashTool, incl. `sleep 30 &` at :76), `test/winspawn.test.ts`.

**2. Permission / autoAllow / effect / access**
- Harness (app) tools: `HarnessTool` interface — `name, description, input, autoAllow, effect?: "read"|"mutate", run(args, ctx?)` — `src/main/agents/types.ts:32-41`. `ToolContext` `{ projectId?, threadId?, signal? }` `:19-25`.
- Native tools: `NativeTool` with `access: ToolAccess` (`"read"|"edit"|"shell"|"web"|"other"`) `src/main/harness/tools/types.ts:7,47-59`.
- Verdict logic: `decide(mode, access, outside)` `src/main/harness/permissions.ts:11-23`; refusal text `:26-29`.
- Authorize path: `authorize()` in `src/main/harness/driver.ts:427-433` (decide → allow/deny → `input.requestPermission({toolName, summary, canAlwaysAllow:true})`). Passed into `runLoop` at `:495`. Loop invokes it at `src/main/harness/loop.ts:266`.
- Mapping app tool → LoopTool: `appLoopTool` `driver.ts:551-579`; `access: tool.autoAllow ? "read" : "edit"` `:563`; `parallel: tool.effect ? tool.effect==="read" : tool.autoAllow` `:565`; run passes ctx `{projectId, threadId, signal}` at `:573`.
- code-mode broker also authorizes every inner call: `driver.ts:379-406`.
- CLI tool server: `startToolServer(...)` in `src/main/mcp-http.ts:139-229`; registers each HarnessTool with `effect` → `readOnlyHint` annotation, ctx from `?p=`/`?t=` query (`:164-166,:195-205`). Wired in `src/main/index.ts:553-567` (`getToolServer`). Claude uses an in-process MCP server: `harnessToolOptions` `src/main/agents/claude.ts:43-56` (`allowedTools` = autoAllow names). Codex/ACP take it over HTTP (`index.ts:594,612`).
- Tests: `test/harness-driver.test.ts` (:124,673), `test/harness-loop.test.ts` (:392-397 decide), `test/mcp-http.test.ts`, `test/mcp.test.ts`, `test/codex.test.ts` (:1123), `test/questions.test.ts`.

**3. Per-thread tool list assembly**
- `browserTools(browser, {busy})` `src/main/index.ts:441`; `memoryTools` `:443`; `allTools` `:445`.
- `harnessTools(thread?)` `src/main/index.ts:543-549` (adds design/team tools). Passed to `Service` at `:770`.
- Consumed per turn: `service.ts:754` (fingerprint), `:818` (`tools:` in `driver.runTurn`) and `:467,:497` (handoff). Also `index.ts:1368` (context preview).
- Thread id / cwd flow: `TurnInput.threadId`/`cwd` `src/main/agents/types.ts:47-49`; set in `service.ts:805-806`. App tools receive `{projectId, threadId, signal}` (`driver.ts:573`); native tools get `cwd` via `toolCtx` (`driver.ts:313-323`). Over MCP the server derives them from `?p=`/`?t=` (`mcp-http.ts:164-166,195`).
- Tests: `test/context-preview.test.ts`, `test/harness-driver.test.ts`, `test/harness-tools-*.test.ts`.

**4. Browser tools**
- Tool list `browserTools` `src/main/browser/tools.ts:88-181` (browser_open/snapshot/click/type/eval/logs/screenshot). `TargetLock` `:31-56`.
- Backend contract `BrowserBackend` `src/main/browser/backend.ts:26-40`; `screenshot(): Promise<{path, png: Buffer}>` `:38`. Result shape: tools return `ToolOutput {text, imagePng?, isError?}` (`tools.ts:6-12`).
- Readiness helpers (P5.4): `waitUntil` `backend.ts:73-87`, `waitScript` `:54-61`, `waitNote` `:90-93`.
- Screenshot save: `BrowserController.screenshot` `src/main/browser/controller.ts:455-465` (mkdir `screenshotDir`, write `browser-<iso>.png`, push to `this.shots`, emit). `listScreenshots` `:468-470`. Headless: `agent-browser.ts:275-278`.
- Reference/serving: `shotsDir` + `shotInfo()` → `unskilled-shot://` URL `src/main/index.ts:228-235`; `ScreenshotInfo` `src/shared/types.ts:1027`.
- Saved-output helper: `bound()` and `savedOutputOf()` in `src/main/harness/tools/bound.ts:15-44` (`BOUND_NOTE`, `.txt` files in `outputDir`, `pruneOutputDir` `:51`). No `harness-output` path found.
- No `browser_report` tool and no assertion/actual/logs-summary structured result found (not found).
- Tests: `test/browser.test.ts`, `test/browser-readiness.test.ts`, `test/agent-browser.test.ts`, `test/bound.test.ts`.

**5. Shutdown hooks**
- `app.on("window-all-closed")` `src/main/index.ts:1715-1717`; `app.on("before-quit")` `:1718-1732`.
- Owned resources killed there: `service.dispose()` `:1722`, `terminals.dispose()` `:1726`, `toolServer.close()` `:1728`, `mcpPool/mcpGateway.closeAll()` `:1729-1730`.
- `TerminalManager` created at `index.ts:1587`, disposed at `:1726`; `probe.dispose()` in smoke path `:1642,:1655`.
- No `will-quit` handler found. No owned-dev-server registry exists yet (not found).
- Tests: `test/watchdog.test.ts`, `test/agent-browser.test.ts` (no index-level shutdown test found).

**6. Port probing / HTTP readiness**
- No `net.connect`, `createConnection` or `waitForPort` anywhere (not found).
- Closest helpers: `probeMcpUrl` (fetch with per-request AbortController timeout) `src/main/mcp/probe.ts:48-62,181-256`; in-page `waitUntil` polling `src/main/browser/backend.ts:73-87`.
- Local servers bound: `startToolServer` `http.listen(0,"127.0.0.1")` `src/main/mcp-http.ts:220-225`; OAuth loopback `server.listen(port,"127.0.0.1")` `src/main/mcp/oauth.ts:136-139`.
- URL normalization for localhost: `src/main/browser/url.ts:11-16`.
- Tests: `test/mcp-probe.test.ts`, `test/browser-readiness.test.ts`.

**Unknowns / not found**
- No existing dev-server detection (`package.json` scripts parsed anywhere? not found), no owned-process registry, no `browser_report`/assertion-result type, no port-probe helper. These are greenfield for the feature.
- `will-quit` not present. `effect` only on `HarnessTool` (app tools); native `NativeTool` has no `effect`, only `access`.

Note: the researcher hit its step limit before completing every search in the brief, so the "not found" items in sections 4–6 are lower-confidence than the file:line citations. If you want, I can dispatch a follow-up pass to close those gaps (no `browser_report`/port-probe/dev-server-detection, `will-quit`, `harness-output`) before any implementation work.
