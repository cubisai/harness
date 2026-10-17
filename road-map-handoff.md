# Roadmap 13 handoff

Implements `plan/docs/13-harness-optimization-roadmap.md` (the owner's roadmap, 2026-10-17; untracked in the main checkout, read it there).
- **Worktree:** `../aiharness-wt/roadmap`, branch `roadmap`, cut from `m4` @ `5537a27`. The main checkout's `m4` has another session's uncommitted TGP work, so nothing here touches it. Merge `roadmap` into `m4` once that work is committed.
- **Plan:** `.ai/plans/roadmap-13.md` in the main checkout (gitignored). It lists the points P1.1 … P8.4.
- **Research notes:** `.ai/research_notes/roadmap13-rp{2,3,4}.md`. These are researcher maps of history/IPC, tools/skills/MCP, and memory/context/teams, with file:line references.

**Rules:** one commit per point. Typecheck and the full vitest suite must be green before each commit. At the end of each phase that changes the app runtime, do one live turn each on Claude, Codex and OpenCode Zen.

## Status

| Point | State | Commit |
| --- | --- | --- |
| P1.1 Trial-level cache + experiment identity | done | see git log |
| P1.2 Trial statuses, usage/cost coverage, cost per success, incomplete runs fail | done | see git log |
| P1.3 Run manifest + traces | next | |
| P1.4 Local report | | |
| P1.5 Grader validation | | |
| P1.6 Multi-turn scenarios | | |
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
