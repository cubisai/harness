# OpenCode: make CubiQ's permission modes real (approved 2026-10-19)

## Problem (verified live)
- A thread in **Ask** ("Ask before edits and commands") on OpenCode created `probe.txt` and ran `cat` with no approval card (app, AgentRouter deepseek-v4-flash, 2026-10-19).
- `acp/driver.ts` only answers `session/request_permission`, and OpenCode only sends one when *its own* config says ask. The defaults allow edit and bash, and a user agent's own `permission` block (here `orchestrator.md`: `edit: allow`, `bash "*": allow`) overrides any top-level injection. Verified: injecting `permission: {edit: ask, bash: ask}` changed nothing.
- Evals ran the user's global OpenCode agents (orchestrator → implementer subagent), and an Ask-mode trial read `~/.claude/projects/*/memory`.

## Design
**Phase A: ask over the plugin (app + evals)**
1. `inject/opencode-guard.ts`: the plugin's `tool.execute.before` also handles edit/write/patch/multiedit/apply_patch (kind edit) and bash (kind execute). When `CUBIQ_ASK_URL` + `CUBIQ_ASK_TOKEN` are set, it POSTs `{tool, kind, summary, callID, sessionID}` and awaits `{decision}`. Deny → throw "The user denied this <kind>". Network error → throw (fail closed). Env unset → no change. The git guard part is unchanged and still needs Python.
2. `acp/driver.ts`: a lazily started 127.0.0.1 ask server per driver, with one token per Live (process = thread), set in the spawned env when `config.guardPlugin === "opencode"`. The handler decides by `pickPermission(mode, kind)`:
   - full → allow; auto-edit + edit → allow;
   - plan → allow (defer to OpenCode's plan agent and the existing ACP path, so plan behaviour is unchanged);
   - ask → `turn.input.requestPermission(...)`; no live turn → deny.
   - An approved callID auto-allows OpenCode's own later ACP ask for the same toolCallId (no double card).
3. `index.ts`: inject the plugin for OpenCode always; guard env only when Python exists.
4. Subagent tool calls run in the same process → same thread → its card (also fixes the "subagent ask never reaches CubiQ" hang for edit/bash).

**Phase B: hermetic OpenCode evals**
- The eval OpenCode process gets `XDG_CONFIG_HOME=<scratch>` (no global agents/plugins/MCP). The `provider` section of the user's global config is copied into `OPENCODE_CONFIG_CONTENT`, so provider models resolve. Auth (XDG_DATA_HOME) is untouched.
- The eval setup injects the same plugin.
- `runner.ts` requestPermission denies a request whose summary names the user's home (`~`, `$HOME`, the absolute home path) outside the trial root. Full-mode tasks never ask: a known limit.

## Blast radius / no regressions
- Full mode: one localhost round trip per edit/bash, answered "allow" at once. Pin it with a test.
- Plan: unchanged (handler allows; OpenCode + ACP path as before). Pin it with a test.
- Claude/Codex/other ACP agents: untouched (gated on `guardPlugin === "opencode"`).
- The git guard keeps blocking in every mode (same hook, runs first).
- Teams: member edits/commands in Ask mode now show cards (correct). Live-check that a team turn doesn't hang.
- Windows: plugin uses fetch (Bun runtime inside OpenCode); server on 127.0.0.1. Gate on the Windows PC.

## Checks
- Unit tests: plugin decision paths (allow/deny/fail-closed/env unset), driver handler per mode, callID dedupe, runner outside-path deny, eval config isolation.
- Live (app): Ask (card appears; Deny blocks the edit), Auto-edit (edit silent, command asks), Full (silent), Plan (unchanged); a team turn in Ask; Claude + Codex sanity turns.
