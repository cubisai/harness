# Roadmap 13 handoff

Implements `plan/docs/13-harness-optimization-roadmap.md` (the owner's roadmap, 2026-10-17; untracked in the main checkout, read it there).
- **Where this file lives:** committed at the worktree root. The main checkout's `road-map-handoff.md` is a symlink to it, so it's visible from both.
- **Worktree:** `../aiharness-wt/roadmap`, branch `roadmap`, cut from `m4` @ `5537a27`. The main checkout's `m4` has another session's uncommitted TGP work, so nothing here touches it. Merge `roadmap` into `m4` once that work is committed.
- **Plan:** `.ai/plans/roadmap-13.md` in the main checkout (gitignored). It lists the points P1.1 … P8.4.
- **Research notes:** `.ai/research_notes/roadmap13-rp{2,3,4}.md`. These are researcher maps of history/IPC, tools/skills/MCP, and memory/context/teams, with file:line references.

**Rules:** one commit per point. Typecheck and the full vitest suite must be green before each commit. At the end of each phase that changes the app runtime, do one live turn each on Claude, Codex and OpenCode Zen.

## Resume here

Next point: **P1.7, case set expansion** (about 20 new cases, each with a reference and a validator pass), then P1.8 (10k/50k-event history fixtures plus `scripts/profile-history.ts`).
- **Workers on the Windows PC:** Zen's free models (`opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free`) work without a key. The stored Zen key in `auth.json` has expired and is sent anyway, so dispatch with `XDG_DATA_HOME` pointed at a short empty dir and `OPENCODE_BIN=C:/Users/laplop/.bun/bin/opencode.exe` (oc-run only looks under npm), plus `--chain opencode/deepseek-v4.1-flash-free,opencode/glm-5.3-flash-free`.
- **Baseline on that PC:** the full suite has about 9–11 environment failures on a clean tree: TokenHarbor live tests, codex-e2e MCP, opencode-guard EPERM/timeout, and load timeouts. Compare failing files against that list, not against zero.

## Status

| Point | State | Commit |
| --- | --- | --- |
| P1.1 Trial-level cache + experiment identity | done | `470aa04` |
| P1.2 Trial statuses, usage/cost coverage, cost per success, incomplete runs fail | done | `470aa04` |
| P1.3 Run manifest + traces | done | `740df2e` |
| P1.4 Local report | done | `c1ab7fd` |
| P1.5 Grader validation | done | `8d07bde` + fix `f2dff88` |
| P1.6 Multi-turn scenarios | done | (this commit) |
| P1.7 Case set expansion | | |
| P1.8 Desktop baseline fixtures | | |
| P2–P8 | not started | |

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
