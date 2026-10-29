# Phase 8 — UI refinement toward T3 Code / WorkBuddy

Depends on **7** for the shell parts (rail, drawer, splitter — Phase 7 owns them; T8.6/T8.7 below only verify them), **1** for T8.12's *Agents & Providers* group, and **6** for T8.8's handoff rows and T8.13. Three sub-passes, each independently shippable and each leaving `pnpm typecheck`, `pnpm test` and `pnpm build` green. Keep the paint; replace the carpentry (Ch. 9 thesis). Every task below is one or two files by design (Ch. 9 §9.9).

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/09-ui-refinement.md`](../../plan/docs/09-ui-refinement.md) — the whole chapter: §9.1 what each benchmark actually documents, §9.2 the shell regions, §9.3 navigation and thread lifecycle, §9.4 the Message Center, §9.5 the composer, §9.6 the Settings IA, §9.7 motion and density, §9.8 the adopt/adapt/avoid table, §9.9 the three passes this file implements.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 1 §1.1 (T3 Code: threads, worktrees, permission modes, its alpha status) and §1.4 (WorkBuddy: parallel tasks, artifacts, the Changes review panel). The two products this phase benchmarks against.
- [`plan/docs/07-ui-ux.md`](../../plan/docs/07-ui-ux.md) — §7.8, the states and microcopy inventory the inbox rows must satisfy.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — none.

---

## Pass 1 — no new data

### T8.1 — Section the thread list into Pinned / Active / Settled
- **What:** replace the flat recency sort in `upsertThread` with sectioned rendering: **Pinned**, **Active**, **Settled** (auto after ~3 days idle, mirroring T3). Snoozed is explicitly out of scope for M4.
- **Files:** `src/renderer/src/store.ts` (modify), `src/renderer/src/components/Sidebar.tsx` (modify), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** a thread whose `updatedAt` is more than 3 days old and which is not running renders under a **Settled** heading; a thread updated within 3 days renders under **Active**; within a section the order is `updatedAt` desc. Asserted by a unit test on the sectioning selector and observable in `?state=thread`.
- **Notes:** Ch. 9 §9.3. Today `store.ts:83-86` sorts flat by `updatedAt`; `Thread.updatedAt` already exists (`src/shared/types.ts:174`), so auto-settle is a query, not a migration. Pinned is a **session-local** `Set<threadId>` in Pass 1 (no persistence) and is promoted to a `threads.pinned` column in Pass 3 — say so in the UI so a restart dropping a pin is not a surprise.

### T8.2 — Label each thread row with its agent and branch
- **What:** add a quiet second line (or trailing chip) to the thread row: the agent label, and the branch when the thread is on one. Today `Sidebar.tsx:44-57` renders only `t.title` and a spinner.
- **Files:** `src/renderer/src/components/Sidebar.tsx` (modify), `src/renderer/src/store.ts` (modify), `src/renderer/src/styles/app.css` (modify), `src/main/git.ts` (modify: add a read-only current-branch read)
- **Acceptance:** with two threads on different agents, each row shows its own agent label; a thread in a project whose HEAD is on a non-default branch shows that branch; a thread with no branch shows no branch chip. Observable in `?state=thread`.
- **Notes:** Ch. 9 §9.3, §9.8 ("Branch label on a thread row — Adapt now"). `git.ts` today exposes only the working-tree diff against HEAD (`workingTreeDiff`, `git.ts:53-89`), so a small branch read (`git rev-parse --abbrev-ref HEAD`) is added. Until worktrees land (T8.13) all threads in a project share the project's branch; `Thread.branch` becomes a real field only in Pass 3.

### T8.3 — Make the palette's `>` prefix actions-only
- **What:** a query beginning with `>` filters to `section === "Actions"` and strips the prefix before scoring, so the palette becomes a command surface rather than a search box.
- **Files:** `src/renderer/src/palette.ts` (modify), `src/renderer/src/components/CommandPalette.tsx` (modify)
- **Acceptance:** typing `>new` lists only Action rows; typing `new` still lists Actions + Skills + Threads. Unit test on `rankCommands(commands, ">…")`.
- **Notes:** Ch. 9 §9.3. `rankCommands` (`palette.ts:23`) already orders Actions first; this is a filter, not new ranking.

### T8.4 — Add ⌘1–9 thread jumps
- **What:** ⌘/Ctrl+1..9 selects the nth thread in the current project's visible order. Ignore while a modal (`.palette`, `.sheet`, `.library`) is open.
- **Files:** `src/renderer/src/App.tsx` (modify the keydown handler at `:35-67`), `src/renderer/src/store.ts` (modify: resolve nth visible thread)
- **Acceptance:** with ≥3 threads, ⌘1 selects the first and ⌘3 the third; ⌘9 with fewer than nine threads does nothing. Unit test on the resolver plus a manual check.
- **Notes:** Ch. 9 §9.3. Do not shadow the `<webview>`'s own ⌘1–9 tab shortcuts when the browser pane has focus.

### T8.5 — Add a motion preference defaulting to instant
- **What:** add `motion: "instant" | "subtle" | "full"` to Settings, default `instant`; gate the inspector animation (`app.css:524`, `animation: slide-in 220ms var(--ease)`) and make thread switches snap panel state instead of replaying it. `prefers-reduced-motion` stays authoritative and overrides to instant.
- **Files:** `src/shared/types.ts` (modify), `src/main/settings.ts` (modify: `DEFAULTS` at `:19` + `update()`), `src/renderer/src/components/SettingsSheet.tsx` (modify), `src/renderer/src/styles/app.css` (modify), `src/renderer/src/App.tsx` (modify: apply `data-motion`)
- **Acceptance:** a unit test asserts the default `Settings.motion === "instant"` and that `App` writes `data-motion` on the root; a test reads `app.css` and asserts the inspector animation is scoped to `[data-motion="full"]` (or `subtle`) and wrapped in `@media (prefers-reduced-motion: no-preference)`. Manual check in `pnpm preview:ui` (the suite has no DOM for computed styles): default opens instantly, **Full** restores the 220 ms slide, OS reduce-motion keeps it instant.
- **Notes:** Ch. 9 §9.7. T3's slider is 0–400ms default 0. This adds a Settings field, not thread data, so it is still "no new data".

### T8.6 — Sidebar rail: verify, add the shortcut
- **What:** the rail itself is **Phase 7 T7.3** (`PaneRail.tsx`). This task only adds what T7.3 does not: a keyboard shortcut for the toggle, and the check that every footer control (settings, library, update, and T8.8's bell) stays reachable and titled in rail mode.
- **Files:** `src/renderer/src/App.tsx` (modify: shortcut), `src/renderer/src/components/PaneRail.tsx` (modify)
- **Acceptance:** the shortcut toggles the rail; in rail mode every footer control has a `title` and is reachable by Tab; the choice survives a restart (T7.2's persisted geometry).
- **Notes:** Ch. 9 §9.2, Ch. 8 §8.2. Do not build a second rail; if Phase 7 has not shipped, land T7.3 first.

### T8.7 — Terminal drawer: covered by Phase 7 T7.4
- **What:** the drawer is **Phase 7 T7.4** (same acceptance: ⌃\` toggles a bottom drawer, height persists, `TerminalPanel` stays mounted). Nothing to build here; tick this row when T7.4's exit criterion is met. The right panel becomes **Changes · Browser · Files** once T8.9 lands.
- **Files:** none beyond T7.4.
- **Acceptance:** Phase 7's "Terminal is a bottom drawer" exit criterion is checked.
- **Notes:** Ch. 9 §9.2, §9.8. Kept as a row so Pass 1's checklist still reads as Ch. 9 §9.9 lists it.

---

## Pass 2 — new state, no schema change

### T8.8 — Add the Message Center inbox
- **What:** a bell in the sidebar footer opening a full-page overlay with two groups — **Needs you** (pending `store.permissions`, already a cross-thread array, plus phase-6 handoff confirmations) and **Finished** (turns that ended while their thread was not selected). Each row jumps to its thread. One new store slice (`inbox`), one new component.
- **Files:** `src/renderer/src/components/MessageCenter.tsx` (new), `src/renderer/src/components/Sidebar.tsx` (modify), `src/renderer/src/store.ts` (modify: derive "finished" in `apply`'s `running:false` branch at `:300-308` against `selectedThreadId`), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** (store-level, via a pure selector over `permissions` / `running` / `selectedThreadId`) a permission raised on thread A while thread B is selected produces an inbox row; a turn that ends on an unselected thread produces a **Finished** row with title, agent and duration; clicking a row selects that thread and clears its row; transient confirmations stay the 3.5s `Notice` (`store.ts:120-124`) and do not enter the inbox.
- **Notes:** Ch. 9 §9.4. Justification: today a permission on a background thread is invisible until you open it (`ThreadView.tsx:51-53`). Handoff rows depend on phase 6.

### T8.9 — Add a Files tab to the right panel
- **What:** the third right-panel tab (after T8.7), a workspace file tree and the natural companion to file links in the transcript.
- **Files:** `src/renderer/src/components/FilesPanel.tsx` (new), `src/renderer/src/components/Inspector.tsx` (modify), `src/renderer/src/store.ts` (modify), `src/renderer/src/styles/app.css` (modify), plus a main-process tree read reusing an existing fs walk (no new dependency)
- **Acceptance:** the tab lists the project tree, excluding `.git` and `node_modules` by default; clicking a file opens it at line 1 in the configured editor via the existing `openInEditor` path; the tab is absent when no project is open.
- **Notes:** Ch. 9 §9.2, §9.8 (WorkBuddy's Workspace Files tab).

### T8.10 — Render composer context chips
- **What:** a picked browser element (today appended to the end of the textarea at `Composer.tsx:59`) becomes a discrete chip token at the caret, reusing the existing `.skill-chip`; insertion stays simple.
- **Files:** `src/renderer/src/components/Composer.tsx` (modify), `src/renderer/src/store.ts` (modify: insert shape), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** after picking an element, one chip renders in the composer bar instead of a wall of pasted text; backspace with an empty textarea removes the last chip; sending includes the chip's text in the message.
- **Notes:** Ch. 9 §9.5.

### T8.11 — Accept and queue a message sent mid-turn
- **What:** stop blocking send while a turn runs (`Composer.tsx:79`); accept the message, render it as a dashed **queued** bubble, and deliver it at the start of the next turn. One new event kind and one explicit delivery rule.
- **Files:** `src/renderer/src/components/Composer.tsx` (modify), `src/renderer/src/store.ts` (modify: queue state + delivery), `src/shared/types.ts` (modify: new `ThreadEvent` kind), `src/main/service.ts` (modify: deliver on next `runTurn`), `src/renderer/src/styles/app.css` (modify: `.bubble.queued` dashed)
- **Acceptance:** sending while `running[threadId]` is true enqueues and renders a dashed bubble; the queued text is sent exactly once, at the start of the next turn, and the bubble becomes a normal user bubble; stopping the turn clears the queue.
- **Notes:** Ch. 9 §9.5. Ship queue only; steering is a later addition. The new kind is additive in `ThreadEvent` (`src/shared/types.ts:181`) and stored as a JSON payload, so no DB schema change — but confirm `EventRow`'s switch default ignores an unknown kind rather than crashing.

### T8.12 — Regroup Settings into a left-nav IA
- **What:** replace the single scrolling sheet's sections (six today, `SettingsSheet.tsx:52-182`; Phase 1 replaces *API keys* with the provider list) with left-nav + right-content groups: **Appearance · Threads · Agents & Providers · Skills & MCP · Data & Security · Updates**. Keep the `.sheet` chrome and the Esc/backdrop-dismiss behaviour (`SettingsSheet.tsx:35-53`).
- **Files:** `src/renderer/src/components/SettingsSheet.tsx` (modify), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** each group is reachable from the left nav without scrolling the whole sheet; Esc and backdrop-click still dismiss; every existing control (theme, default agent/mode, editor, providers + per-agent credential row, auto-update, skills/agents) is reachable in exactly one group. A test asserts each former section heading maps to one group.
- **Notes:** Ch. 9 §9.6. Phase 1 lands the provider list first, inside the old sheet; this task moves it into **Agents & Providers** unchanged. (Ch. 9 says the IA is "required once providers exist" — true for usability, but Phase 1 must not wait on it.)

---

## Pass 3 — depends on earlier phases

### T8.13 — Worktree-per-thread and background start
- **What:** give a thread its own git worktree on a new branch, label the branch on the row (T8.2), and allow starting a thread in the background.
- **Files:** `src/main/git.ts` (modify), `src/main/service.ts` (modify), `src/renderer/src/store.ts` (modify), `src/renderer/src/components/Sidebar.tsx` (modify), `src/shared/types.ts` (modify: `branch`, `worktreePath` on `Thread`)
- **Acceptance:** starting a worktree thread creates a branch and worktree, shows the branch on the row, and runs the thread's tools inside the worktree; a background-started thread runs unselected and reports completion through the Message Center.
- **Notes:** Ch. 9 §9.8 ("Adapt later"). **Depends on phase 6's `bindings`** and on git plumbing; do not land before the thread export/import safety net (Phase 6 T6.2, verified by Phase 9 T9.7) — a worktree path in a binding is one more piece of state a rollback must survive.

### T8.14 — Add a density preference (Comfortable / Compact)
- **What:** `density: "comfortable" | "compact"` affecting `.thread-row`, `.tool-row` and `.turn-meta` line heights.
- **Files:** `src/shared/types.ts` (modify), `src/main/settings.ts` (modify), `src/renderer/src/components/SettingsSheet.tsx` (modify), `src/renderer/src/styles/app.css` (modify)
- **Acceptance:** a test asserts `app.css` defines smaller `.thread-row`/`.tool-row`/`.turn-meta` line heights under `[data-density="compact"]` and that the setting round-trips through `SettingsStore`; the visual difference is checked manually in `pnpm preview:ui`.
- **Notes:** Ch. 9 §9.7. Long transcripts are the dominant content, so density is the knob users reach for.

### T8.15 — Render-parity snapshot test
- **What:** if phase 7 did not already land Ch. 8 §8.5's render-parity snapshot (T7.12), add it: the same transcript rendered through the Claude, Codex and ACP adapters (with an OpenCode-flavoured and a DeepSeek-flavoured ACP fixture), snapshotted.
- **Files:** `test/render-parity.test.tsx` (new), `test/fixtures/*` (reuse)
- **Acceptance:** the test fails if any adapter's rendered transcript diverges from its committed snapshot; CI runs it in the three-OS `test` job Phase 0 T0.9 creates.
- **Notes:** Ch. 9 §9.9, Ch. 8 §8.5. Check phase 7's exit criteria first; skip if it already shipped.

---

## Adopt / adapt / avoid — the actions

| Pattern | Action | Where |
|---|---|---|
| Three collapsible regions; terminal as a drawer | **Adopt** | T8.6, T8.7 |
| Tabbed right panel (Changes / Browser / Files) | **Adopt** | T8.9 |
| Lifecycle sections (Pinned / Active / Settled) | **Adopt** | T8.1 |
| Message Center inbox | **Adopt** | T8.8 |
| Composer chips, queued bubble, mode in the composer | **Adopt** (chips + queue); move the mode control next to send if room | T8.10, T8.11 |
| Settings left-nav IA | **Adopt** | T8.12 |
| Motion default instant; density | **Adopt** | T8.5, T8.14 |
| `>` palette mode, ⌘1–9, ⌘[ / ⌘] | **Adopt** (`>` and ⌘1–9 now; ⌘[ / ⌘] later) | T8.3, T8.4 |
| Worktree-per-thread, background start, fan-out by shift-clicking models | **Adapt later** | T8.13 |
| Branch label on a thread row | **Adapt now** | T8.2 |
| **T3's default of Full access permissions** | **Avoid** — our default stays **Ask** (`App.tsx:14`, `settings.ts:19`); do not flip it | — |
| T3's release posture (`0.0.x`, "expect bugs", contributions closed) | **Avoid** — take patterns, not process | Ch. 6 §6.7 |
| WorkBuddy scenario tabs (office / code / design), credits, expert teams | **Avoid** — office-work mental model, wrong for a code-first harness | — |
| VS Code theme import | **Defer** — large surface, low core value | — |

---

## Risks & rollback

- T8.1's Pinned is session-local in Pass 1; document it in the UI and promote it to a column in Pass 3 rather than silently persisting nothing.
- T8.5/T8.14 add Settings fields. An older build reading the file ignores unknown fields (`settings.ts` spreads `data.settings`), so downgrade is safe — verify with a round-trip test.
- T8.7/T8.13 touch layout and git. If the drawer or worktree destabilises the shell, revert that single task; Pass 1 tasks are one-or-two-file changes by design.
- T8.11's new event kind: an older renderer must ignore an unknown `kind`, not crash.
- T8.13 is gated on phase 6 and phase 9's migration net; do not land it standalone.

## Exit criteria

- [x] Pass 1 shipped: sections, agent/branch labels, `>` palette mode, ⌘1–9, motion default instant; sidebar rail and terminal drawer verified from Phase 7 (T7.3, T7.4) plus the rail shortcut (⌘\); `?state=thread` shows sections; typecheck/test/build green (2026-09-27, bun; the known Node 22.17 `db.test` failure and the load-sensitive `codex-e2e` case only). Checked in the app.
- [x] Pass 2 shipped: Message Center, Files tab, context chips, queued bubble, Settings IA; a background permission produces an inbox row (checked with a real Claude permission on a background thread, a Finished row, a real queued turn and a real browser pick).
- [x] Pass 3 shipped or explicitly deferred with a note: density shipped (T8.14); render parity shipped as Phase 7 T7.12 (T8.15 skipped, see below); worktree/background deferred (T8.13, see below).
- [x] No "Avoid" row is implemented: no Full-access default, no office tabs, no theme import.
- [x] Every acceptance criterion above passes; this checklist is copied into the PR description.

**Deferred:** T8.13 (worktree-per-thread, background start) and the Pinned column it would bring: the spec gates it on Phase 9 T9.7's migration net, so it lands after Phase 9. Pins stay session-local, and the UI says so ("Pinned · this session").

**Skipped:** T8.15, since Phase 7 T7.12 shipped `test/render-parity.test.tsx` (Claude, Codex, generic ACP and OpenCode-flavoured ACP rendered string-equal). A DeepSeek-flavoured ACP fixture is not added: how `dsh` titles its calls is unverified.

**Also shipped here:** an opaque sidebar when the window has no vibrancy or Mica (Windows 10 showed a grey, unreadable one); `AgentInfo.credentials` replaces the Settings sheet's agent-id checks, and the id-branch scan now covers the renderer; every entrance animation follows Motion; the narrow header wraps (title row, agent picker left to the palette) and the browser bar wraps; in-thread notices no longer float as toasts.

**Not an inbox row:** handoff confirmations. The switch dialog is modal on the open thread, so there is no cross-thread confirmation to list.
