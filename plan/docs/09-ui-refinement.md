## 9. Refining the Current UI Toward WorkBuddy and T3 Code: Shell Regions, Thread Lifecycle, an Inbox, Composer Chips, and a Settings IA

**Thesis.** Chapters 7 and 8 specified surfaces that do not exist yet. This chapter is the opposite: a refinement pass over the UI as it stands, benchmarked against the two harnesses the user named. The important conclusion up front is that the *visual* language is not the gap. `styles/app.css` already opens with "calm, native-feeling, one accent" and delivers it — SF Pro / Segoe UI Variable stack, a single `#0a84ff` accent, three radii (6/10/16), hairline borders at 8% alpha, a translucent `--bg-sidebar` for vibrancy, separate light/dark token sets, and a 52px titlebar (`app.css:1-60`). That is a more disciplined system than either benchmark documents publicly. What the current UI lacks is **structure and lifecycle**: T3 Code's three collapsible regions and thread-state model, and WorkBuddy's right-panel tab set and message inbox. So the plan is: keep the paint, replace the carpentry.

### 9.1 What the two benchmarks actually specify

Both were researched from primary sources, and it is worth separating what is documented from what is marketing.

**T3 Code** (github.com/pingdotgg/t3code, MIT) documents its own UI in `docs/user/*.md`, which makes it unusually checkable. The window is **three collapsible regions — a main sidebar, a right panel, and a terminal drawer** ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)). The sidebar is the thread list; the right panel is **tabbed** and hosts device, browser, and diff/PR review — the terminal is a separate drawer, not one of its tabs ([source-control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md), [devices](https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md)). The domain model is Environment → Project → Thread → Turn, and **the thread is the primary object** ([thread-sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)). Threads live in lifecycle **sections — Pinned, Active, Snoozed, Settled** — rather than carrying a status column, with auto-settle after roughly three days idle or a merged PR (same source). The composer takes `/` commands, `$` skills, `#` PR browsing and **inline context chips** at the cursor, and a message sent mid-turn becomes a **dashed "queued" bubble** with queue-versus-steer behaviour ([composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md)). Permission modes are **chosen in the composer**, per thread: Supervised / Auto-accept edits / Auto / Full access ([permission-modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)). Appearance exposes a **panel-animation slider, 0–400 ms, defaulting to 0 (instant)**, honouring reduced-motion, and thread switches "snap to the panel state" instead of replaying transitions ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)).

**WorkBuddy** (Tencent) documents a **three-zone shell**: a sidebar holding the task list grouped by workspace with search and the user avatar at the bottom, a centre conversation with a title bar / message list / input, and a right **Results Panel** toggled from the title bar ([Quickstart](https://www.workbuddy.ai/docs/workbuddy/Quickstart)). The richer Chinese docs describe that right panel as four sibling tabs — **产物 Artifacts / 工作空间文件 Workspace Files / 变更 Changes / 浏览器 Browser** ([Right-Sidebar](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar)) — and the same page documents the single most transferable idea in either product: a **消息中心 Message Center**, opened from a bell at the sidebar bottom, that lists *"task needs your confirmation"* and *"task completed"* rows, each jumping to its task. Settings are a **left-nav plus right-content** layout (General / Features / Data & Security), applying instantly ([Setting](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)). Coding mode adds a **Worktree** feature that runs two tasks on separate branches and **labels the branch in the task list** ([WB-09](https://github.com/KimYx0207/AI-Coding-Guide-Zh/blob/main/docs/workbuddy/WB-09-WorkBuddy-Coding-Mode%E7%BC%96%E7%A8%8B%E6%A8%A1%E5%BC%8F%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97.md) `[S]`).

Two caveats that shape the plan. T3 Code is `0.0.x` ([releases](https://github.com/pingdotgg/t3code/releases)) and its README states it is "very very early… expect bugs" ([README](https://github.com/pingdotgg/t3code)) — the *patterns* are mature, the product is not. And WorkBuddy is an office-work agent with a coding mode, so its scenario tabs and credit framing do not transfer ([Coding Mode](https://www.tencentcloud.com/techpedia/144314)).

### 9.2 Shell: adopt the three-region model, and move the terminal to a drawer

Today the app is a grid of sidebar / main / inspector, and the inspector holds **Changes, Browser and Terminal as sibling tabs** (`Inspector.tsx:20-62`). Both benchmarks argue for a different split: T3 separates a **terminal drawer** from the tabbed right panel; WorkBuddy keeps the right panel for *results* (artifacts, files, changes, browser). The refinement:

- **Right panel tabs → Changes · Browser · Files.** Terminal leaves the tab set. A terminal is a persistent tool, not a result; burying it in a tab means it competes with the diff for the same 460px. Files (a workspace tree) is the WorkBuddy tab the current UI lacks entirely, and it is the natural companion to file links in the transcript.
- **Terminal becomes a bottom drawer** spanning the main column, toggled with the existing ⌃` shortcut (`App.tsx:55-57`), height-draggable with the Ch. 8 splitter contract, and remembering its height. `TerminalPanel` already stays mounted per project (`store.ts:279`) so this is a layout move, not a rewrite.
- **All three regions collapse.** T3's regions are collapsible; today the sidebar cannot collapse at all (`Sidebar.tsx:14` only collapses project *groups*). Ch. 8 §8.2 specifies the rail; this chapter makes it a shell requirement: sidebar rail at 48px, right panel closable, drawer closable — all three keyboard-reachable and persisted.

### 9.3 Navigation and thread lifecycle

The sidebar today is a flat, recency-sorted list of threads under each project (`store.ts:83-86`). T3 replaces "a list with a status" with **sections** — Pinned, Active, Snoozed, Settled — and WorkBuddy labels each task with its branch. Both are cheap and high-value:

- **Sections.** Pinned / Active / Settled, with Snoozed as a later addition. `Thread` already has `updatedAt`; auto-settle (T3 uses ~3 days idle or a merged PR) is a query, not a migration. This solves a real problem the flat list has: yesterday's finished work and today's live work look identical.
- **Branch and agent labels on the row.** WorkBuddy labels the worktree branch; T3 gives each thread its own worktree. The current row shows only a title and a spinner (`Sidebar.tsx:44-57`). Add a quiet second line or trailing chip: agent label, and branch when the thread is on one. This also makes the parallel-work story legible before any worktree support exists.
- **Keyboard parity.** Adopt the parts that fit: ⌘1–9 to jump to the first nine threads, and ⌘[ / ⌘] as back/forward across recently viewed views ([keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md)). The palette already exists; T3's refinement is that a query starting with `>` shows **actions only** — a two-line change in `palette.ts` that makes the palette a real command surface rather than a search box.
- **Thread search.** WorkBuddy's sidebar has search; ours does not. The palette covers it, so this is optional — but it should search thread titles across *all* projects rather than the selected one; `palette.ts` already has a Threads section (`palette.ts:4,27`), so the gap is scope, not capability.

### 9.4 The Message Center: the one pattern worth copying wholesale

WorkBuddy's inbox is the answer to a question this harness will face as soon as it can run more than one thing at a time: *what happened while I was away?* The current UI answers it with nothing — a running thread shows a spinner in the sidebar (`Sidebar.tsx:55`) and a permission request only appears inside the thread that raised it (`ThreadView.tsx:51-53`), so a request on a background thread is invisible until you open it.

The refinement is a **bell in the sidebar footer** opening a full-page overlay with two groups:

1. **Needs you** — pending permission requests (from `store.permissions`, which is already a cross-thread array), handoff confirmations (Ch. 7 §7.3), and agent switches that would lose context.
2. **Finished** — turns that completed while the thread was not selected, with the thread title, agent, duration and outcome.

Each row jumps to the thread. This is also where Ch. 7's "states and microcopy" inventory gets its home: anything that needs an action gets an inbox row, and transient confirmations stay as the 3.5-second `Notice` (`store.ts:120-124`). One new store slice and one new component; no schema change.

### 9.5 Composer: chips, queueing, and modes where the message is

The composer already does `/` skills with a keyboard-driven menu and supports inserting a picked browser element (`Composer.tsx:21-35`, `:57-62`). Three additions, all from T3:

- **Context chips at the cursor.** A picked element today is appended to the end of the textarea (`Composer.tsx:59`). T3 inserts chips at the caret and renders them as discrete tokens. Adopt the chip *rendering* (reuse the existing `.skill-chip`), keep insertion simple — this makes a message with three attached things readable instead of a wall of pasted text.
- **A queued-message bubble.** Sending while a turn runs is currently blocked outright (`Composer.tsx:79`). T3 accepts the message, renders it as a **dashed bubble**, and offers queue-versus-steer. For a harness whose whole point is long agent turns, "you can type ahead" is a significant quality-of-life change. It needs one new event kind and an explicit rule for when a queued message is delivered (start of next turn).
- **Modes in the composer, not only in the header.** The permission segmented control sits in the header (`App.tsx:113-127`) and is disabled while running. T3 puts the mode choice next to the send button, per thread. Moving (or duplicating) it there puts the decision where the user is looking, and makes the Ch. 7 per-driver mode semantics visible at the moment of sending.

### 9.6 Settings: from one long sheet to a left-nav IA

Settings today is a single scrolling sheet with six sections (`SettingsSheet.tsx:52-182`). WorkBuddy uses **left-nav + right-content** with instant apply ([Setting](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)), which is the right shape once Ch. 1 adds a provider registry — a list of providers plus an editor does not belong in a scrolling sheet. Proposed groups: **Appearance · Threads · Agents & Providers · Skills & MCP · Data & Security · Updates**, with the existing `.sheet` chrome and `Esc`/backdrop-dismiss behaviour kept (`SettingsSheet.tsx:35-53`).

### 9.7 Visual language: keep it, add the two knobs T3 got right

Do not repaint. The current tokens are coherent and the benchmarks publish no visual spec worth copying — WorkBuddy's radii, spacing and colour values are undocumented `[U]`, and T3 documents tokens and a motion slider but not density or typography ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)). Two adoptions are worth it:

- **Motion as a setting, defaulting to instant.** T3's 0–400 ms panel-animation slider with a default of 0 is a genuinely better default than the current unconditional `slide-in 220ms` (`app.css:524`). Add a motion preference (Instant / Subtle / Full), keep `prefers-reduced-motion` authoritative, and make thread switches snap panel state rather than replay it.
- **A density preference** (Comfortable / Compact) affecting the `.thread-row`, `.tool-row` and `.turn-meta` line heights. Long agent transcripts are the dominant content; density is the knob users actually reach for.

Optional and explicitly not core: T3 imports VS Code themes. It is a nice differentiator and a large surface area; the plan should note it and defer it.

### 9.8 Adopt / adapt / avoid

| Pattern | Verdict | Why |
|---|---|---|
| Three collapsible regions; terminal as a drawer | **Adopt** | Separates a persistent tool from tabbed results; both benchmarks agree |
| Tabbed right panel (Changes / Browser / Files) | **Adopt** | WorkBuddy's tab set maps onto the existing inspector |
| Thread lifecycle sections (Pinned / Active / Settled) | **Adopt** | Replaces an indistinguishable flat list; no migration |
| Message Center inbox | **Adopt** | Nothing else answers "what happened while I was away" |
| Composer chips, queued bubble, mode in composer | **Adopt** | All three make long turns tolerable |
| Settings left-nav IA | **Adopt** | Required once providers exist |
| Motion slider (default instant) + density | **Adopt** | Better defaults than the current hard-coded animation |
| `>` action mode in the palette, ⌘1–9, ⌘[ / ⌘] | **Adopt** | Small, cheap, keyboard-first |
| Worktree-per-thread, background start, fan-out by shift-clicking models | **Adapt later** | Right idea; depends on the Ch. 3 `bindings` work and git plumbing |
| Branch label on a thread row | **Adapt now** | Useful immediately, worktree support or not |
| WorkBuddy scenario tabs (office / code / design), credits, expert teams | **Avoid** | Office-work mental model; wrong for a code-first harness |
| T3's default of **Full access** permissions | **Avoid** | Our default is Ask for good reason; keep it |
| T3's release posture (`0.0.x`, "expect bugs", "(mostly) not accepting contributions yet") | **Avoid** | Patterns, not process |
| VS Code theme import | **Defer** | Large surface, low core value |

### 9.9 Phased refinement

- **Pass 1 — no new data, one or two files each.** Section the thread list; add the branch/agent label; palette `>` mode and ⌘1–9; motion preference defaulting to instant; terminal drawer; sidebar rail. All of these touch `Sidebar.tsx`, `App.tsx`, `Inspector.tsx`, `store.ts`, `app.css`.
- **Pass 2 — new state, no schema change.** Message Center (bell + overlay + `store.inbox`); Files tab in the right panel; composer chips and the queued-message bubble; Settings left-nav regrouping.
- **Pass 3 — depends on earlier chapters.** Worktree-per-thread and background start (after Ch. 3's `bindings`), density preference, and the four-agent rendering-parity snapshot test from Ch. 8 §8.5.

### 本章新增来源清单

1. [T3 Code — `docs/user/appearance.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md) `[P]` — sidebar / right panel / terminal drawer as three collapsible regions; theme tokens; 0–400 ms motion slider defaulting to instant; snap-to-panel-state on thread switch.
2. [T3 Code — `docs/user/thread-sidebar.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) `[P]` — thread as primary object; Pinned/Active/Snoozed/Settled sections; worktrees; background start; Agents view.
3. [T3 Code — `docs/user/composer.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md) `[P]` — `/`, `$`, `#` triggers; inline context chips; dashed queued bubble; queue vs steer.
4. [T3 Code — `docs/user/permission-modes.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md) `[P]` — four modes chosen in the composer, per thread.
5. [T3 Code — `docs/user/keybindings.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md) `[P]` — ⌘K palette, `>` action filter, ⌘1–9, ⌘[ / ⌘].
6. [T3 Code — `docs/user/source-control.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md) · [`devices.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md) `[P]` — tabbed right panel contents.
7. [T3 Code — README](https://github.com/pingdotgg/t3code) `[P]` — alpha status and contribution policy, i.e. what not to copy.
8. [WorkBuddy — Quickstart](https://www.workbuddy.ai/docs/workbuddy/Quickstart) `[P]` — three-zone shell; Results Panel toggled from the title bar.
9. [WorkBuddy — Right-Sidebar (右侧边栏)](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar) `[P]` — Artifacts / Workspace Files / Changes / Browser tabs; Message Center.
10. [WorkBuddy — Setting (系统设置)](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting) `[P]` — left-nav Settings IA, instant apply.
11. [WorkBuddy — Model](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) `[P]` — provider list with presets, dialog-based custom models, capability flags, Ollama, custom protocol.
12. [WorkBuddy Coding Mode (Tencent Cloud)](https://www.tencentcloud.com/techpedia/144314) `[P]` — coding mode surfaces diffs; four results-panel tabs.
13. [WB-09 Coding Mode guide](https://github.com/KimYx0207/AI-Coding-Guide-Zh/blob/main/docs/workbuddy/WB-09-WorkBuddy-Coding-Mode%E7%BC%96%E7%A8%8B%E6%A8%A1%E5%BC%8F%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97.md) `[S]` — Worktree with branch labels in the task list.
14. Local repository (verified in-place, 2026-09): `styles/app.css:1-60,524`, `App.tsx:55-57,113-127`, `components/Sidebar.tsx:14,44-57`, `components/Inspector.tsx:20-62`, `components/Composer.tsx:21-35,57-62,79`, `components/SettingsSheet.tsx:35-53,52-182`, `components/ThreadView.tsx:51-53`, `store.ts:83-86,120-124,279`, `palette.ts`.
