# Agent benchmarks

A fixed task set run per agent and model **through the real app, on this repo**, so a harness change can be compared across runs. It measures solve rate, memory, context, checks, skills, tokens, time, and cost. Runs use your own agent sign-ins and can incur charges.

## Agent configuration

`agents.json` ships with three generic entries: `claude`, `codex`, and `opencode`. Claude uses the stable `sonnet` alias; Codex and OpenCode use their configured default models. Select only integrations you have installed and signed in to with `--agents`.

Change `model` to compare a specific model. Set `spaced: true` for rate-limited endpoints. Custom native providers may use the `provider` fields defined in `lib/types.ts`; keep credentials in environment variables and do not commit account-specific configuration.

```bash
bun run bench --agents claude          # core tasks on one configured integration
bun run bench --suite full --k 3      # weekly: every task, three tries each
bun run bench --suite solve           # one suite: behaviour, solve, memory or context
bun run bench --agents claude,codex --tasks solve-codex-office-skills
bun run bench --parallel 6            # agents side by side (default 3: solve tasks run typechecks, and an 8 GB Mac runs out of memory at 6)
bun run bench --scratch               # a trial run: results go to .state/scratch-results/
bun run bench --dry                   # list the runs, start nothing
bun run bench:report [YYYY-MM-DD]     # re-render a day's report and results/README.md (no model calls)
bun bench/validate.ts [--tasks a,b]   # prove the tasks are fair (no model calls); run it after changing a task
```

`bun run bench` loads `.env`, which the native providers' keys come from (`envRef`; keys are never written anywhere).

## Suites

| Suite | Tasks | Measures |
|---|---|---|
| **solve** | `solve-run-code-bare-arg` (easy, core), `solve-codex-office-skills` (medium, core), `solve-codemode-command` (medium), `solve-claude-resumed-cost` (hard) | Real changes from this repo's history. Each starts at the commit's parent, given as a user request, and is graded by **that commit's own tests**, hidden until the turn ends; typecheck is scored but not required. The project's check gate (`bun run typecheck`, 1 fix round) and self-improve are on. |
| **memory** | `memory-recall` (core), `memory-across-threads` (core), `memory-correction` | CubiQ memory on every agent: a seeded note the repo can't tell you; "remember this" in one thread, needed in a new one (and a note must be written); a newer note that corrects an older one. |
| **context** | `context-carry` (core) | Turn 2 needs what turn 1 found; reports the prompt-cache share. |
| **behaviour** | `one-step-edit`, `build-cli`, `read-heavy`, `skill-trigger` (all core) | Todo lists (none on one step, before the first edit on 7 parts), run_code on a read-heavy question, an unnamed skill. Small fixtures and a bare copy of the repo. |

Repo tasks run on this repo at a pinned commit: CLAUDE.md (minus its opencode-delegation section), AGENTS.md and `.claude/skills` stay, `.ai` goes. A tree is extracted once per commit into `.state/trees` (with `node_modules` installed once for solve tasks, then linked into each run's copy).

## How a run works

1. `bench/run.ts` starts its own dev copy of the app (`bun run dev`, CDP port **9488**, profile `.state/ud`). It never touches your installed profile or an app on 9455. To use an app that's already running, pass `--attach <port> --user-data-dir <its profile>`.
2. Each task × agent has its own project (`.state/work/<task>/<agent>`), reset before every run. The run sets the project's check command and self-improve switch. For memory tasks it clears the project's notes and writes the task's.
3. Code mode is on. A new thread → `updateThread({agent, model, permissionMode: "full"})` → the DB row is checked → `send`. The run then waits until the thread is idle: its turns have ended, no check is running, and nothing new arrived for 10 s (so a check's fix round is waited for). Follow-ups go to the same thread or a new one. `afterMemory` waits up to 2 min for the note the previous message asked for.
4. The hidden files are written in (a fixture's `.hidden`, `hiddenDir`, a replayed commit's tests). Then the graders run (`evals/lib/graders.ts`), and the metrics are read from the threads' events (`lib/metrics.ts`).
5. Free providers (`"spaced": true`) wait at least 90 s between runs. After a rate-limit error, or a stall (no new event for 5 min), a run waits 180 s and retries once.
6. `--background-agent <id>` optionally selects a background model for lesson drafts and memory extraction. It must be in the selected agents. Without the flag, the benchmark preserves its profile's existing setting rather than choosing a provider for you.

## What is measured

| | |
|---|---|
| Pass / score | the required graders / the share of all grader weight |
| Check gate | the app's project check after the turn: passed first time, fix rounds, passed in the end |
| Ran tests | the agent ran tests or a typecheck itself |
| Evidence flags | the app's "worth a second look" notices (claims without proof) |
| Learn | self-improve's own score of the turns (ok / warn / fail) and the project's lessons, counted after the bench waits (up to 10 min) for the learner to finish drafting |
| Memory | memory_read / memory_write calls; a note written when the task needs one |
| Todo | lists (`plan` events from any agent's todo tool): before the first edit, updates, closed at the end |
| Code mode | top-level `run_code` calls and failed scripts vs look (read/grep/glob), shell and edit calls |
| Skills | the skill body's sentinel shows up, or a skill-tool call names the skill (Claude's Skill result is only "Launching skill: …") |
| Tokens, cost, time | from the top-level `turn-end`s: input, output, cache read/write, `costUsd`, `durationMs` |

## Adding a task

Put a JSON file in `tasks/` (the fields are in `lib/types.ts`). A fixture goes in `fixtures/<name>/`, with hidden checks in `fixtures/<name>.hidden/`. A replayed commit uses `repo: {commit: "<sha>^", install: true, hidden: {commit: "<sha>", paths: [its tests]}}`, and its prompt must name the API those tests call. Then run `bun bench/validate.ts --tasks <id>`: the untouched start must fail, and the real change must pass.

## Reading results

Generated locally in `bench/results/` (ignored, not published with the source):
- `results/README.md`: the latest flags and every agent day by day, with real changes solved per tier.
- `results/<YYYY-MM-DD>.md`: the day's report. It has the at-a-glance table, flags, one section per suite (a table per task) and why runs missed.
- `results/history.csv`: one row per run. Reports and day-to-day deltas are built from it.

Full records stay in `.state/runs/<date>/<agent>--<task>--t<n>.json` (graders, metrics, final answer, thread ids). The threads themselves stay in the bench profile (`.state/ud`), as do the projects' memory and lessons. Review and redact any report before sharing it: it may include agent answers or project details.

Deltas are against the previous day. A **flag** needs a pass/fail flip, or a value outside the last 7 days' min–max (±10%) once at least 3 days exist: one run is noisy, so a single-day wobble is not a change.
