Researcher raw output:

# Code map: bounded hillclimbing & verified learning (CubiQ)

## 1. evals/ framework

- **Task type: `evals/lib/types.ts:40-72`.** Fields verbatim:
  - `id: string`
  - `tags: TaskTag[]`
  - `tier: Tier`
  - `fixture: string`
  - `prompt: string`
  - `mode: "ask" | "plan" | "auto-edit" | "full"`
  - `reply?: string`
  - `turns?: { prompt: string; reply?: string }[]`
  - `memory?: string`
  - `mcp?: { servers: number; tools: number; seed: number }`
  - `requires?: ("browser" | "team")[]`
  - `permissions?: "allow" | "deny"`
  - `planDecision?: "stop" | "auto" | "manual"`
  - `skills?: { kit: { skills: number; seed: number } }`
  - `graders: Grader[]`
  - `budget: Budget`
  - `reference?: string`
  - `difficulty?: string`
  - `suite?: "coding" | "context" | "memory" | "skills" | "mcp" | "browser" | "teams"`
- Supporting types: `Tier = "smoke" | "full"` and `TaskTag = "capability" | "regression"` (`types.ts:6-7`); `Budget { maxSteps, maxInputTokens, timeoutMs }` (`types.ts:9-15`).
- **Task JSON declares** `tier` and `suite` as top-level keys (e.g. `evals/tasks/c-error-handling.json:4-5` two keys `"tier"` then `"suite"`); `difficulty` is a free-text field (`types.ts:67-69`). `suite` is absent from many tasks (only 21/49 files declare it — see §2).
- **Runner: `evals/lib/runner.ts`.** `runTrial` copies fixture → temp, runs turns under budget (`runner.ts:114-252`); `compact` clips events (`runner.ts:50-67`); `trialStatus` (`runner.ts:70-76`); `writeSkillKit`/`mcpKit` (`runner.ts:84-112`); `runTask` folds trials (`runner.ts:281-289`).
- **Store / cache identity: `evals/lib/store.ts`.** `cacheKey(task, fixtureDir, model, protocol, harnessHash, identity)` hashes task JSON + fixture dir + `.hidden` dir + model + protocol + harnessHash + `EVAL_RUNTIME_VERSION` + effort + graderVersion (`store.ts:47-67`); `EVAL_RUNTIME_VERSION = "2"` (`store.ts:36`); `Identity { effort?, graderVersion? }` (`store.ts:39-44`); `hashDir` (`store.ts:27-33`); `findCachedTrials`/`assembleTask` (`store.ts:129-167`); run files in `.ai/evals` (`evals/run.ts:30`).
- **Accounting: `evals/lib/accounting.ts`.** `statusOf`/`passed` (`:7-15`), `spend` measured-vs-spent (`:44-48`), `costPerSuccess` weighted (`:66-84`), `incomplete` (`:87-97`), `accountingLine` (`:106-111`).
- **Report: `evals/lib/report.ts`.** `caseRow` (`:29-46`), `settingDifferences` (model/protocol/effort/harness/versions/price, `:68-84`), `compareRuns` shared-task comparison (`:86-100`), `renderReport` HTML (`:108-150`).
- **Grader validation: `evals/lib/validate.ts`.** `Reference` (edits/write/delete/events/skills/mcp, `:13-25`); `loadReference` reads `evals/references/<id>.json` or `<fixture>.reference/` (`:88-92`); `validateTask` requires a no-op to FAIL and the reference to PASS (`:94-113`).
- **Graders: `evals/lib/graders.ts`.** Kinds dispatched in `grade()` (`:113-133`): **file, command, tool, skill, event, answer, mcp, budget** (8). `score()` weighted/required (`:142-147`). **No model/LLM/judge grader exists** — every kind is deterministic (diff/hash/regex/command/sentinel); the word "judge" appears nowhere in `graders.ts`.
- **References: `evals/references/`** — one `<task-id>.json` per task (49 files).
- **CLI flags: `evals/run.ts:1-9` (doc comment) + parsed at `:99-260`:** `--agent native|claude|codex|opencode`, `--tier smoke|full`, `--provider`, `--model`, `--effort`, `--trials`, `--task`, `--dry`, `--force`, `--keep`, `--save-baseline`, `--max-tokens`, `--max-usd`, `--price`, `--trend [--last]`, `--report [--vs]`, `--validate-graders [--verbose]`.

## 2. Task count, suites, tiers

- **49 task files** in `evals/tasks/` (directory listing; 49 `"tier"` matches).
- **Tiers (distinct = 2):** `smoke` (6: route-none-1, fix-off-by-one, explain-no-edit, route-skill-1, plan-proposes, honest-test) and `full` (43). Example smoke: `evals/tasks/route-none-1.json:6`; example full: `evals/tasks/generated-dist.json:6`.
- **Suites (distinct = 6 of the 7 allowed; `teams` unused):**
  - `coding` — `evals/tasks/c-error-handling.json:5`
  - `context` — `evals/tasks/x-context-early-constraint.json:7`
  - `memory` — `evals/tasks/x-memory-preference.json:7`
  - `skills` — `evals/tasks/x-skill-direct-answer.json:7`
  - `mcp` — `evals/tasks/x-mcp-unavailable.json:7`
  - `browser` — `evals/tasks/browser-smoke.json:7`
  - (`teams` not found: `evals/tasks/team-review.json:1-12` has `requires:["team"]` but no `suite`.)

## 3. src/main/learn/

- **Modules:** `index.ts` (Learner orchestrator: score→capture→draft, `:115-487`); `signals.ts` (S1 zero-token scorecard rules `:1-101`); `snapshot.ts` (pre-turn tree snapshot `:1-108`); `cases.ts` (S3 eval-case capture `:1-189`); `draft.ts` (S2 prompt build/parse/dedupe `:1-182`); `db.ts` (typed SQLite access `:1-270`); `background.ts` (cheap background model + one-shot `:1-111`).
- **What "learning" does today:** scores every opted-in turn (S1), freezes failed turns as **eval cases** (S3, `index.ts:177-222`), and drafts **candidate lessons** from a failed turn on a background cheap model (S2, `index.ts:250-317`). It does **not** touch skills/tool descriptions/retrieval; lessons are rules only. It skips turns that pulled web/MCP content (`index.ts:191-193`, `draft.ts:177-181`).
- **Where learned items are stored:** lessons/turn scores/replays/budget in SQLite tables `lessons`, `turn_scores`, `learn_replays`, `learn_budget`, `background_runs` (migrations 23-26, 28: `src/main/db.ts:212-263`, `:266-271`; accessors `learn/db.ts`). Captured **cases on disk** at `join(userData, "learn", <projectId>, "cases")` (`src/main/index.ts:1040`), written by `captureCase` (`cases.ts:126-164`).
- **Status/lifecycle:** `LessonStatus = "candidate" | "active" | "retired" | "dropped"` (`src/shared/learn.ts:33`). New lessons are always `status:"candidate"` (`index.ts:301`). **No code promotes to active, retires, or drops** — `updateLesson` is only used to attach a `caseId` (`index.ts:290`); grep for `status: "active"|"retired"` in `learn/` returns nothing (only unrelated DB rows).
- **Replay/evaluation of a lesson:** schema + accessors exist — `cachedReplay`/`saveReplay` over `learn_replays` (`db.ts:229-238`) and `LessonVerification { before, after, transfer }` (`learn.ts:47-56`). **No caller** of `cachedReplay`/`saveReplay` anywhere in `src/`; `verified` is set to `null` on creation (`index.ts:309`). Held-out cases exist (`heldOutId`, fixed quarter: `cases.ts:112,154`) and held-out cases are never drafted from (`index.ts:215-216`) — but the regression/transfer replay that would consume them is **not implemented**.
- **Settings controlling it:** stored under settings key `learn` (`src/shared/types.ts:219` `learn?: LearnSettings`), sanitized by `sanitizeLearn` (`src/main/settings.ts:434`, applied `:146,:183`), defaults `LEARN_DEFAULTS` (`shared/learn.ts:119`). Fields: `enabledProjects`, `dailyTokens`, `memoryDailyTokens`, `background`, `backgroundByProject` (`shared/learn.ts:107-117`). **Search for a `learn.` dotted prefix in `src/shared/types.ts` → not found** (the settings key is the single object `learn`, not `learn.*` keys).

## 4. Profile / candidate / holdout / split / experiment

- `profile` — **not found** anywhere in `evals/` or `src/main/learn/`. (Versioned-profile / optimization concept does not exist.)
- `candidate` — comparison term in report: `evals/lib/report.ts:2,53,55,95,97,128,131`; lesson status candidate: `src/main/learn/index.ts:301,310`.
- `holdout` / `heldOut` — `src/main/learn/cases.ts:30,31,112,154,189`; `src/main/learn/index.ts:215,216`.
- `split` — **not found** as a dataset-split concept (`evals/run.ts:118,148,151` are `String.split`; only `.split` usages elsewhere).
- `experiment` — one comment only: `evals/lib/store.ts:38` ("The rest of an experiment's identity…"). No experiment/bounded-optimizer module.

## 5. Tests

- `test/eval-runner.test.ts` — runs the runner on a scripted model (zero tokens, real fixtures/tools/grader commands), `:1-2`.
- `test/eval-tasks.test.ts` — every task with a reference solution must fail on the bare fixture and pass with the reference overlaid, `:1-3`.
- `test/eval-graders.test.ts` — unit tests for `graders.ts` with the shell injected as a fake, `:1-2`.
- `test/eval-report.test.ts` — `caseRow`, `compareRuns`, `percentile`, `renderReport`, `settingDifferences`, `:2`.
- `test/eval-store.test.ts` — cache keys/reuse, accounting, `findCachedTrials`/`assembleTask`/baseline, `:5-12`.
- `test/learn-draft.test.ts` — lesson-draft prompt/parse/dedupe and web/MCP poisoning filter (`POISON_TOOLS`), `:2-3`.
- `test/learn-capture.test.ts` — case capture + full learner pipeline via `Service`/`LearnDb`, `:6-12`.
- `test/learn-scorecard.test.ts` — signals/`healthOf`/`roundSignals` scoring rules (`:12`).

**Unknowns:** runtime behavior of replay/promotion was not verified at runtime (no caller found by static grep); `evals/baseline.json` content not read (not requested). Test bodies were read only by header, so each "pins" line reflects the file's stated scope, not exhaustive assertions.
