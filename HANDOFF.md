# Handoff — Phase 7 done; Phase 8 next

Updated 2026-09-27 on the Windows PC. Read this, then `CLAUDE.md` (the opencode-delegation workflow), then `spec/README.md`, then `spec/phases/phase-8-ui-refinement.md`.

## Where things stand

| Phase | State | Commits |
|---|---|---|
| 0 — Substrate | done (CI workflow not yet run on GitHub) | `f41a196` |
| 1 — Provider registry | done | `8b68753` |
| 2 — Credential injection | done | `f95ceaa` … `f09a2d7` (+ `5ce511c`) |
| 3 — Capability parity | **done**: typecheck, build and `electron . --smoke` green; tests green except the two known Windows-machine items below | A `67bdb46` (+`8b39214`), B `84ed108`, C `3a909dc`, D `3aacc63`, E `c2d10f2` |
| 4 — Streaming + reasoning | **done**: typecheck, build, preview render green; tests green except the two known Windows-machine items | A `6d20cce`, B `8667748`, C `d6686ac`, D `a6ea827` |
| 5 — Cache discipline | **done**: typecheck, build green; tests green except the two known Windows-machine items | A `80a9a31`, B `270c768`, C `793cfdc` |
| 6 — Context survival | **done**: typecheck, build, smoke green; tests green except the two known Windows-machine items; real Codex→Claude handoff checked in the app | A `04c347e` `022bd44` (+ smoke fix `4f80d01`), B `95e616e` `a2da431`, C `5e3e7dd` `4d487ec`, D `ff414c5` `00dd3f9`, E `c3a845a` |
| 7 — Interaction mechanics | **done**: typecheck, build, smoke green; tests green except the two known Windows-machine items; splitters/drawer/collapse checked in the real app | A `d6ecd8e` `9011c87`, B `a535b69`, C `a7340fe`, D `1b94312` `da46d67`, E `8b4c4e7` `50ad9d1`, F1a `59328c9`, F1b `d7b749e`, F2 `d02e49c` |
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

## What Phase 4 shipped

- Live-only channel: `TurnInput.onTextDelta(text, itemId?)` plus optional `onReasoningDelta/onReasoningSummary/onToolInputDelta/onToolOutputDelta/onUsageUpdate/onThinkingProgress`; the Service broadcasts each as `LiveUpdate { type: "delta" }` (redacted, never stored).
- Claude keys stream items `${messageId}:${blockIndex}` (blocks counted per message id), keeps opaque reasoning as `{ text: "", signature, opaque: true }`, flushes streamed text before "Stopped.". Codex: reasoning text/summary/command-output deltas (reasoning kept out of `t.deltas`). ACP: live thoughts, tool output as suffix diffs of content snapshots, usage updates; per-run synthetic item ids. `AgentCapabilities.liveReasoning?`.
- Renderer: `live.ts` per-item state (cleared only by its terminal event; items without ids clear their channel), 16 ms batched store writes; `streaming.ts` (`parseBlocks` moved here, `splitStreamingTail`, `memoizeByHash`); `ReasoningBlock`, plan row, compaction divider; preview mock shows them.

## What Phase 5 shipped

- The seven browser tools are offered from the first turn and answer "Browser pane not open" until the tab is open (README + HARNESS.md item 7 updated), so the tool set never changes mid-conversation.
- `src/main/cache-policy.ts`: `stableStringify`, pinned tool-set fingerprint (`toolSetOf`/`pinToolSet`/`queueConfigChange`/`drainConfigChanges`), `isMiss` (≥ 2000 and > 5%), `classifyMiss`, `annotateUsage`, `shouldCompact` + `claudeCompactEnv`/`codexCompactConfig` (built, **not wired** into agents). The Service annotates every `turn-end` usage: a fresh session has no baseline; `TurnInput.onSessionRebuilt?()` (Codex unsubscribe, ACP close+resume) marks an expected `session-rebuild`.
- `src/shared/cache-stats.ts` + `CacheMeter` in the header (one number, detail in `title`, miss cause, warm/cold, live usage ticker); ACP shows `cache —`.

## What Phase 6 shipped

- `Thread.bindings` (`${agent}:default` → `SessionBinding`), migration step 11 backfills from `session_id`; `sessionId` is the current agent's projection and the column still mirrors it. Switching agents keeps every cursor.
- `handoff.ts`: thread export/import (blobs inlined, all-or-nothing; palette *Export/Import Thread…*), `buildCheckpoint`/`renderCheckpoint` (tiers 0–2; no thinking, no CLAUDE.md/AGENTS.md/SKILL.md/Skill output), `fitCheckpoint` (cap min(25% window, 4k), estimate bytes/3, refuse if larger than what it replaces), injection ledger (`injectWithLedger`), `checkpointGit` (`refs/harness-handoff/<seq>`, dirty refusal), `bloatSignal`, `codexSeedItems`.
- Drivers: `capabilities.seeding` (Codex `inject-items`, Claude/ACP `first-message`), `seedNoReply` (false everywhere), `AgentDriver.seed?()` (Codex: open/resume the thread, `thread/inject_items`, never `turn/start`), `countTokens?()` (no driver has one).
- `Service.switchAgent(thread, agent, "handoff" | "fresh" | "back")`: trust reset (default permission mode; approvals are per agent), refusals before any change, git ref only for Hand off, first-message reply stored as a `handoff`/`reply` event, bloat signal on the first turn-end after any switch. `updateThread({ agent })` = back when a cursor exists, else fresh.
- Renderer: `SwitchDialog` (carries / does not carry, Hand off / Start fresh / Switch back) from the agent select and the palette; `handoff` events render as divider rows.

## What Phase 7 shipped

- Pane geometry is a setting (`Settings.paneLayout`, optional; `src/shared/layout.ts` sanitises/clamps): APG `Splitter` for sidebar/inspector/terminal (keys, drag persisted on release, dblclick reset), `clampLayout` auto-collapses the inspector below a 420px main pane and restores on grow; sidebar rail (`PaneRail`) with aria-expanded toggles.
- Terminal is a bottom drawer (⌃`), shells stay mounted (also while the browser is wide); the inspector is Changes + Browser only.
- Tool rows are `<details>` (no name; body only while open; per-thread disclosure state in the store, never persisted); Run output with exit code; one `DiffView` for every agent's edits.
- Browser: device emulation (`browser_open` `device`, toolbar switch), Page/Console view fed in-band, screenshot strip + viewer via a narrow `unskilled-shot://` scheme (screenshots folder, .png only; CSP img-src allows it), "Move to main area" (conversation becomes a rail, emulation cleared). Smoke asserts the pane's sandbox posture.
- Take-over: `takeOverReducer` (exclusive lock), banner (Stop/Resume/Watch only), transparent overlay over the webview turns a click/key into "you took over"; the main process refuses the agent's acting browser tools while paused.
- Four-driver render parity (F2): `diffSummary` ("+a −d") on every adapter's edit result; Claude results carry Run `{exitCode:null, output}` / Edit `{diff}`; ACP execute/edit rows are summarised from `rawInput.command` / the edited path (OpenCode titles calls "bash"/"edit"), and a terminal update recovers its call's kind; `canonical`/`canonical-opencode` mock scenarios, `test/fixtures/canonical-events.ts`.
- One rendering contract: `src/shared/tools.ts` (`canonicalTool`, `clipSummary` 160 + "…"), `src/shared/diff.ts` (`parseUnifiedDiff` moved here, `unifiedDiff`); canonical Run/Edit payloads from Claude, Codex and ACP; Markdown renderer kept (element-building, no raw HTML — asserted by a test) and pinned by `test/markdown-dialect.test.tsx`, plus GFM tables and strikethrough.

## Resume here: Phase 8 (UI refinement)

- Spec: `spec/phases/phase-8-ui-refinement.md`; write `.ai/plans/phase-8-ui-refinement.md` first. It owns the narrow-header fix and the `ProviderSheet.tsx` id branches (Open items).
- Carried from Phase 7: check a real OpenCode run for `rawInput`/`locations` arriving only on a later `tool_call_update` (the tool row's summary would then read "bash"/"edit").

## Windows portability (`src/main/winspawn.ts`)

`spawnCommand`/`execCommandSync` resolve a bare name on PATH and run `.cmd` shims through cmd.exe with cross-spawn-style double escaping (Codex `-c` values survive); `killTree` uses a synchronous `taskkill /T /F` (a plain `kill()` left `opencode.exe` running). Non-Windows paths are unchanged.

## Open items

- **This Windows PC:** Node 22.17 → `db.test` worker test fails (`Unknown file extension ".ts"`); needs Node ≥ 22.18. `codex-e2e` "offers the browser tools…" fails under full-suite load only: its first request goes out before the mock stdio `docs` MCP server is up (passes alone) — consider `startup_timeout_sec` for app MCP servers.
- **Phase 6 carried forward:** T6.5 stale-cursor path (mark the binding `lost`, re-seed) and T6.11's lighter model-switch card; small threads can't be handed off (the checkpoint would exceed what it replaces — by design).
- **This PC's accounts:** Codex returns 401 "workspace routing unauthorized" (sign in again); a Codex "retrying" status notice stays on screen after the turn ends (seen in the app, pre-existing) — Phase 7/8.
- **Narrow main pane (Phase 8 header work):** with resizable panes the main column can be 420–500px; the header then clips the permission-mode control (only "Ask" visible) and hides the thread title. Needs a header that wraps or collapses meters at narrow widths.
- **Renderer id branches:** `ProviderSheet.tsx` still checks `agent.id === "claude"/"codex"/"antigravity"` — out of T3.8's `src/main` scope; fold into phase 8's Settings work.
- Manual checks still pending: Claude on a BYOK provider in-app; `dsh` receiving its key; model-picker search/provider name (user request, unscheduled).
- `CLAUDE_CODE_PROMPT_CACHE_TTL` / gateway model discovery have no Provider field; OpenCode BYOK is openai-chat only.

## Environment facts

- **Windows PC:** bun 1.4.2, Node 22.17, codex-cli 0.157.1 (npm shim, ChatGPT login), opencode 1.18.32 (npm shim), no `python` in Git Bash, delegation proxy on `127.0.0.1:3900`.
- Headless preview check without agent-browser (no `AGENT_BROWSER_EXECUTABLE_PATH` in Git Bash): `chrome --headless=new --enable-logging=stderr --v=0 --virtual-time-budget=6000 --dump-dom http://localhost:5199/?state=thread`.
- **Mac:** Node 24, codex 0.157, delegation proxy on `127.0.0.1:4141`.
- **Never** touch `~/.config/opencode/opencode.json` (powers the delegation workers) or `~/.codex` in tests. Use temp `XDG_*` / `CODEX_HOME`. Run `electron . --smoke --user-data-dir=<tmp>`.
- **Delegation status (2026-09-27 morning):** the Token Harbor free models started failing on long briefs (empty output, 40-min timeouts); `oc-run` fell back to Qwen3.8 Flash / GLM 5.3 Flash (Agent Pass). `oc-run` now also drops a model after `--idle` seconds with no activity (default 480; tested with a fake opencode), so a hung model no longer holds the chain for the whole `--timeout` — dispatch F2 with e.g. `--timeout 1800 --idle 300`. If models keep failing, write the brief shorter or do the step directly. A capabilities test ("turns off a preset's claimed capability…") flaked once under full-suite load; passes alone.
- **Delegation:** dispatch with `node ~/.config/opencode/oc-run.mjs --worker <agent> --brief … --out … --log …` (walks the model chain itself — `opencode run` exits on the first model error, so the fallback plugin never fires headless). Write briefs with the Write tool (a bash heredoc with backticks broke once). No key-like strings, "dispatch exactly once". Routing and setup: `SETUP-OTHER-PC.md`.
- **Driving the real app:** launch `electron . --user-data-dir=<tmp> --remote-debugging-port=9333 --inspect=9339`; drive the window over CDP (`Input.dispatchKeyEvent/MouseEvent`, `Page.captureScreenshot`; clicks are CSS px = screenshot px / 1.25 on this PC); patch `dialog.showOpenDialog/showSaveDialog` through the main-process inspector **every launch**, or a real file dialog opens off-screen. Native `<select>` popups can't be driven — use the palette.

## Next

Finish Phase 7 (above), then Phase 8 (UI refinement), then Phase 9 (release hardening). Run them back to back without stopping, except for a big blocker (memory `autonomous-phase-loop`).
