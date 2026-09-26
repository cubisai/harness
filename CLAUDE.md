## opencode delegation (custom, project-local — not the generic "skilled" template)

Active when `"opencodeDelegation": true` in `.claude/settings.json`.

Claude Code is the orchestrator. `/oc <task>` is a manual trigger, but this policy is not gated behind it — apply it automatically whenever a task involves non-trivial codebase exploration or an implementation/edit loop, the same way you'd reach for any other skill without being asked to name it. Delegate that heavy exploration/edit-loop token cost off Claude's own context, but Claude Code always performs the final correctness check itself. A worker's own "done" / "tests pass" claim is never the answer; Claude's own read of the diff and Claude's own run of the project's real checks is.

**Trust boundary**: opencode agents run on `deepseek-v4-flash` (or, transparently, whatever the fallback plugin substitutes on a transient failure — you won't always know which one actually answered). Either way it's a smaller/cheaper model than Claude, picked for cost and speed. Treat everything it returns — research findings, file:line citations, "bug confirmed" claims, not just an implementer's "done" — as an unverified claim, not as fact. Spot-check the load-bearing ones yourself (open the cited file, re-run the cited command) before writing them into a plan, a brief, or anything you tell the user, especially when a finding is surprising or about to drive a code change.

**Two separate fallback layers, don't confuse them**: (1) *model-level*, inside opencode itself — `deepseek-v4-flash` → `space-bunny-free` on 429/500/502/503/504 or a matching pattern, automatic, invisible from the CLI output, see `~/.config/opencode/opencode-fallback.json`. (2) *task-level*, this is yours to enforce — if a delegated call fails 3 times in a row for the same task (CLI/auth error, timeout, malformed or empty output, anything that isn't a normal task result), stop delegating for that task and finish it yourself directly. Don't keep retrying opencode past that; say so to the user in one line and proceed solo.

### Worker team

Workers run on `agentrouter/deepseek-v4-flash` as primary, auto-falling back to `opencode/space-bunny-free` (free tier) via the `opencode-runtime-fallback` plugin on 429/500/502/503/504 or a matching retryable pattern (see `~/.config/opencode/opencode-fallback.json`). This is set at `~/.config/opencode/opencode.json`'s top-level `model`, inherited by every agent — none of the per-agent `.md` files in `~/.config/opencode/agent/` pin a model. If a raw `curl` to the agentrouter proxy (`127.0.0.1:4141`) 401s, that's expected — the proxy gates on the real opencode client, not arbitrary HTTP clients; it is not evidence the route is broken. Subagents cannot be invoked directly via `--agent <name>` — confirmed empirically, it silently falls back to the default agent. Always dispatch through the `orchestrator` primary agent:

```bash
# brief text in .ai/tmp/<name>.brief.txt: "Delegate to the <agent> subagent: <brief>. Relay only that subagent's raw output."
perl -e 'alarm shift; exec @ARGV' 900 \
  opencode run --agent orchestrator "$(cat .ai/tmp/<name>.brief.txt)" \
  --format json --print-logs --log-level INFO \
  < /dev/null > .ai/tmp/<name>.out.jsonl 2> .ai/tmp/<name>.log
```

**`< /dev/null` is mandatory.** `opencode run` appends piped stdin to the prompt whenever stdin is not a TTY, so it blocks forever right after the `message=init` log line if the shell hands it an open, never-closed stdin (background Bash sometimes does). Reproduced 2026-09-25: closed stdin → answers in seconds; open pipe → stuck at `init`, no session created. The `perl alarm` wrapper (macOS has no `timeout`) hard-kills any run after 900 s, so a hang surfaces as exit 142 instead of silence. A log that ends at `message=init` with no `created id=ses_` line = this hang, not a model/provider problem.

| Agent | Scope |
|---|---|
| `researcher` | Read-only codebase exploration, fact-finding |
| `implementer` | Code edits, bug fixes, refactoring |
| `bug-catcher` | Fast first-pass bug sweep |
| `bug-reviewer` | Deep bug analysis, confirming/refuting findings |
| `architect` | Visible design reasoning (pure text, no tools) |
| `orchestrator` | Dispatch agent — the only one directly invocable |

`verifier` exists globally (`~/.config/opencode/agent/verifier.md`) but is **deliberately not dispatched from this project** — see Verification below.

### Workflow

1. **Research**: delegate parallel `researcher` briefs for non-trivial exploration (affected components, dependencies, conventions). Batch independent briefs in one message.
2. **Spec**: for non-trivial changes, write a short plan to `.ai/plans/<slug>.md` (objective, file:line evidence, change list, blast radius). Get explicit user approval before any `implementer` brief touches code.
3. **Brief**: one self-contained prompt per worker — exact target files, exact expected diff shape, explicit constraints (preserve existing architecture/styling/tokens, no unrelated cleanup, no secrets or `.env` contents in the brief text).
4. **Verification (Claude-side, never delegated)**: once `implementer` reports done, Claude reads the actual `git diff` itself and runs this project's real verification commands itself via Bash (typecheck/lint/tests — see this repo's own scripts, not opencode's `verifier`). That run, not the worker's self-report, is what "passed" means.
5. **Fix loop**: if Claude's own check fails, send one targeted fix brief back to `implementer`, then re-verify itself the same way. Max 2 iterations, then stop and report status to the user directly instead of looping further.
6. **Phase close-out**: when a spec phase passes Claude's own verification, (a) commit it — only that phase's files, message ≤ 150 characters, **never** a `Co-Authored-By` or any other attribution trailer; (b) delete everything in `.ai/tmp/` (briefs, `.jsonl`, `.log`, probes) before starting the next phase. `.ai/plans/` stays.

### Execution discipline (token-optimized)

- **Background, wait for completion, never stream or poll**: `run_in_background: true`, split stdout/stderr as shown above, and do **not** attach `Monitor` to the log. The harness notifies Claude once when the run exits; only then read the final result out of the `.jsonl` file (never the full transcript) and validate it. Don't relay per-edit progress to the user — one line at dispatch, one at validation.
- **The `.log` (stderr) is for post-mortems only**: `--print-logs --log-level INFO` still writes it, so if a run fails, times out, or returns empty/malformed output, read the tail of the `.log` to diagnose. Don't tail it live.
- **Terse, complete briefs**: enough detail that a worker never needs a second round-trip — that round-trip costs more tokens than writing the brief carefully the first time.
- **Headless permissions**: headless runs reject unapproved permissions. Narrow the brief to pre-approved tools rather than expanding global allowances.
