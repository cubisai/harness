# Handoff — after Phase 3 (capability parity)

Updated 2026-09-26 on the Windows PC. Read this, then `CLAUDE.md` (the opencode-delegation workflow), then `spec/README.md`.

## Where things stand

| Phase | State | Commits |
|---|---|---|
| 0 — Substrate | done (CI workflow not yet run on GitHub) | `f41a196` |
| 1 — Provider registry | done | `8b68753` |
| 2 — Credential injection | done | `f95ceaa` … `f09a2d7` (+ `5ce511c`) |
| 3 — Capability parity | **done**: typecheck, build and `electron . --smoke` green; tests green except the two known Windows-machine items below | A `67bdb46` (+`8b39214`), B `84ed108`, C `3a909dc`, D `3aacc63`, E `c2d10f2` |
| Windows portability | done | `ae0b0cc` |

**Uncommitted on purpose (the user decides):** the pnpm → bun switch (`package.json`, `bun.lock`, `bunfig.toml`, deleted `pnpm-*`/`.npmrc`, `ci.yml`, README/`main.tsx`/`mock.ts` comments) and the `CLAUDE.md` Windows notes. `test/__snapshots__/providers.test.ts.snap` shows as modified: line endings only. Phase commits carry code + tests only, with no attribution trailer.

## What Phase 3 shipped

- `AgentCapabilities` + `SAFE_DEFAULTS` on every driver (ACP: `initialize` is authoritative); `skillsDelivery` replaces `skillCallPrefix` (kept as a deprecated projection).
- Codex Ask **and** Auto-edit on `untrusted` + `workspace-write` (spike: `on-request` runs commands without asking); the harness auto-accepts file changes in Auto-edit and runs the git guard on every command.
- Git guard on ACP (`reject_once` + notice), Codex, and OpenCode (a `tool.execute.before` plugin injected via `OPENCODE_CONFIG_CONTENT.plugin`). `unwrapShell()` catches `/bin/zsh -lc '…'`.
- Dropped-HTTP-MCP and "session reopened" notices.
- `src/main/approvals.ts`: allow-always keyed `(agentId, toolName, canonicalPattern)`, in memory, **one store per project**, consulted after the driver's guard; `permissionTable()` snapshot pins the 9 (mode × driver) rows.
- `Service.applyModel()` → `in-place | new-session | unsupported` via optional `AgentDriver.setModel`; Claude/Codex/ACP in place, back-to-default on Codex/ACP → new session; one notice per switch. Summary replay is phase 6.
- Library capability chips + "What this agent can't do here"; `PermissionCard` shows the guard variant from `capabilities.guardEnforcement[mode]`.
- Credential injector chosen by data (`injectionFor(..., { injector, keyVar, providerEnvOnly })`, preset fields), and `test/no-agent-id-branches.test.ts` scans `src/main`.

## Windows portability (`src/main/winspawn.ts`)

`spawnCommand`/`execCommandSync` resolve a bare name on PATH and run `.cmd` shims through cmd.exe with cross-spawn-style double escaping (Codex `-c` values survive); `killTree` uses a synchronous `taskkill /T /F` (a plain `kill()` left `opencode.exe` running). Non-Windows paths are unchanged.

## Open items

- **This Windows PC:** Node 22.17 → `db.test` worker test fails (`Unknown file extension ".ts"`); needs Node ≥ 22.18. `codex-e2e` "adds the browser tools…" fails under full-suite load only (the mock stdio MCP server isn't up before Codex's first request; passes alone) — consider `startup_timeout_sec` for app MCP servers.
- **Renderer id branches:** `ProviderSheet.tsx` still checks `agent.id === "claude"/"codex"/"antigravity"` — out of T3.8's `src/main` scope; fold into phase 8's Settings work.
- Manual checks still pending: Claude on a BYOK provider in-app; `dsh` receiving its key; model-picker search/provider name (user request, unscheduled).
- `CLAUDE_CODE_PROMPT_CACHE_TTL` / gateway model discovery have no Provider field; OpenCode BYOK is openai-chat only.

## Environment facts

- **Windows PC:** bun 1.4.2, Node 22.17, codex-cli 0.157.1 (npm shim, ChatGPT login), opencode 1.18.32 (npm shim), no `python` in Git Bash, delegation proxy on `127.0.0.1:3900`. Use `timeout 900 opencode run …`.
- **Mac:** Node 24, codex 0.157, delegation proxy on `127.0.0.1:4141`.
- **Never** touch `~/.config/opencode/opencode.json` (powers the delegation workers) or `~/.codex` in tests. Use temp `XDG_*` / `CODEX_HOME`. Run `electron . --smoke --user-data-dir=<tmp>`.
- opencode briefs: no key-like strings, "dispatch exactly once"; a long brief can stop mid-run with no final message — split it and send a continuation brief for what's left.

## Next

Phase 4 (streaming + reasoning display), in four steps: A — `TurnInput`/`LiveUpdate` delta channel + Claude deltas (T4.1, T4.2, Claude part of T4.8); B — Codex + ACP deltas and abort flush (T4.3, T4.4, T4.8); C — renderer `live.ts` store + `streaming.ts` tail (T4.5, T4.6); D — `ReasoningBlock`, plan row, compaction divider (T4.7). Then Phase 5 (cache), then Phase 6 (context survival, critical path).
