# bench: day-by-day harness performance

A fixed task set, run every day per agent and model **through the real app**, so a harness change (a prompt line, a tool description, a CLI upgrade) shows its effect on todo use, code mode, skills, tokens, time and cost.

```bash
bun run bench                                    # every agent × every task, one try each
bun run bench --agents claude-sonnet,codex-luna --tasks build-cli
bun run bench --k 3                              # three tries each: use on days a harness change lands
bun run bench --serial                           # one agent at a time (default: agents side by side)
bun run bench --dry                              # list the runs, start nothing
bun run bench:report [YYYY-MM-DD]                # re-render a day's summary.md, no model calls
```

`bun run bench` loads `.env`, which the native providers' keys come from (`envRef`; keys are never written anywhere).

## How a run works

1. `bench/run.ts` starts its own dev copy of the app (`bun run dev`, CDP port **9466**, profile `bench/.state/ud`). It never touches your installed profile or an app on 9455. To use an app that's already running, pass `--attach <port> --user-data-dir <its profile>`.
2. Each task × agent has its own project folder (`bench/.state/work/<task>/<agent>`), reset before every run: the fixture copied in and committed to a fresh git repo, or this repo at a pinned commit without CLAUDE.md/AGENTS.md.
3. Code mode is set to "on". Then: new thread → `updateThread({agent, model, permissionMode: "full"})` → the DB row is checked → `send` → the run waits for the top-level `turn-end` in `unskilled.db` (timeout 15 min).
4. `<fixture>.hidden/` is copied in, the task's graders run (`evals/lib/graders.ts`: file, command, answer…), and the metrics are read from the thread's events (`bench/lib/metrics.ts`).
5. Free providers (`"spaced": true`) wait at least 90 s between runs; after a rate-limit error a run waits 180 s and retries once.

## What is measured

| | |
|---|---|
| Pass | the task's graders: hidden tests, file checks, the answer |
| Todo | lists (`plan` events, from any agent's todo tool): before the first edit? updates, all completed at the end; the one-step task expects **none** |
| Code mode | `run_code` calls and failed scripts vs look (read/grep/glob), shell and edit calls; top-level only |
| Skills | a sentinel string that sits only in the skill's body shows up in the run's events |
| Tokens, cost, time | from the top-level `turn-end` (input, output, cache read/write, `costUsd`, `durationMs`) |
| Errors | `error` events |

## Tasks

| Task | Measures |
|---|---|
| `one-step-edit` | a one-line edit; no todo list expected |
| `build-cli` | a 7-part CLI build, graded by a hidden test; a todo list before the first edit, closed at the end |
| `read-heavy` | a question over this repo at `17b3eba`; ground truth `AUTO_OPEN`, `PROVIDER_MODEL_PREFIX`, `VARIANT_RE`; expects run_code |
| `skill-trigger` | a project skill (`.cubiq/skills/changelog-entry`) the prompt never names; its `(#none)` rule proves it was followed |

Agents and models are in `agents.json`. To add a task, put a JSON file in `tasks/` (see `lib/types.ts`), a fixture in `fixtures/<name>/` and its hidden checks in `fixtures/<name>.hidden/`. Check that a correct solution passes and the untouched fixture fails before trusting it.

## Reading results

`results/<YYYY-MM-DD>/` holds one JSON per run (`<agent>--<task>--t<n>.json`, with the harness commit and CLI versions) and `summary.md`. Deltas in the summary are against the previous day. A **flag** needs a pass/fail flip, or a value outside the last 7 days' min–max (±10%) once at least 3 days exist: one run is noisy, so a single-day wobble is not a change. Results are committed, so the history is the same on both machines.
