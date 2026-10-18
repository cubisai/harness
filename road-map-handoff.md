# Roadmap 13 handoff

Implements `plan/docs/13-harness-optimization-roadmap.md` (the owner's roadmap, 2026-10-17; untracked in the main checkout, read it there).
- **Where this file lives:** committed at the worktree root. The main checkout's `road-map-handoff.md` is a symlink to it, so it's visible from both.
- **Worktree:** `../aiharness-wt/roadmap`, branch `roadmap`, cut from `m4` @ `5537a27`. The main checkout's `m4` has another session's uncommitted TGP work, so nothing here touches it. Merge `roadmap` into `m4` once that work is committed.
- **Plan:** `.ai/plans/roadmap-13.md` in the main checkout (gitignored). It lists the points P1.1 … P8.4.
- **Research notes:** `.ai/research_notes/roadmap13-rp{2,3,4}.md`. These are researcher maps of history/IPC, tools/skills/MCP, and memory/context/teams, with file:line references.

**Rules:** one commit per point. Typecheck and the full vitest suite must be green before each commit. At the end of each phase that changes the app runtime, do one live turn each on Claude, Codex and OpenCode Zen.

## Resume here

- **P1–P4 are done and merged into `roadmap`.**
- **P5:** in worktree `../harness-roadmap-p5` (branch `roadmap-p5`). P5.1 is done (`665281e`); P5.2 is next. Its brief is in `.ai/tmp/p52.brief.txt` there, built on measured agent-browser facts.
- **P6:** in worktree `../harness-roadmap-p6` (branch `roadmap-p6`). P6.1 has uncommitted, unverified partial edits; review them before reusing.
- **Memory:** on 2026-10-18 the Windows PC ran out of memory with 3–4 workers, a vitest run and Chrome going at once. Run one track at a time there.
- **Still owed after the P2 merge:**
  - one live turn each on Claude, Codex and OpenCode Zen;
  - the real-app UI check for P2.1b/P2.3 (DESIGN §9: light/dark, 900px, keyboard, screenshot).
- **Then:** P5 and P6 (they can run in parallel worktrees), P7, then P8.
- **Workers on the Windows PC:**
  - Zen's free models need `XDG_DATA_HOME` pointed at a short, empty, key-less dir (e.g. `D:/ocz-a`).
  - Also set `OPENCODE_BIN=C:/Users/laplop/.bun/bin/opencode.exe` and `--chain opencode/deepseek-v4.1-flash-free,opencode/glm-5.3-flash-free`.
  - The free endpoints sometimes drop connections ("Task cancelled", "Endpoint is unavailable"): retry, or finish the point yourself.
- **Baseline on that PC:** about 7–11 environment failures (TokenHarbor live tests, codex-e2e, opencode-guard EPERM/timeout, and the memory-tool 70-note test near its 15 s limit). `check`, `switch` and `mcp-router` can fail under load but pass alone.
- **Research notes** for P2–P4: `.ai/research_notes/roadmap13-p{2,3,4}.md` (gitignored, Windows PC).

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
| P5.1 Browser auto-open | done (branch roadmap-p5) | `665281e` |
| P5.2–P5.5, P6, P7, P8 | not started / in progress | |

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
  - the live turns on Claude, Codex and OpenCode Zen for P2–P4.
- **Checks on merged roadmap:** typecheck green; design:check 0 errors; vitest 2745 passed, 9 failed (environment-only); `--validate-graders` exit 0.
