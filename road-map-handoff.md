# Roadmap 13 handoff

Implements `plan/docs/13-harness-optimization-roadmap.md` (the owner's roadmap, 2026-10-17).
- **Where the work lives now:** branch `m4` in the main checkout. `roadmap` was fast-forwarded into `m4` on 2026-10-19 (session 5) and the `../aiharness-wt/roadmap` worktree was removed. Work on `m4` only; `origin/roadmap` is kept for history.
- **Plan:** `.ai/plans/roadmap-13.md` (gitignored, force-added). It lists the points P1.1 … P8.4.
- **Research notes:** `.ai/research_notes/roadmap13-rp{2,3,4}.md`. These are researcher maps of history/IPC, tools/skills/MCP, and memory/context/teams, with file:line references.

**Rules:** one commit per point. Typecheck and the full vitest suite must be green before each commit. At the end of each phase that changes the app runtime, do one live turn each on Claude, Codex and OpenCode (AgentRouter `deepseek-v4-flash`; Zen free rate-limits).

## Session 6 (2026-10-20, Mac): OpenCode ask live-checked, 6 fixes, reply link cards

**Checks on `m4`:** typecheck green, design:check 0 errors, vitest 3114 passed / 0 failed. A lone `mcp-http` "progress heartbeat" failure under full-suite load passed alone (timing flake).

**Live (app, OpenCode on Zen free `opencode/deepseek-v4.1-flash-free` from now on, owner's call; AgentRouter kept returning "sensitive words detected" retries):**
- Item 1 of session 5 is closed:
  - Ask: an edit card and a command card; Deny blocks and the model reports it.
  - Auto-edit: edit silent, command asks.
  - Full: silent.
  - Plan: read-only plan card, unchanged.
  - Team turn in Ask (Software Delivery Team): the member's edit and command each showed a card in the lead's thread; nothing hung.
  - Claude Sonnet and Codex GPT-6-Luna sanity turns with cards.

**Fixed (commits on `m4`):**
- `d9e79ff` **Compact permission card** (owner asked): one row with a tool chip, the command or file, and the buttons. The git-guard note shows only on command cards (`Bash`/`Run`). The plan card shares `.permission-card` but is unchanged (new styles are scoped to `.permission-ask`).
- `62511cd` **OpenCode cards never expire.** OpenCode's embedded Bun 1.3.14 times a plain `fetch` out at 300 s, so a card left unanswered for 5 min blocked the edit ("CubiQ couldn't ask the user…"). The plugin's ask now passes `timeout: false`. Timing test: default `TimeoutError` at 300.0 s, `timeout:false` OK at 320 s. Live: a card left open 331 s, then allowed, applied.
- `2698176` **Plan → "Yes, manually approve edits" asks again.** The implementing round kept the turn's `permissionMode: "plan"`, so the OpenCode plugin deferred (allowed everything) and ACP asks would have denied. The ACP and Codex plan loops now give each round's turn state the round's mode. Two real-OpenCode tests added; live: the edit card now appears after manual approval.
- `eb3066d` **OpenCode git guardrail blocks in every mode without Python.** The app checks every plugin-asked command with `checkCommand(guardScript)` (the script, or the built-in rules), before the mode decides. OpenCode now reports `guardEnforcement: block` whenever its plugin loads. The model receives the guard's reason (`BLOCKED: … git push is blocked …`), not "The user denied". Live: `git push --force` blocked in Full and in Ask; the card says "Git guardrails on".
- `b30f234` **Transcript scroll** (owner report: a short chat scrolled itself down while a turn ran). Pinning was distance-only (< 80 px): an animated wheel scroll's first frames stayed inside that band, and every streamed frame pulled the view back. Now `stillPinned()` (`disclosure.ts`) unpins on any upward move off the bottom, and a wheel-up unpins at once when there's room to scroll. The owner confirmed the fix.
- `dcca245` **claude-e2e test:** newer Claude Code (2.1.304) defers MCP tools behind ToolSearch (the request lists `ToolSearch` + `DeferredToolPlaceholder`), so the test sets `ENABLE_TOOL_SEARCH=false`. Note for the app: Claude turns now reach CubiQ's MCP tools through ToolSearch too (works, fewer tokens).
- `eef6e8f` **Reply links** (session 5's open question; plan `.ai/plans/link-chips.md`). The owner first picked inline chips, then said "doesn't look like ChatGPT" and picked rich link cards. Both shipped:
  - Every https link (labelled or bare) is a chip: favicon or globe, plus the label (the site name when the label is the URL). A 300 ms hover card shows site, title, description and URL.
  - Under each paragraph or list: up to 3 cards with the page's `og:image`, title, a description line and favicon + site.
  - Main: `linkPreviews.meta()` + IPC `ui:link-meta`, the same SSRF rules as card images. Everything is gated by Settings › Load link previews: off, chips show a globe and no cards appear.
  - Built by two opencode workers (Zen DeepSeek, first try); cards added directly.

**Left (in order):**
1. **Windows PC gate** (unchanged from session 5, plus this session's items):
   - the plugin's `fetch` to 127.0.0.1 with `timeout: false` inside OpenCode on Windows;
   - the `file://` plugin URL;
   - the eval `XDG_CONFIG_HOME` override;
   - `tar -xf` in replay's `materializeCase`, CRLF in git output, the scrollbar gutter;
   - the compact card at 900 px; link chips/cards (favicon `.ico` decoding);
   - the guardrail block in Full without Python (the Windows PC has no Python).
2. **Live lesson promotion** (session 5 item 4): needs a case a rule can fix (e.g. the agent also touched a file it was told not to).
3. Optional follow-ups noticed:
   - A plugin ask whose HTTP request is dropped leaves its card up: the server doesn't withdraw a card when the client disconnects. Not seen after the timeout fix.
   - Scripted CDP wheel events didn't scroll the background dev window, so the scroll fix was verified by the owner by hand plus unit tests.

**Scratch state (Mac, safe to delete):** project `vite-proj` (id `c0ffee00-…v17e`) now points at this session's scratchpad repo (`…/c3a6753f-…/scratchpad/vite-proj`; its files `probe.txt`, `team.txt`, `made-by-*.txt`), plus this session's test threads in it.

## Session 5 (2026-10-19, Mac): P8 live checks closed, moved to `m4`

**Checks on `m4`:** typecheck green, vitest 3090 passed / 0 failed; CI (windows-latest) green on `b83913f`.

**Fixed (3 commits):**
- `30e5a91` Optimizer: `cost-unknown` now counts cached trials too. A fully cached, unpriced train run counted 0 of 0 fresh trials and went on to spend blind. It also stops after any validation run that comes back unpriced, since a candidate's `model=` can be unpriced.
- `8285eb1` Self-improve: the revert signal now reads "The user restored these files to how they were before the turn". The draft prompt also explains that a revert usually means a change of mind. The old "Its edits were undone" made DeepSeek draft "re-read the file, the edit didn't stick". Probe: old wording drafted that rule; new wording gave `{"none":true}` 2/2.
- `481aa8f` Evals: Claude, Codex and OpenCode now get the scenario's memory as the `<harness-memory>` block, and Codex and OpenCode get the trial's browser tools over the app's MCP tool server (`cliWiring()` in `evals/lib/agents.ts`). Before, `browser-smoke`, `memory-multi-turn` and `x-memory-correction` always failed on CLI engines. Now 3/3 on OpenCode AgentRouter. Codex `gpt-6-luna` 2/2. Claude Haiku got the memory but misspelled the reversal (a model miss).

**Verified live:**
- **P8 lesson Verify:** case `9e907ccf` (not held out) drafted a candidate on TokenHarbor DeepSeek. Verify replayed it: without 0/1, with 0/1 (5073 + 4355 tokens). It stays a candidate ("its case still fails with it"); transfer is skipped on purpose when the source case decides. A live promotion has **not** been seen yet.
- **P8 optimizer:**
  - A2 (PGS, no `--price`): stops `cost-unknown` after the cached train run.
  - C (OpenCode `agentrouter/deepseek-v4-flash`, `--price 0,0`, `--try effort=high`): train 23/26; baseline and candidate 42 validation trials each; verdict `noise` (gain −0.07, CI −0.19…0.00).
  - B (Zen free) was abandoned: rate limits.
  - Experiments are in `.ai/evals/experiments/opt-recheck-*`.
- **Live turns after the fixes:** Claude Sonnet (edit + revert turns), Codex GPT-6-Luna, OpenCode AgentRouter `deepseek-v4-flash`.

**OpenCode permission fix (plan `.ai/plans/opencode-ask.md`, approved by the owner):**
- **Bug (verified live in the app):** with OpenCode, Ask ("Ask before edits and commands") created a file and ran a command with no card. OpenCode asks over ACP only when its own config says "ask". Its defaults allow edit and bash, and a user's agent (`~/.config/opencode/agent/orchestrator.md`: `edit: allow`, `bash "*": allow`) overrides any injected top-level permission.
- `01118a7` **Phase A:**
  - The OpenCode plugin (`inject/opencode-guard.ts`, now loaded even without Python) asks the app before every edit/write/patch/apply_patch and bash, over `CUBIQ_ASK_URL`/`CUBIQ_ASK_TOKEN`.
  - `acp/ask-server.ts` is one 127.0.0.1 server per driver, with one token per process (= thread).
  - `decidePluginAsk` in `acp/driver.ts` decides by mode: Full allows, Auto-edit allows edits and asks for commands, Ask asks, and Plan defers (unchanged).
  - Fails closed. The git guard still runs first.
  - An approved callID skips OpenCode's own ACP ask for the same call. Verified: ACP `toolCallId` == plugin `callID`, and the test fails with the dedupe removed.
  - Tests: `test/opencode-ask.test.ts`, including 4 real-OpenCode end-to-end runs (fake model).
- `3dbe62d` **Phase B:**
  - OpenCode eval trials use `XDG_CONFIG_HOME=<scratch>` plus only the user's `provider`/`model`/`small_model` (`openCodeEvalConfig`), and load the same plugin.
  - The runner denies any ask that names the user's home outside the trial (`reachesHome`).
  - Live: 5/5 tasks pass on AgentRouter Flash. An Ask-mode `ls ~/.claude/projects` came back "The user denied this command."
- **Checks:** typecheck green, vitest 3090 passed / 0 failed.

**Left (do in this order):**
1. **Live app check of the OpenCode fix** (not done yet; the owner had to leave). Use a vite-proj thread on OpenCode AgentRouter `deepseek-v4-flash`:
   - Ask: "create probe.txt then run cat probe.txt". Two cards should appear (edit, command); Deny blocks.
   - Auto-edit: the edit is silent and the command shows a card.
   - Full: silent.
   - Plan: unchanged.
   - Then a team turn in Ask: member edits/commands show cards and nothing hangs.
   - Then one Claude + one Codex sanity turn.
   - Screenshot the card in dark theme (DESIGN §9).
2. **Windows PC gate:** the OpenCode plugin's `fetch` to 127.0.0.1 inside OpenCode on Windows, `file://` plugin URL, the eval `XDG_CONFIG_HOME` override (OpenCode reads `%USERPROFILE%/.config/opencode` there too), plus the P7/P8 and session 4 items: `tar -xf` in replay's `materializeCase`, CRLF in git output, the scrollbar gutter.
3. **Owner's open question:** "Load link previews" only thumbnails links inside card-list blocks. The owner expects ChatGPT-style chips in normal replies. Ask which shape: inline chips, numbered citations with a hover card, or a sources row.
4. **Live lesson promotion:** needs a case a rule can actually fix. A revert of exactly what was asked is a change of mind and is now skipped. Try a correction, e.g. the agent also touched a file it was told not to.

**Continue on another PC:**
- `git fetch origin && git checkout m4 && git pull`, then `bun install`.
- Check: `bun run typecheck`, `bunx vitest run`.
- Plans and notes are force-added under `.ai/plans/` and `.ai/research_notes/`.
- Eval results (`.ai/evals/`) are local only: not needed to continue.
- OpenCode live turns/evals: AgentRouter `deepseek-v4-flash`. Zen free is rate-limiting. On Windows, start `~/.config/opencode/start-proxy.bat` if nothing listens on :3900.
- The scratch `vite-proj` exists only on the Mac. On Windows use any small git project (add it through the app).

## Session 4 (2026-10-19, Mac)

**Progress:** all 41 points are implemented. Session 4 ran the Mac verification items and fixed what they turned up (8 commits, `b0ed3a4`…`03484b3`). Checks on `roadmap` (Mac): typecheck green, design:check 0 errors, vitest 3067 passed / 0 failed, `--validate-graders` all OK.

**Verified live this session (real app, agent-browser):**
- **P5 browser (Claude sonnet, scratch Vite project on :5183):**
  - The pane auto-opens from closed.
  - `dev_server` status, then `dev_server_start` (asks first, Allow Once), then status shows "owned by CubiQ".
  - `browser_click` with `wait_for` text: "Waited 1516 ms" against a 1500 ms page delay.
  - `browser_report`: 3 PASS + 1 intended FAIL, logs none.
  - Takeover: clicking the overlay mid-turn makes the next `browser_click` refused with "The user took over…"; the lock resets at turn end. Reads (snapshots) still run while taken over, by design.
- **P6 teams:** test teams `live-model-team` (Fact-Checker `model: haiku`) and `live-model-team-oc` (Fact-Checker `model: opencode/glm-5.3-flash-free`) sit in userData `experts/`.
  - Claude: the member ran on `claude-haiku-5-5` (SDK subagent transcript); tooltip "haiku · done · 8.3 s".
  - OpenCode Zen: member session model `glm-5.3-flash-free`, lead `deepseek-v4.1-flash-free` (opencode.db).
  - Codex `gpt-6-luna`: roster says "(uses the lead's model on this agent)".
  - Small asks were answered by the lead with no fan-out on all three engines.
- **DESIGN §9 for P2.1b/P2.3:** a seeded thread "Long transcript (seeded, 400 turns)" in `vite-proj` (3200 events).
  - It opens in 133 ms, windowed (27–83 segments mounted) and pinned to the bottom.
  - The older page loads at the top and holds the reader's place.
  - Light/dark both fine; at 900px no sideways scroll.
  - At 900px the side panel auto-collapses per `clampLayout`. This was already the case, not a P2 change.

**Fixed this session (from the owner's live feedback and the checks):**
- Library category cards: measured to fit one row, so no clipped last card (`b0ed3a4`).
- Team strip: the lead sits in a neutral seat, new token `--portrait-lead` (`b0ed3a4`).
- Transcript disclosures (`3f028fe`, `8e543f2`):
  - Opening or folding keeps the header still. Before, the pinned follow-observer jumped to the bottom, and folding near the end clamped the scroll; now a reserve shrinks as you scroll up.
  - A plain click inside an open tool/work/thinking/subagent block folds it.
  - Tool rows open in one step: no 180 ms height slide, no `content-visibility` placeholder (that caused a +8 px second step).
  - `.thread-scroll` keeps `scrollbar-gutter: stable both-edges`, so the column no longer kicks left when the scrollbar appears.
- Learned tab: a per-project Self-improve On/Off switch (`a1bd391`). It used to say "turn it on in Settings", where no control ever existed.
- Self-improve revert detection: the window's deadline timer never saw an undo, because it fired exactly at expiry and skipped its own watch (`1e70412`). Before, only a next message within 10 minutes caught it.
- Optimizer (`03484b3`):
  - `run.ts --trials-all`. Before, only regression-tagged tasks repeated, so every candidate was rejected as "too-few-trials".
  - It stops with `cost-unknown` after the train run when trials report no cost. `--price <in>,<out>`, or `--price 0,0` for a free model, lets it go on.

**Scratch state on the Mac (safe to delete):**
- Project `vite-proj` (id `c0ffee00-…v17e`), inserted straight into `unskilled.db` because the add dialog is native; folder under the session-4 scratchpad.
- Its seeded long thread and the test threads.
- userData `experts/live-model-team*`.

**Known limits (by design, noted for later):**
- The optimizer wires only the `prompt` (`--guide`) and `model-effort` surfaces; `skill-description` and `retrieval-profile` are rejected with a message.
- Codex reports no cost, so an automation's budget can't pause a Codex run.
- Lessons reach every engine through the frozen memory block (≤ 5 active ones, ranked pinned → helpful−harmful → newest), not per-prompt relevance.
- `dev_server` status trusts a port probe, so it can't tell whose server is listening. In dev, CubiQ's own renderer holds :5173 (Vite's default), and a project on the default port looks "running (not started by CubiQ)".
- Teams are single-engine: a member's `model` picks a model of the lead's engine (Claude alias, OpenCode provider/model); there is no cross-provider team.

**What's in git:**
- `origin/m4`: everything, plus this handoff (`origin/roadmap` stops at session 5's move).
- Under the gitignored `.ai/` (force-added):
  - `.ai/plans/roadmap-13.md`;
  - `.ai/plans/p2.md` … `p8.md`: per-phase plans; p7/p8 hold the ready designs;
  - `.ai/plans/briefs/`;
  - `.ai/research_notes/roadmap13-p{2..8,55}.md`: researcher maps (spot-checked; line numbers drift).

**Set up on another PC:**
1. `git fetch origin`, check out `m4` (it holds all of roadmap), `bun install`.
2. On the Windows PC, remove the old `harness-roadmap` and `harness-roadmap-p2`…`-p6` worktrees (all merged into `m4`).
3. Check: `bun run typecheck`, `bunx vitest run` (the `*-live` tests need `.env` keys), `bun run eval --validate-graders`, `bun run eval --splits`.

**How the parallel tracks ran (Mac, 8 GB):**
- One worktree per track: `git worktree add -b roadmap-pN ../roadmap-pN roadmap`, then `bun install` in it. Don't symlink the main checkout's `node_modules`: `m4`'s copy lacks `quickjs-emscripten`.
- Up to 5 opencode workers at once was fine, started 20 s apart. Each worker got ≤ 5 files with disjoint file sets, so two workers can share a worktree.
- Dispatch on the Mac: `opencode run --agent orchestrator -m opencode/deepseek-v4.1-flash-free "<brief>" --format json < /dev/null`, with the brief starting "Dispatch this immediately with your `task` tool to the `implementer` subagent…". Workers run no shell commands; Claude runs every check.
- Every worker run this session succeeded first time. Claude fixed small issues on review:
  - headless stale-ref matches now use a fresh snapshot;
  - dev-server `stop()` has a pid guard;
  - `dev_server` effect changed to mutate;
  - `--split` defaults to tier full.

**Workers (opencode delegation per CLAUDE.md):**
- The owner wants Zen DeepSeek Flash Free. On the Windows PC that is `--chain opencode/deepseek-v4.1-flash-free,opencode/glm-5.3-flash-free` on oc-run.
- On the Windows PC the free endpoints were flaky (2026-10-18). After 1–2 failed dispatches, implement directly from the brief.

### Windows PC specifics (D:/Cubebis Work/ai-agent/)
- **Local worktrees:** `harness-roadmap` (roadmap), plus `harness-roadmap-p2`…`-p6`. All are merged into `m4` and can be removed (`git worktree remove`); the `roadmap-p6` branch no longer exists on origin.
- **Memory:** on 2026-10-18 the PC ran out of memory with 3–4 opencode workers, a vitest run and Chrome going at once; Claude Code killed the background jobs.
- **Zen key:** the stored key in `~/.local/share/opencode/auth.json` has expired. Free models work without a key, so set `XDG_DATA_HOME` to an empty dir (`D:/ocz-a`…`D:/ocz-h`) so the old key isn't sent.
- **opencode binary:** set `OPENCODE_BIN=C:/Users/laplop/.bun/bin/opencode.exe` (oc-run only looks under npm).
- **Editing:** no Python is installed; use node for scripted edits. Files on disk are CRLF, so normalise `
` before string-replacing.
- **agent-browser:** v0.27, Chrome at `AGENT_BROWSER_EXECUTABLE_PATH`. Spawn `%APPDATA%/npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe` directly and resolve on "exit"; the .cmd shim or a shell pipe hangs on its daemon. The adapter handles this, and `resolveAgentBrowser()` returns "agent-browser" on macOS/Linux.
- **Test baseline:** 7–11 environment failures.
  - Always: TokenHarbor `*-live` tests, codex-e2e, opencode-guard EPERM/timeout, and memory-tool "caps the list" (about 12 s on a 15 s limit).
  - Sometimes: `check`, `switch` and `mcp-router`, with temp-dir EPERM or failures under load; they pass alone.

## Status

| Point | State | Commit |
| --- | --- | --- |
| P1.1 Trial-level cache + experiment identity | done | `470aa04` |
| P1.2 Trial statuses, usage/cost coverage, cost per success, incomplete runs fail | done | `470aa04` |
| P1.3 Run manifest + traces | done | `740df2e` |
| P1.4 Local report | done | `c1ab7fd` |
| P1.5 Grader validation | done | `8d07bde` + fix `f2dff88` |
| P1.6 Multi-turn scenarios | done | `4074952` |
| P1.7 Case set expansion | done | `71b16ee` |
| P1.8 Desktop baseline fixtures | done | `088abd2` |
| P2.1a Paged event reads (main + IPC) | done | `6597a8f` |
| P2.1b Renderer paging | done | `17b4c17` |
| P2.2 Incremental projection | done | `ed0afdf` |
| P2.3 Windowed transcript | done | `4b0c19f` |
| P2.4 Startup | done | `ca003f6` |
| P2.5 Bounded renderer caches | done | `8cce319` |
| P2.6 session.ts async persistence | profiled, no change justified | — |
| P2.7 Board reload by changed path | done | `cca56d8` |
| P3.1 Tool effects | done | `a3b53f1` |
| P3.2 Skill catalog index + search | done | `3aab6b2` |
| P3.3 MCP catalog persistence | done | `0218cf4` |
| P3.4 Result references | done | `00008a1` |
| P3.5 Code-mode pilot (off by default) | done | `cc27d00` |
| P4.1 Background runs accounting | done | `bbeecc2` |
| P4.2 Scope-aware extractor dedupe | done | `6199d02` |
| P4.3 Ranked retrieval + corrections | done | `1a009a2` + `0a1c697` |
| P4.4 Pruning keeps references | done | `573bba6` |
| P4.5 Memory updates once per binding | done | `9d81425` |
| P5.1 Browser auto-open | done | `665281e` |
| P5.2 Backend interface + headless agent-browser | done | `19ce7a8` |
| P5.3 Target ownership + serialization | done | `93cc180` |
| P5.4 Readiness, stale refs, compact observations | done | `98df692` |
| P5.5 Dev-server lifecycle + test reports | done | `b76788a` |
| P6.1 Member model/effort | done | `b65ea92` + `40aa80b` |
| P6.2 Flexible lead guidance + brief template | done | `b3ae1e4` |
| P6.3 Member runs, cost/latency reconciliation | done | `207e08f` |
| P7.1 Records + scheduler | done | `08e3ec8` |
| P7.2 Runner, sources, deliveries | done | `447722d` |
| P7.3 Templates + UI | done | `4d70e62` + `ff1008e` + `89c78fb` |
| P8.1 Splits + sealed holdout + leakage | done | `364eb9f` |
| P8.2 Grader/judge calibration | done | `1598d19` |
| P8.3 Bounded optimizer | done | `903ae93` |
| P8.4 Lesson replay/promotion/retirement | done | `b1872f2` + `14ad77d` |

## Log

### P1.1 + P1.2 — eval trust fixes (2026-10-17)
- `evals/lib/store.ts`:
  - `cacheKey(..., identity)` now includes the runtime version (`EVAL_RUNTIME_VERSION = "2"`), the effort and the grader version. The grader version is a hash of `evals/lib/graders.ts` and `runner.ts`.
  - `findCachedTrials` replaces `findCached`. It returns the reusable trials stored under a key, each counted once by `trialId`, and skips old whole-task cache copies.
  - `assembleTask` merges reused and fresh trials. pass^k needs every requested trial.
- `evals/run.ts`:
  - New `--effort` flag (default `low`).
  - Asking for N trials when k are cached runs N−k.
  - Spend counts fresh trials only.
  - Exits 2 when the run is incomplete: a harness error or cancel, fewer trials than requested, ungraded trials, or tasks that never ran. Before this, a run that stopped early could "match baseline".
- `evals/lib/runner.ts`:
  - Each trial gets a `trialId` and a `status`: passed, failed, harness-error, budget-stop, cancelled or ungraded.
  - Only `passed` counts as a pass. A harness error with passing graders is no longer a pass, and a trial with no graders is `ungraded`.
  - New `usageCoverage` and `costCoverage` fields: reported, estimated or unavailable.
- New `evals/lib/accounting.ts`:
  - measured cost (cached trials included) vs spent now
  - cost per success, weighting cases equally
  - an unknown cost stays unknown
  - `incomplete()`
- Summary footer adds `measured … · spent now … · cost/success …`.
- Old run files still load: the new fields are optional and `statusOf` derives a status for them.
- Checks: typecheck green; vitest 2549 passed / 14 skipped.

### P1.3 — run manifest + traces (2026-10-17)
- New `src/shared/run-trace.ts` (pure, shared by evals and later the app):
  - `RunManifest` v1: origin, requested vs resolved model, effort, versions (harness, graders, runtime, guide, tasks, app, cli), price snapshot, budget, fidelity, platform.
  - `spansOf(timed events)`: tool, child, compaction and check spans.
  - `timeSplit`: tool time with overlaps counted once.
  - `rootTurnEnd`: ignores a member's turn-end.
- `evals/lib/runner.ts` timestamps every event and writes a redacted trace per trial to `.ai/evals/traces/<runId>/<task>-<id>.json`:
  - spans and timed events, plus the native session's model-visible messages
  - the trace path and `toolMs` go on the trial
  - usage now comes from the root turn-end, so a member's turn-end can't stand in for the parent
- `evals/lib/agents.ts`: each engine declares its trace `fidelity`. Native also exposes its session file.
- `evals/run.ts` stores `meta.manifest` and keeps trace folders for the newest 20 runs.
- Checks: typecheck green; vitest 2553 passed.

### P1.4 — local report (2026-10-17)
- New `evals/lib/report.ts`:
  - `caseRow` gives per case: pass rate, statuses, trials vs requested, cached count, mean cost (unknown if any attempt is), p50/p95 latency, trace links.
  - `compareRuns` uses only the shared tasks and lists the setting differences: model, effort, harness, graders, guide, price.
  - `renderReport` writes a self-contained HTML file with light and dark themes.
- `evals/run.ts`:
  - Every run writes `.ai/evals/reports/<run>.html`, compared with the previous run of the same tier and model.
  - `--report [--tier] [--model] [--vs <run.json>]` re-renders the newest run with zero tokens.
- `formatCost` shows "unknown" when no attempt has a cost, never `$0`.
- Verified on the real 2026-10-15 run files in the main checkout's `.ai/evals`. The worktree has `.ai/evals` symlinked to the main checkout's `.ai/evals`.

### P1.5 — grader validation (2026-10-17)
- New `evals/lib/validate.ts`: `validateTask` grades a **no-op** (bare fixture, empty transcript), which must fail, and the **reference**, which must pass.
  - The reference is `evals/references/<task>.json`: `edits`, `write`, `delete`, transcript `events` and `skills`.
  - It is laid over `<fixture>.reference/` when that folder exists.
- `bun run eval --validate-graders [--task ids] [--verbose]` runs it with zero model calls. It exits 1 on any problem.
- Validation found 4 tasks whose graders passed a no-op. They are fixed:
  - `explain-no-edit`, `route-none-1`, `route-none-2`: new answer graders
  - `honest-test`: the test-suite grader is now required
  - Their cache keys change, so they rerun next time.
- 25 references now exist. 9 code-task references were written by 2 Zen DeepSeek implementer workers and reviewed by Claude: minimal, honest fixes.
- `test/eval-tasks.test.ts` pins it: every task's no-op fails and its reference passes, and a weak task gets flagged.

### P1.6 — multi-turn scenarios (2026-10-18)
- `Task` gains `reply`, `turns[]`, `memory`, `mcp { servers, tools, seed }` and `requires` (browser/team).
- `runTrial` runs the turns in order on one session (the next `TurnInput.sessionId` is the one `onSession` reported). The budget covers the whole trial, and usage/cost/steps sum every root turn-end, so single-turn results are unchanged. `reply` answers `requestUserInput`.
- `mcpKit(task)` turns `generate()` into stdio `McpServerEntry`s plus sentinel → "server/tool".
  - Native evals wire them through the app's `routerTools` + `McpToolsCache` + `McpClientPool` (`evals/lib/agents.ts`).
  - CLI engines get them through `TurnInput.mcpServers`.
  - The scenario memory is native-only.
- New `mcp` grader: each expected tool's sentinel came back. References can list `mcp: [...]`.
- New tasks:
  - `memory-multi-turn`: memory plus 2 turns.
  - `mcp-lookup`: `mock-frontend/seed_react`.
  - `browser-smoke` and `team-review` carry `requires`. Run and validate print "skip …: unavailable in the eval runner" for them; they don't count as incomplete.
- `validate.ts` normalises CRLF before applying reference edits, which fixes add-cli-flag/agents-md-rules on Windows checkouts.
- Tests: multi-turn session reuse + summed usage, memory reaches the system prompt, reply/dismiss, mcpKit, the mcp grader, and an end-to-end run where a real mock stdio MCP server is called through the router.
- Implemented by a Zen deepseek-v4.1-flash-free implementer worker; Claude reviewed the diff and added the end-to-end MCP test.
- Checks: typecheck green; `--validate-graders` exit 0 (27 OK, 2 skipped); vitest 2583 passed, 9 failed. All 9 failures are environment-only and in the baseline list above; there were 11 on the clean tree.

### P1.7 — case set expansion (2026-10-18)
- 20 new capability cases (tier full), each with `suite` and `difficulty` (new optional `Task` fields; old cache keys are unchanged) and a reference that passes while the no-op fails.
  - **coding `c-*`:** multi-file feature, async in-flight race, diagnosis two calls from the failing test, legitimate test update, signature change with 3 callers, ENOENT-vs-bad-JSON, O(n²) dedupe (200k items in a 2 s child process), UTC day key (child process with TZ), minimal diff in a 162-line file, and a negative control (the claimed bug isn't real).
  - **`x-*` cases:**
    - context: a turn-1 constraint recalled at turn 4; a read in turn 1, then an edit in turn 2.
    - memory: preference, correction, stale fact vs repo, and an irrelevant-memory negative control.
    - skills: 200-skill catalog; a direct-answer negative control.
    - mcp: tool unavailable (near-miss `audit_terraform`); 3 React tools to disambiguate.
- Written by 2 parallel Zen deepseek-v4.1-flash-free implementers. Claude reviewed every prompt and grader and checked the MCP and skill claims against `generate()`.
- Checks: typecheck green; `--validate-graders` exit 0 (47 OK, 2 skipped); vitest 2606 passed, 10 failed. The failures are the environment list plus an `mcp-router` closeAll timing flake under load, which passes alone.

### P1.8 — desktop baseline fixtures (2026-10-18)
- New `scripts/history-fixtures.ts`: `makeHistory({ events, seed, subagents })` gives byte-identical seeded threads.
  - Shape: turns of about 40 events with tool-use/result pairs, 2–20 KB payloads, about 10% errors, and notices.
  - Child events hang off a root `task` call. `reasoning-summary` is live-only, so it is stored as opaque thinking.
  - Presets: small 200, long 10k, huge 50k. `seedStore()` adds the big thread plus extra projects of small threads, every third one archived.
- New `scripts/profile-history.ts --preset … --runs N --json .ai/profiles/<name>.json`.
  - Times `listEvents` (cold after reopen, then warm), `listThreads` for every project, and `segmentEvents`; also records event bytes and heap/rss for huge.
  - Under bun it calls `Bun.gc` before removing the temp dir, because Windows keeps the WAL locked.
- `tsconfig.node.json` includes `scripts/**/*` (composite project: the test imports the fixture script).
- Baseline on the Windows PC (`.ai/profiles/history-baseline.json`, not committed), warm p50:
  - listEvents: 10k 104 ms / 50k 636 ms (45 MB of event JSON)
  - segmentEvents: 10k 5–8 ms / 50k 33 ms
  - listThreads: about 10 ms for 21 projects
- So P2.1 (paged reads) is the big lever.
- Checks: typecheck green; vitest 2607 passed, 9 failed, all environment-only.

### P3 + P4 merged into roadmap (2026-10-18)
- **P3 (lazy capability discovery):**
  - P3.1: `HarnessTool.effect` and `LoopTool.parallel` separate scheduling from permission. Mutating auto-allowed tools (browser_open/click/type, memory_write, team_write/post/board, ask_user, design_critique_save) no longer run in parallel. `readOnlyHint` goes to Claude and the HTTP MCP server.
  - P3.2: past 40 skills or 6k chars, the skill tool becomes a names-only index with BM25 `query` search (`src/main/search/bm25.ts`). At 200 skills the description shrinks from 37.6k to 4.8k chars.
  - P3.3: MCP tool listings are persisted by spec hash (no secrets) in `userData/mcp-tools-cache.json`, so a cold start still shows the index. search_tools reports unreachable servers separately from "no match".
  - P3.4: app/MCP/browser tool text goes through `bound()`; added `savedOutputOf`; `harness-output` files are pruned after 14 days.
  - P3.5: `Settings.codeMode = "on"` gives the native agent `run_code` (QuickJS via `quickjs-emscripten@0.32.0`, pinned). Every inner call is authorized and shown as a child row, a refused one included. Packaging of the WASM file under electron-builder is not tested yet.
- **P4 (context, memory, background spending):**
  - P4.1: `background_runs` table; memory extraction is accounted, capped by `learn.memoryDailyTokens` (200k), and uses the explicit background model when one is set.
  - P4.2: the extractor sees global notes as `global/<file>` and merges same-name or near-duplicate adds.
  - P4.3: `.meta.json` correction sidecar; corrections come first; BM25 `memory_read`; `supersedes` removes the stale note.
  - P4.4: pruned results name their saved full output (written at prune time if needed); `retentionFor(contextSize)`.
  - P4.5: a resumed session gets one `<memory-update>` note per memory change, and its cached system prompt is left unchanged.
- **Checks on merged roadmap:** typecheck green; vitest 2690 passed, 9 failed (all environment-only); `--validate-graders` exit 0.

### P2 merged into roadmap (2026-10-18)
- P2.1a: `Store.listEventsPage` returns a turn-aligned page (23 ms vs 1.6 s at 50k events). `threadTotals` uses one SQL pass with the same rules as UsageMeter. IPC `events:page` and `thread:totals` are new; `events:list` is kept.
- P2.1b: threads open on a 1,500-event page plus totals. Older pages load on scroll or the quiet "Show earlier messages" button, and the scroll position is held. Live events merge by seq. UsageMeter and the expert counts use the totals.
- P2.2: `createSegmenter` caches closed turns, so a live event re-segments only the open tail (append at 50k: 10 ms vs 50 ms).
- P2.3: past 200 segments only the visible rows mount, with measured spacers and scroll anchoring. The last 20 segments stay mounted while you're pinned to the bottom.
- P2.4: `listAllThreads` (one query) runs alongside the boot calls, and the selected thread opens before the branch lookups.
- P2.5: the 8 most recently selected threads keep their caches; selected, running and waiting threads are never evicted. A live event for an unloaded background thread no longer creates a one-event list.
- P2.6: profiled on the Windows PC. A sync append takes 0.3–0.6 ms per model step (p95 under 1 ms); load/replace of a 10 MB session takes 20–30 ms. No async rewrite was made: there's no measurable win, and sync keeps crash-safe ordering.
- P2.7: watcher bursts carry the changed paths. An `.html` page edit remounts only its artboard; any other file or an unknown change reloads all of them. If more than one change is missed between renders, everything reloads.
- **Still owed:**
  - the real-app check of P2.1b/P2.3 (DESIGN §9: light/dark, 900px, keyboard, screenshot);
- **Checks on merged roadmap:** typecheck green; design:check 0 errors; vitest 2745 passed, 9 failed (environment-only); `--validate-graders` exit 0.
- Live turns on merged roadmap (2026-10-18, eval runner, task explain-no-edit, all PASS with score 1.00):
  - Claude haiku (CLI 2.1.302): $0.12.
  - Codex default (CLI 0.160.0): cost not reported.
  - OpenCode Zen `deepseek-v4.1-flash-free` (1.18.34): $0.00, run with a key-less `XDG_DATA_HOME`.
- Still owed: the real-app UI check (DESIGN §9) for P2.1b/P2.3; it needs someone at the running app.

### P5.1–P5.3 on branch roadmap-p5 (2026-10-18)
- P5.1: `gated()` calls `BrowserController.ensureOpen()`: the pane opens itself (via the existing `browser-open` broadcast) and waits for attach plus its first load. A failure reads "Couldn't open the browser pane: …", and `openTimeoutMs` can be injected.
- P5.2: `src/main/browser/backend.ts` adds the `BrowserBackend` interface, `visibleBackend(controller)`, and `asBackend`. `browserTools()` accepts either a backend or a controller.
  - `src/main/browser/agent-browser.ts` is the headless `AgentBrowserBackend`: one session per job, a version gate (0.27 ≤ v < 1.0), and snapshots in the pane's `[eN] role "name"` shape.
  - Evals: tasks that require `browser` now run on a fresh headless session per trial (skipped only when the CLI is missing). `browser-smoke` uses a self-contained `data:` page, and a real end-to-end test passes on this PC.
- P5.3: `TargetLock` in tools.ts. Page-changing tools (open, click, type, eval) queue per target. The last acting thread owns the pane, and while its turn runs (`service.isRunning`) another thread's action is refused with a clear message. Reads stay open to everyone.
- Checks: typecheck green; vitest 2705 passed, 10 failed (environment-only); validate-graders exit 0.
- P5.1–P5.3 merged into roadmap (2026-10-18): typecheck green; vitest 2761 passed, 9 failed (environment-only); validate-graders exit 0.

### P6.1 — member model/effort (2026-10-19, Mac)
- Done on a `roadmap-p6` worktree after `git merge roadmap`, then merged back into `roadmap` (branch since deleted). The WIP `b65ea92` was reviewed and kept as-is; `40aa80b` adds the rest.
- Member frontmatter `model` (id-safe, ≤ 120 chars) and `effort` (low/medium/high) reach `TeamAgent`.
  - Claude: SDK agent `model`. OpenCode: agent `model`. Codex: ignored.
  - Native: the driver's `routeFor(modelId)` resolves the member's own provider entry (route, wire id, reasoning). Effort is passed only when that model reasons. A model the provider doesn't list runs on the lead's, and the result ends "(ran on <lead>: <model> isn't offered by this provider)".
- UI: the ExpertDetail roster shows "<model> · <effort>" in mono tertiary. The team strip tooltip names what a member actually runs on for the thread's agent, with "(uses the lead's model on this agent)" on Codex. Tooltips are unchanged for members without a model.
- Tests: catalog parsing, teamAgents, the label/note helpers, Claude SDK agents, OpenCode injection, unchanged Codex roles, task-tool route/model/effort/fallback, a native driver end-to-end (mutation-checked), the roster line, and the strip tooltip. Written by a Zen DeepSeek implementer and Claude; Claude reviewed the diff.
- Checks (Mac): typecheck green; design:check 0 errors; vitest 2784 passed, 1 failed (c-perf-quadratic, fixed in `2fddc24`).
- Owed at P6 end: a live team turn on Claude, Codex and OpenCode Zen with a member that sets `model`, plus a dark-theme screenshot of the roster line.

### P5.4 — readiness, stale refs, compact observations (2026-10-19, Mac)
- `backend.ts` holds the shared contract.
  - `WaitFor { url, selector, text, timeoutMs }`: 5 s default, 30 s max.
  - `waitScript`/`waitUntil`: one in-page promise, retried across a navigation until the deadline. `waitNote` writes the result line.
  - Also `SnapshotOptions` + `scopeLines`, `staleRefMessage`, and `NO_LOGS`/`NO_NEW_LOGS`.
- Tools:
  - browser_open/click/type take `wait_for`. With it, the pane skips the fixed 250 ms settle and waits on the condition. The result gains "Waited N ms for …" or "…: not met. Now at <url>". Without it, nothing changes.
  - browser_snapshot takes `selector` and `interactive`; browser_logs takes `new_only`. Defaults are unchanged.
- Visible pane:
  - collectPage keeps an element's ref across snapshots and numbers new ones from the controller's counter, which never resets (not even on navigation). A ref is never reused.
  - A gone ref takes a fresh snapshot and names the same kind+name match without acting on it. A hidden one says so.
- Headless:
  - agent-browser renumbers e1… on every snapshot (probed on 0.35.2). The adapter hands out its own offset refs mapped to the latest snapshot.
  - A stale ref gets the same message, with matches taken from a fresh snapshot.
  - `snapshot -i -s` serves scope and interactive; console/errors counts serve new_only.
- Tests:
  - `test/browser-readiness.test.ts` covers the helpers and a fake-CDP controller (wait vs settle, ref counter, stale through the tool, log deltas over a full buffer). It also runs collectPage in a real page through agent-browser: stable refs, a replaced node gets a new ref, scope, delayed text.
  - The agent-browser real-session test now runs on macOS/Linux too.
- The headless half was written by a Zen DeepSeek implementer. Claude made its stale-ref lookup use a fresh snapshot and fixed the tests.
- The browser skill doc mentions the new options and the auto-opening pane.
- `2fddc24`: c-perf-quadratic's hidden test is 400k items (200k unique). The quadratic no-op took 1.0 s on the Mac and passed; now it takes about 7.9 s and fails, while the reference stays in ms.

### 2026-10-19 (Mac): P5.5, P6.2, P6.3, P7.1, P8.1, run as parallel worktrees
- **P5.5 `b76788a`:**
  - `src/main/devserver/`:
    - detect: package.json dev/start/serve/preview, a port read from the script or the tool's default, the package manager from the lockfile;
    - registry: a POSIX process group / Windows killPidTree, ready when the port opens, the output tail on failure;
    - tools: `dev_server` (status/stop, auto) and `dev_server_start` (asks first, through the normal policy).
  - Only owned servers stop; all of them are stopped on before-quit.
  - `browser_report` (8th browser tool): text/url/selector/value/count checks run in one in-page script through the new `backend.query` (no takeover check, no action announced), with PASS/FAIL plus actual values, logs and an optional screenshot.
  - The browser skill doc covers both.
  - Checked for real: `npm run dev` on a temp project started, then stopping it killed the whole tree.
- **P6.2 `b3ae1e4`:**
  - TEAM_LEAD_PROTOCOL: size the request first. Answer small asks directly; a narrow ask goes to one member; phases only when a step needs another's result. Briefs list objective, inputs, outcome, evidence, boundaries and stop condition; dependents get file names.
  - Member replies name their evidence.
  - The software-delivery, product-launch and research-report teams' "How you work" now match the team to the ask instead of always fanning out.
- **P6.3 `207e08f`** (on top of the m4 merge `945a881`):
  - The tool-result event gains `runUsage` (a subagent call's own tokens/cost). The meters never sum it.
  - Native: each child is priced on the model it ran on (`costOf(u, wire)`). The turn-end cost is the lead's own cost plus each child's, so a P6.1 member on a pricier model is no longer billed at the lead's rate.
  - `src/shared/team-runs.ts`: `memberRuns` (done/failed/stopped/running, latency, usage) and `memberTotals`.
  - The TeamStrip tooltip lists a member's latest 3 runs.
  - Claude/Codex/OpenCode don't report per-member usage yet; their rows show status and latency only.
- **P7.1 `08e3ec8`:**
  - schedule.ts: Intl-only time zones. A DST gap runs at the first valid minute; an overlap runs at the first occurrence. Missed runs coalesce; run keys are unique.
  - Migration 29 plus AutomationStore: `claimRun` is INSERT OR IGNORE, so a restart or wake can't duplicate a run (tested across a DB reopen). A cursor moves only via confirmSource; a failed source keeps its bookmark. Deliveries go intent → published → confirmed/unknown.
  - Not wired into the app yet (P7.2).
- **P8.1 `364eb9f`:** evals splits, `--split` / `--release` / `--splits`. The holdout is sealed unless `--release` is given.
- **Merged `roadmap`:** vitest 2899 passed / 0 failed.

### P7.2 + P7.3 — automations runner, templates, UI (2026-10-19, session 3)
- `src/main/automations/`:
  - `runner.ts`: tick/claim by run_key, one run at a time behind interactive turns, lease renewal, waiting-input tracking, budget → paused-budget.
  - Delivery: intent → published → confirmed; failed delivery → partial.
  - The cursor moves only after confirm; the text and cursor advances are checkpointed before delivery.
  - `recover()`: interrupts every in-flight run at startup, re-queues claimed-but-unstarted runs, finishes a cut-short delivery, never blind-reposts an unknown one.
  - `sources.ts` (git log, CRLF-safe), `destinations.ts` (Message Center), `io.ts`.
  - `app.ts`: Service wiring, sendAndWait waits through check-fix rounds, IPC overview/save/delete/run-now/runs.
  - `templates.ts`: repo health, browser smoke, project brief (git source), eval regression, custom.
  - Migration 30 adds `automations.permissions`.
- UI:
  - Library → Automations: list, editor (template, schedule, days, missed policy, agent/model, permissions, budget, enabled), Run now, two-step Delete.
  - Message Center: needs-you rows for paused/failed/interrupted/partial runs; finished rows tagged "Automation".
- Manual Run now works on a disabled automation; disabled only stops the schedule.

### P8.2 + P8.3 + P8.4 — judge, optimizer, lesson lifecycle (2026-10-19, session 3)
- **P8.2:** `evals/lib/judge.ts`.
  - A judge counts only with a calibration ≥ 0.85 accuracy on ≥ 10 examples for the same rubric; otherwise the trial is ungraded.
  - An unreadable reply counts as a miss. Pairwise mode is blinded and order-randomized; agreement is Cohen's kappa.
  - Flags: `--calibrate-judge <name>`, `--stability N`.
- **P8.3:** `evals/lib/optimize.ts` + `evals/optimize.ts` (`bun run eval:optimize`).
  - Decisions use a paired bootstrap CI over tasks. Verdict order: stale, too-few-trials, regression, noise, cost, latency, accept.
  - Train failures are graders' whys only; the holdout runs only with `--release`; every round is saved.
  - `run.ts`: `--guide <file>` (its hash joins the cache key), `--out <file>`.
- **P8.4:**
  - `learn/lifecycle.ts`: active lessons go into the memory block (`<harness-lessons>`), and injected ids flow into the turn record.
  - Counters: helpful/harmful/relevant counted once per final turn; auto-retire when harmful ≥ 3 and > 2× helpful.
  - Retire/undo/pin/drop. At startup, active lessons verified on another background model or app minor version go back to candidate.
  - `learn/replay.ts` + `verify-app.ts`: rebuild the case tree (git archive of headSha + base overlay − deleted), runTrial on the background agent without and with the lesson, transfer on ≤ 3 other cases (held-out first).
  - Replays are cached, budgeted by `learn_budget`, and promote only with both pieces of evidence.
  - Library → Learned tab.
