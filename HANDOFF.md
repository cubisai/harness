# Handoff — Phases 0–10 done (10 = skills, MCP scopes, guide, effort, sidebar)

Updated 2026-09-27 (evening) on the Windows PC, branch `m4`, last commit on it is this file. Phase 10 plan and status: `.ai/plans/phase-10-skills-ui.md`. Read **Resume here** first, then "After Phase 9" below, then `CLAUDE.md` (the opencode-delegation workflow). Memories that apply: `autonomous-phase-loop` (don't ask, keep going), `commit-only-own-paths` (the user's bun switch stays uncommitted; commit with explicit paths), `two-machines` (every fix must work on Windows and macOS).

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
| 8 — UI refinement | **done** (T8.13 worktrees deferred behind Phase 9 T9.7; T8.15 = T7.12): typecheck, build, smoke green; tests green except the known Windows-machine items; every step checked in the real app | A `d04d0a7`, B `b9466a8`, C `ab804df`, D+F `95b97b7`, E `3153964`, G `89ba506` |
| 9 — Release hardening | **done** except the human rollback drill and a first CI run on GitHub; typecheck, build, dev and packaged smoke green (all four new checks); tests green except the known Windows-machine items | A `1b3a739`, C `839106a`, B+D `b6e76cc`, E `1d4a8e8`, F `9283407` |
| Windows portability | done | `ae0b0cc` |
| bun switch (user's, committed at their request) | done | `ab42bb9` |
| 10 — Skills, MCP scopes, guide, effort, sidebar | **done** except the OpenCode variants spike; typecheck, build, smoke green; tests green except the known Windows-machine items; every step checked in the real app (OpenCode + Codex turns; one Claude turn at the end) | 10A `0489835`, 10B `a46d5e0`, 10C `92ca50d`, 10E `a00acf0`, 10B2 `cbcc2aa`, schema fix `f937edc`, 10D `3f48d8d`, 10G `6e8f916`, guard `ad338c6`, UI `8848788`, ACP rows `f893297` |

**Uncommitted on purpose (the user decides):** the `CLAUDE.md` notes (Windows notes + the new worker model order) and `SETUP-OTHER-PC.md`. The bun switch is committed (`ab42bb9`). `test/__snapshots__/providers.test.ts.snap` shows as modified: line endings only. Phase commits carry code + tests only, with no attribution trailer.

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

## What Phase 8 shipped

- Sidebar: Pinned (session-local) / Active / Settled sections (`src/renderer/src/sections.ts`), agent label and non-default branch on each row (`branchLabel()` in `git.ts`, IPC `project:branch`), Ctrl/⌘1–9 jumps, Ctrl/⌘\ rail toggle; the rail keeps every footer control.
- Palette `>` = actions only. Message Center (`inbox.ts`, `MessageCenter.tsx`): permissions on other threads + turns that finished unseen. Files tab (`FilesPanel.tsx`, `listProjectFiles()`: `git ls-files` or a bounded walk). Context chips for picked elements; mid-turn sends queue (`store.outbox`, delivered once on the turn's end, Stop clears).
- Settings: left-nav groups (`SETTINGS_GROUPS`), `motion` (default instant; gates every entrance animation, reduce-motion wins) and `density` settings. `AgentInfo.credentials` (byok / own / injector) replaces the renderer's agent-id checks; `test/no-agent-id-branches.test.ts` scans the renderer too.
- Windows 10: no Mica there, so main passes `--opaque-sidebar` and the sidebar is painted opaque (it was grey and unreadable). Narrow main pane: the header drops meters, then wraps (title row; agent picker left to the palette); the browser bar wraps. In-thread `.notice` rows no longer float (the toast is `.toast`).

## What Phase 9 shipped

- Antigravity: preset fields `optIn` + `unsupported`; `loadAcpAgents(..., { optedIn })` (also gates an agents.json override); `Settings.antigravity` + `antigravityAck` (versioned, stamped by main, `SettingsStore.antigravityEnabled()`); Settings → Agents & Providers opt-in with the ToS disclosure; amber `UnsupportedChip` in the Library, sidebar rows and Settings; never a BYOK row.
- Settings export/import (Data & Security; keys stay machine-bound ciphertext; opt-in never carried), corrupt settings.json copied to `.corrupt-<ts>`, Linux `basic_text` no longer counts as encryption.
- Rollback: `cumulativeHitRate` / `hitRateRegression` / `prefixStability` + `Store.turnUsage`, `scripts/rollback-check.mjs`, `plan/docs/rollback.md`; frozen M3 `Store` fixture proves the downgrade; `toThread` lets a disagreeing `session_id` win (fixes pre-bindings export imports and post-downgrade cursors).
- Smoke: `src/main/smoke-checks.ts` (providers, migration, handoff, render parity via `window.__unskilledSmokeRender` in `--unskilled-smoke` mode); `scripts/smoke.mjs` finds `AI Harness`; CI env allowlist + Linux packaged-smoke job; `manual/**` excluded from vitest.

## What Phase 10 shipped (2026-09-27)

- **Sidebar**: toggle beside the wordmark; full-width New thread (Ctrl/⌘N); a + on each project row (hover) for a thread in that project; one label style; chevrons for projects and Archived; the splitter no longer covers rail buttons. **Lucide** icons (`icons.tsx`, same export names). Browser pane: "Nothing open yet" and "Can't reach <url> · Retry" instead of a white page; "Main area" labelled. Add Project errors now toast (it worked in the real app; the user's "nothing happened" was not reproduced).
- **Skills** (`src/main/skills/discover.ts`, `sources.ts`, `tool.ts`): Agent Skills SKILL.md frontmatter; sources by precedence project `.agents/skills` > app `<userData>/skills` > `~/.agents/skills` > bundled `resources/skills` > legacy `AIHARNESS_SKILLS_DIR`; per-skill on/off (`Settings.skills.disabled`). Delivery without duplicates (`SkillsDelivery.reads`): Claude plugin (per cwd; skips names in `~/.claude/skills` and `<cwd>/.claude/skills`), Codex extraRoots, dsh envDir, OpenCode/Cursor/Antigravity the `skill` tool on `/mcp-skills`. The `/` menu lists every user-invocable skill (model ones too). Library → Skills: groups by origin, switches, New skill, Folders.
- **Built-in skills** (`resources/skills`, packaged via `extraResources`): browser, docx, pdf, xlsx, pptx, skill-creator — our own text; the Node libraries they name were exercised for real. Anthropic's docx/pdf/pptx/xlsx are source-available, never bundled.
- **Guide**: `resources/HARNESS.md` (+ `<userData>/HARNESS.md`, `<project>/.agents/HARNESS.md`) → Claude `systemPrompt.append`, Codex `developerInstructions`, ACP once in the first prompt of a new session. Confirmed by Claude, OpenCode and Codex in real turns.
- **MCP** (`McpScopes`): global `<userData>/mcp.json` + per project `<userData>/projects/<id>/mcp.json` with `offGlobal`; Connectors tab scope switch, "From All projects" toggles, agents' own servers listed read-only.
- **Tool server**: every schema carries `required: []` (OpenCode + AgentRouter rejected `browser_logs` without it, so every OpenCode turn failed while the browser tools were offered).
- **Effort** (10G): `Thread.effort` (migration **13**), `ModelOption.efforts/defaultEffort`; Claude `options.effort` + `thinking: adaptive/summarized` when supported; Codex `turn/start.effort` + `summary: "auto"`; ACP `thought_level` via `session/set_config_option`. Brain-icon picker after the model; Ctrl/⌘+Alt+, / . cycle. OpenCode 1.18.32's ACP has no thought_level, so no picker there (variants spike in the plan).
- **Reasoning** stays expanded (only the user collapses it). The agent picker is a themed menu (Windows drew the native select popup light in dark mode); native `<option>`s are themed.
- **Git guard always on**: `guard-rules.ts` ports the skilled git-guardrails script (all `git push`, `reset --hard`, forced `clean`, `branch -D`, `checkout/restore .`, DB/infra destroyers); used when there is no script or no Python. `unwrapShell` handles `powershell -Command '…'` and `cmd /c` (Codex on Windows wrapped commands the guard never saw). OpenCode's plugin guard still needs Python + the script.
- **ACP tool rows**: harness tools named like Claude's (`browser_open`, `skill`) with their argument; a call is announced once its arguments arrive (OpenCode sends them on a later update), at the latest at its first output or its end. Closes the Phase 7 carried item.

## After Phase 9: fixes from the user's own testing (2026-09-27)

All checked in the real app on Windows; code paths are cross-platform unless noted.
- **Layout** `03fbe3f`: the app grid row sizes to the window (a long thread list pushed the header away and nothing scrolled).
- **Windows env** `47b249a` `7e572d3`: at startup the app fills user env vars and PATH folders it lacks (from `HKCU\Environment`), so an app started from an old terminal still gets `TOKENHARBOR_API_KEY` (OpenCode's config) and finds CLIs installed since (`agy`). Windows-only by design.
- **Empty replies / Claude limits**: a turn that ends with nothing says so; Claude's own account-limit text is the error (it was "Rate limited" plus the text posing as a reply).
- **Codex** `8cbf5fa` `d020826`: the long-lived `codex app-server` kept a stale login (401 "workspace routing discovery" on every model); it restarts when `$CODEX_HOME/auth.json` changes, and the model list (Codex's own `model/list`, which is per plan: a free account gets 4) is re-read on login change and on window focus.
- **Threads**: rename / pin / archive / delete from a ⋯ row menu; pins and archive persist (migration 12: `pinned`, `archived`).
- **Model picker** `dc03777`: searchable, grouped by provider (OpenCode lists 87).
- **Streaming** `ad051ea`: replies and reasoning revealed at a steady pace (`smooth.ts`, `useSmoothText`); Claude Code-style waiting line.
- **UI**: header = title + panel toggles; agent / model / permissions and meters live in the message box; the project start screen asks "What should we build in <project>?" (no skill cards); Settings icon is a cog.
- Verified per model: Claude Opus/Sonnet/Haiku/Opus 1M ok (Fable 5.1 = the account's spend limit); OpenCode + 6 of 8 Token Harbor models ok (the two `:free` DeepSeek/MiMo return empty, provider-side); Codex Luna/Terra ok after the login fix.

**Open from this round:**
- **T8.13 WIP is stashed**: `git stash list` → "T8.13 WIP: worktree threads, background start, persisted pins". Its migration must become **step 13** and drop its `pinned` parts (step 12 now owns pins); `sendInBackground` and the worktree service code are in it.
- **Lucide icons**: the user asked for `lucide-react`. Adding a dependency touches `package.json` + the lockfile, which are in the user's uncommitted bun switch; do it (`bun add lucide-react`, replace `icons.tsx`) right after that switch is committed.
- **Antigravity**: `agy` is at `%LOCALAPPDATA%\agy\bin`, but the app drives it through `agy-acp` (not installed; the user installs it) and it stays off until the Settings opt-in.
- Still to confirm on the Mac: the same smoke/model checks there.

## Resume here

State of the tree: everything of ours is committed. Uncommitted on purpose (the user's): `CLAUDE.md` notes, `SETUP-OTHER-PC.md`, and a line-ending-only snapshot. Before any commit: `git diff --cached --stat` must show only your files.

In order:
1. **OpenCode reasoning variants** (user note: levels depend on the model and provider): the spike in `.ai/plans/phase-10-skills-ui.md` (10G follow-up) — read `variants` from `opencode models --verbose`, apply via `OPENCODE_CONFIG_CONTENT` agent options + ACP respawn + `session/load`; only then wire the picker.
2. **T8.13 from the stash**: `git stash list` → "T8.13 WIP: worktree threads, background start, persisted pins". Its migration must now be **step 14** (13 = effort); drop its `pinned` parts; finish `sendInBackground` (Alt+Enter) and "New Thread in Worktree". Spec: `spec/phases/phase-8-ui-refinement.md` T8.13.
3. **Keep polishing the UI toward T3 Code** (ongoing user request): check every screen in both themes; Settings/ProviderSheet still use native selects (their options are themed now).
4. **On the Mac**: `electron . --smoke`, packaged smoke, one turn per agent (Python is there, so the script guard path runs; also check the built-in path).
5. **Antigravity**: needs `agy-acp` + the Settings opt-in (unchanged).
- Needs a person: rollback drill (`plan/docs/rollback.md`), first CI run on GitHub.

**Testing note (user, 2026-09-27):** the user's Claude limit is low — do live checks with OpenCode (DeepSeek via AgentRouter) and Codex (Luna/Terra; Sol is not on their ChatGPT plan), and keep Claude to one short confirming turn. Everything must still work with Claude.

**Worker routing (user, 2026-09-27):** every opencode worker: AgentRouter DeepSeek v4 Flash → Token Harbor paid DeepSeek v4.1 Flash → Qwen3.7 Flash (backup of the old config: `~/.config/opencode/opencode.json.bak-2026-09-27`). The AgentRouter proxy must listen on 127.0.0.1:3900 (`~/.config/opencode/start-proxy.bat`). DeepSeek via AgentRouter answered every brief on the first try (10B, 10E, 10B2, 10D, 10G), 10–30 min each.

## Windows portability (`src/main/winspawn.ts`)

`spawnCommand`/`execCommandSync` resolve a bare name on PATH and run `.cmd` shims through cmd.exe with cross-spawn-style double escaping (Codex `-c` values survive); `killTree` uses a synchronous `taskkill /T /F` (a plain `kill()` left `opencode.exe` running). Non-Windows paths are unchanged.

## Open items

- **Flaky under full-suite load (passes alone):** `switch.test` "handoff to an ACP agent" (seen once, 2026-09-27), besides `codex-e2e` below.
- **This Windows PC:** Node 22.17 → `db.test` worker test fails (`Unknown file extension ".ts"`); needs Node ≥ 22.18. `codex-e2e` "offers the browser tools…" fails under full-suite load only: its first request goes out before the mock stdio `docs` MCP server is up (passes alone) — consider `startup_timeout_sec` for app MCP servers.
- **Phase 6 carried forward:** T6.5 stale-cursor path (mark the binding `lost`, re-seed) and T6.11's lighter model-switch card; small threads can't be handed off (the checkpoint would exceed what it replaces — by design).
- **This PC's accounts:** Codex returns 401 "workspace routing unauthorized" (sign in again); a Codex "retrying" status notice stays on screen after the turn ends (seen in the app, pre-existing) — Phase 7/8.
- Manual checks still pending: Claude on a BYOK provider in-app; `dsh` receiving its key; model-picker search/provider name (user request, unscheduled).
- `CLAUDE_CODE_PROMPT_CACHE_TTL` / gateway model discovery have no Provider field; OpenCode BYOK is openai-chat only.

## Environment facts

- **Windows PC:** bun 1.4.2, Node 22.17, codex-cli 0.157.1 (npm shim, ChatGPT login), opencode 1.18.32 (npm shim), no `python` in Git Bash, delegation proxy on `127.0.0.1:3900`.
- Headless preview check without agent-browser (no `AGENT_BROWSER_EXECUTABLE_PATH` in Git Bash): `chrome --headless=new --enable-logging=stderr --v=0 --virtual-time-budget=6000 --dump-dom http://localhost:5199/?state=thread`.
- **Mac:** Node 24, codex 0.157, delegation proxy on `127.0.0.1:4141`.
- **Never** touch `~/.config/opencode/opencode.json` (powers the delegation workers) or `~/.codex` in tests. Use temp `XDG_*` / `CODEX_HOME`. Run `electron . --smoke --user-data-dir=<tmp>`.
- **Delegation status (2026-09-27, Phase 8):** two implementer dispatches (T8.3, T8.9) both landed on Token Harbor's qwen3.8-flash after deepseek-v4.1-flash and mimo-v2.6-flash returned empty output; T8.9 took ~40 min. Parallel dispatch works when the brief lists files the worker must not touch and the orchestrator edits only others. **Earlier (morning):** the Token Harbor free models started failing on long briefs (empty output, 40-min timeouts); `oc-run` fell back to Qwen3.8 Flash / GLM 5.3 Flash (Agent Pass). `oc-run` now also drops a model after `--idle` seconds with no activity (default 480; tested with a fake opencode), so a hung model no longer holds the chain for the whole `--timeout` — dispatch F2 with e.g. `--timeout 1800 --idle 300`. If models keep failing, write the brief shorter or do the step directly. A capabilities test ("turns off a preset's claimed capability…") flaked once under full-suite load; passes alone.
- **Delegation:** dispatch with `node ~/.config/opencode/oc-run.mjs --worker <agent> --brief … --out … --log …` (walks the model chain itself — `opencode run` exits on the first model error, so the fallback plugin never fires headless). Write briefs with the Write tool (a bash heredoc with backticks broke once). No key-like strings, "dispatch exactly once". Routing and setup: `SETUP-OTHER-PC.md`.
- **Git Bash heredocs collapse `\\` to `\`**, so JSON or regex with backslashes written that way breaks; use the Write tool for such files. Stage only your hunks of a file that also carries the user's uncommitted edits by writing HEAD + your replacements to the index (`git hash-object -w` + `git update-index --cacheinfo`); `git add -p` isn't available.
- **Packaging on this PC:** the repo path has a space, so node-gyp can't rebuild node-pty; package with `bunx electron-builder --dir --publish never -c.npmRebuild=false` (the dev `node-pty` binary already targets Electron). The packaged app is `dist/win-unpacked/AI Harness.exe` and uses the real `%APPDATA%/AI Harness` data folder.
- **Driving the real app:** launch `electron . --user-data-dir=<tmp> --remote-debugging-port=9333 --inspect=9339`; drive the window over CDP (`Input.dispatchKeyEvent/MouseEvent`, `Page.captureScreenshot`; clicks are CSS px = screenshot px / 1.25 on this PC); patch `dialog.showOpenDialog/showSaveDialog` through the main-process inspector **every launch**, or a real file dialog opens off-screen. Native `<select>` popups can't be driven — use the palette.

## Next

The Resume list above, top to bottom; then hand the human release checks (rollback drill, first CI run) to the user. Run them back to back without stopping, except for a big blocker (memory `autonomous-phase-loop`).
