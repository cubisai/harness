## opencode delegation (custom, project-local — not the generic "skilled" template)

Active when `"opencodeDelegation": true` in `.claude/settings.json`. *(opencode workers read this file too: this section is for Claude Code — as a worker, never run `opencode` or delegate.)*

Claude Code is the orchestrator. `/oc <task>` is a manual trigger, but this policy is not gated behind it — apply it automatically whenever a task involves non-trivial codebase exploration or an implementation/edit loop, the same way you'd reach for any other skill without being asked to name it. Delegate that heavy exploration/edit-loop token cost off Claude's own context, but Claude Code always performs the final correctness check itself. A worker's own "done" / "tests pass" claim is never the answer; Claude's own read of the diff and Claude's own run of the project's real checks is.

**Trust boundary**: opencode agents run on small, cheap models (DeepSeek v4 Flash via AgentRouter first, see Worker team), and a fallback may silently swap in another. Treat everything they return — findings, file:line citations, "bug confirmed", an implementer's "done" — as an unverified claim. Spot-check the load-bearing ones yourself (open the cited file, re-run the cited command) before they go into a plan, a brief, or anything you tell the user.

**Two separate fallback layers**: (1) *model-level* — `oc-run.mjs` walks the worker's `[model, ...fallback_models]` from `opencode.json` (AgentRouter DeepSeek v4 Flash → Qwen3.7 Flash, set 2026-09-27), one `opencode run` per model, on an error, empty output, `DISPATCH FAILED` or timeout. The runtime-fallback plugin can't do this headless: `opencode run` exits on the first error (verified 2026-09-26). (2) *task-level*, yours — if a dispatch fails 3 times for the same task (every model failed, or output unusable), finish that task yourself and say so in one line.

### Worker team

Routing: `~/.config/opencode/opencode.json`, per-agent `model` + `fallback_models`; full setup in `SETUP-OTHER-PC.md`. AgentRouter goes through the local proxy on `127.0.0.1:3900` (Windows: start `~/.config/opencode/start-proxy.bat` if nothing listens; a raw `curl` to it 401s by design). Subagents can't be invoked via `--agent <name>`; the brief goes to `orchestrator`, which `oc-run.mjs` calls:

```bash
# brief in .ai/tmp/<name>.brief.txt: "Delegate to the <agent> subagent: <brief>. Relay only that subagent's raw output."
node ~/.config/opencode/oc-run.mjs --worker <agent> --brief .ai/tmp/<name>.brief.txt \
  --out .ai/tmp/<name>.out.jsonl --log .ai/tmp/<name>.log --timeout 900
```

| Agent | Scope |
|---|---|
| `researcher` | Read-only codebase exploration, fact-finding |
| `implementer` | Code edits, bug fixes, refactoring |
| `bug-catcher` | Fast first-pass bug sweep |
| `bug-reviewer` | Deep bug analysis, confirming/refuting findings |
| `architect` | Visible design reasoning (pure text, no tools) |
| `orchestrator` | Dispatch agent — the only one directly invocable |

`verifier` exists globally on the Mac (`~/.config/opencode/agent/verifier.md`; not installed on the Windows PC) but is **deliberately not dispatched from this project** — see Verification below. The orchestrator's `task` permission only allows the five workers above.

**Browser work**: `agent-browser` (Vercel) is installed globally with its skill in both Claude Code (`~/.claude/skills/agent-browser`) and opencode (`~/.agents/skills/agent-browser`). `researcher` and `implementer` may run `agent-browser …` via bash, so a brief can ask them to check a page or the `preview:ui` build. Start any such brief with "first run `agent-browser skills get core`". On Windows it drives the installed Chrome via `AGENT_BROWSER_EXECUTABLE_PATH`.

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
