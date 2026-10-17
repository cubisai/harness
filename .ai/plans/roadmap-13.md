# Roadmap 13 — implementation plan

Source: `plan/docs/13-harness-optimization-roadmap.md` (owner's roadmap, 2026-10-17). Approved by the owner ("create worktree plan and implement this", 2026-10-17).
Worktree: `../aiharness-wt/roadmap`, branch `roadmap` (from `m4` @ `5537a27`). Progress log: `road-map-handoff.md` at the worktree root (committed).
Rules: one commit per point (≤150 chars, no trailer); typecheck + full vitest suite green before each commit; renderer work follows DESIGN.md; every new behaviour additive and gated, old behaviour pinned by tests (memory `no-regressions`); Windows-safe paths/spawn (memory `two-machines`); one live turn on Claude / Codex / OpenCode Zen at the end of each phase that touches the app runtime (memory `test-app-for-real`).

## Points

### P1 Measurement and eval integrity (evals/)
- P1.1 Trial-level cache: every trial is cached on its own; experiment identity adds effort, grader version, runtime/policy version; asking for N trials with k cached runs N−k.
- P1.2 Outcome statuses + accounting: trial `status` (passed/failed/harness-error/budget-stop/cancelled/ungraded); infra failure can never pass; usage coverage `reported|estimated|unavailable`; `measuredCostUsd` kept on cached records vs `spentUsd` this run; cost-per-success with per-case weighting; unknown cost stays unknown.
- P1.3 Run manifest + traces: versioned manifest per run (agent/model/effort/protocol/guide+skill+tool catalog hashes, price snapshot, versions); per-trial trace artifact (events, tool defs, config) redacted, local.
- P1.4 Local report: `--report` writes an HTML/JSON report (per-case outcome, cost, latency, reps, coverage, trace links) and candidate-vs-baseline comparison on the same task set.
- P1.5 Grader validation: `--validate-graders` runs each task's graders against the untouched fixture (no-op must fail) and `<fixture>.reference/` overlay (must pass).
- P1.6 Multi-turn scenarios: task `turns[]` with scripted user replies; memory fixture; mock MCP server via `scripts/mock-extensions-lib.mjs`.
- P1.7 Case set expansion: +20 passable cases across coding/context/memory/skills with reasons for difficulty and negative controls.
- P1.8 Desktop baseline: deterministic 10k/50k-event thread fixtures + `scripts/profile-history.ts` timing Store reads and renderer projections.

### P2 App responsiveness
- P2.1 Paged event reads (Store + IPC + renderer merge by seq).
- P2.2 Incremental projections (turns.ts).
- P2.3 Windowed transcript (ThreadView) with scroll anchoring.
- P2.4 Startup: concurrent/batched thread listing, deferred heavy panels.
- P2.5 Bounded renderer caches for inactive threads.
- P2.6 session.ts async persistence where profiled.
- P2.7 Selective Board reload by changed path.

### P3 Lazy capability discovery
- P3.1 Tool effect/resource/scheduling classification separate from permission; loop schedules by effect (same-target browser mutations serial).
- P3.2 Skill catalog index + search above a size threshold, session-pinned.
- P3.3 MCP catalog persistence, targeted cold refresh, unavailable ≠ no match.
- P3.4 Result references for MCP/browser outputs.
- P3.5 Code-mode pilot (sandboxed, brokered, per-call trace), behind a flag.

### P4 Context, memory, background spending
- P4.1 Background completion API with usage + shared background policy (purpose models, budgets).
- P4.2 Scope-aware extractor dedupe across project + global notes.
- P4.3 Relevance-ranked memory retrieval with correction priority.
- P4.4 Pruning keeps result references; context-size-aware retention.
- P4.5 Versioned memory changes delivered once per binding.

### P5 Browser
- P5.1 Auto-open pane on browser tool use + readiness wait.
- P5.2 Backend interface; headless agent-browser adapter (pinned).
- P5.3 Session ownership + per-target serialization.
- P5.4 Readiness conditions, stale-ref recovery, compact observations/diffs.
- P5.5 Dev-server lifecycle + test reports.

### P6 Teams
- P6.1 Member model/effort fields, validated, visible in UI.
- P6.2 Flexible lead guidance + focused brief template.
- P6.3 Member result index/navigation, cost/latency reconciliation.

### P7 Automations
- P7.1 Records + scheduler (tz/DST, missed-run coalescing, unique run keys).
- P7.2 Runner: fresh session, source cursors, delivery records/reconciliation.
- P7.3 Templates + Message Center/UI.

### P8 Hillclimbing + learning
- P8.1 Dataset splits + sealed holdout + leakage checks.
- P8.2 Grader/judge calibration.
- P8.3 Bounded optimizer loop (one surface per experiment, budget/stop rules).
- P8.4 Lesson replay, promotion, retirement/undo.

## Blast radius (shared paths, how proven unchanged)
- evals/: existing `test/eval-*.test.ts` stay green; old run files still load (missing fields default).
- Store/IPC/ThreadView: existing full-history API kept; paging is a new path; tests pin projections equal on full vs paged input.
- Tool loop: tools without an effect field keep today's read/write batching (test pins).
- Memory/extractor: Markdown format unchanged; sidecar metadata only.
