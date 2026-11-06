## UI design rules

Any change under `src/renderer/**` (styles, components, layout, copy) follows `DESIGN.md` at the repo root: tokens, type, spacing, components, motion and the pre-ship checklist. Read it first. When a `build` brief touches UI, cite the relevant `DESIGN.md` sections in the brief, since workers start cold.

## opencode delegation (project-local)

Active when `"opencodeDelegation": true` in `.claude/settings.json`. *(opencode workers read this file too: this section is for Claude Code. As a worker, never run `opencode` or delegate.)*

Claude Code is the orchestrator. `/oc <task>` is a manual trigger, but this policy is not gated behind it: apply it automatically whenever a task involves non-trivial codebase exploration or an implementation/edit loop, the same way you'd reach for any other skill without being asked to name it. Delegate that heavy exploration/edit-loop token cost off Claude's own context, but Claude Code always performs the final correctness check itself. A worker's own "done" / "tests pass" claim is never the answer; Claude's own read of the diff and Claude's own run of the project's real checks is.

**Trust boundary**: opencode runs on a small free model (`opencode/deepseek-v4.1-flash-free`, OpenCode Zen). Treat everything it returns (findings, file:line citations, "bug confirmed", a `build` run's "done") as an unverified claim. Spot-check the load-bearing ones yourself (open the cited file, re-run the cited command) before they go into a plan, a brief, or anything you tell the user.

**Failures**: if a dispatch fails 3 times for the same task (error, timeout, empty or unusable output), finish that task yourself and say so in one line. On "Free usage limit reached" or "Rate limit exceeded" from Zen, re-dispatch the same brief on the PGS Grove fallback `PGA/deepseek-v4.1-flash-1017`, which doesn't count as one of the 3 failures. If the fallback is rate-limited too, stop the run and do the research as Haiku `Explore` subagents instead.

### Agents

No custom opencode agents: use opencode's **built-in** primary agents directly, one `opencode run` per brief.

| Agent | Scope |
|---|---|
| `plan` | Read-only research: exploration, fact-finding, bug sweeps, design reasoning (edits denied) |
| `build` | Code edits, bug fixes, refactoring |

```bash
# brief in .ai/tmp/<name>.brief.txt; <agent> = plan | build
perl -e 'alarm shift; exec @ARGV' 900 \
  opencode run --agent <agent> -m opencode/deepseek-v4.1-flash-free "$(cat .ai/tmp/<name>.brief.txt)" \
  --format json --print-logs --log-level info \
  < /dev/null > .ai/tmp/<name>.out.jsonl 2> .ai/tmp/<name>.log
```

`< /dev/null` is mandatory (with an open stdin `opencode run` hangs after `message=init`); `perl alarm` stands in for `timeout`, which macOS lacks (on Windows use the shell's own timeout). Stagger parallel starts ~20 s apart ("database is locked"). Keep `build` briefs to ≤ ~5 files and tell it not to run shell commands or git: Claude runs the checks. The `.jsonl` text is often truncated, so judge the result by `git status` / `git diff`.

**Browser work**: `agent-browser` (Vercel) is installed globally with its skill in both Claude Code (`~/.claude/skills/agent-browser`) and opencode (`~/.agents/skills/agent-browser`). `plan` and `build` runs may use `agent-browser …` via bash, so a brief can ask them to check a page or the `preview:ui` build. Start any such brief with "first run `agent-browser skills get core`". On Windows it drives the installed Chrome via `AGENT_BROWSER_EXECUTABLE_PATH`.

### Workflow

1. **Research**: delegate parallel `plan` briefs for non-trivial exploration (affected components, dependencies, conventions). Batch independent briefs in one message.
2. **Spec**: for non-trivial changes, write a short plan to `.ai/plans/<slug>.md` (objective, file:line evidence, change list, blast radius). Get explicit user approval before any `build` brief touches code.
3. **Brief**: one self-contained prompt per run — exact target files, exact expected diff shape, explicit constraints (preserve existing architecture/styling/tokens, no unrelated cleanup, no secrets or `.env` contents in the brief text).
4. **Verification (Claude-side, never delegated)**: once a `build` run reports done, Claude reads the actual `git diff` itself and runs this project's real verification commands itself via Bash (typecheck/lint/tests — see this repo's own scripts). That run, not the worker's self-report, is what "passed" means.
5. **Fix loop**: if Claude's own check fails, send one targeted fix brief back to `build`, then re-verify itself the same way. Max 2 iterations, then stop and report status to the user directly instead of looping further.
6. **Phase close-out**: when a spec phase passes Claude's own verification, (a) commit it — only that phase's files, message ≤ 150 characters, **never** a `Co-Authored-By` or any other attribution trailer; (b) delete everything in `.ai/tmp/` (briefs, `.jsonl`, `.log`, probes) before starting the next phase. `.ai/plans/` stays.

### Execution discipline (token-optimized)

- **Background, wait for completion, never stream or poll**: `run_in_background: true`, split stdout/stderr as shown above, and do **not** attach `Monitor` to the log. The harness notifies Claude once when the run exits; only then read the final result out of the `.jsonl` file (never the full transcript) and validate it. Don't relay per-edit progress to the user — one line at dispatch, one at validation.
- **The `.log` (stderr) is for post-mortems only**: `--print-logs --log-level info` still writes it, so if a run fails, times out, or returns empty/malformed output, read the tail of the `.log` to diagnose. Don't tail it live.
- **Terse, complete briefs**: enough detail that a worker never needs a second round-trip — that round-trip costs more tokens than writing the brief carefully the first time.
- **Headless permissions**: headless runs reject unapproved permissions. Narrow the brief to pre-approved tools rather than expanding global allowances.
