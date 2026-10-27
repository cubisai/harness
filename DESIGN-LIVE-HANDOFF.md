# Handoff: design live variants + style variety (2026-10-27, Mac, end of session 2: P1, P2a, P2b done; P2c next)

## Session 2 status (read this first)
- **Work happens in the worktree** `../aiharness-wt/design-live`, branch `track/design-live` (not merged into `m4` yet). The plan is approved: continue without asking (memory `autonomy-no-prompts`).
- **P1 done** (`922f5b5`): `LiveBar.tsx` is the one bottom bar in both layouts: Pick `V`, DESIGN.md (opens the Inspector's System tab), Steer (an inline page-level message), Compare, Present. The header Select, the rail tools and the Inspector's auto-pick are gone. The stage, Compare and the board keep `--live-bar-room` clear.
- **P2a done** (`9e30964`): `ElementBar.tsx` holds the tag, prompt, 4×3 actions ×3, a dictation hint, Go, Edit text, Comment (Real app tier), Clear N, a repick confirm and the "Generating variants…" pill.
  - Bridge messages up: `anchor`, `marks`, `repick-ask`. Down: `clear-marks`, `repick`, `edit-selected`.
  - Marks are SVG plus note inputs in a page-coordinate layer (`[data-cubiq-marks]`), so they stay on their content through scroll (checked live).
  - `DrawOverlay` is deleted.
- **P2b done** (`a34d4ae`):
  - `src/main/design/variants.ts`: `listVariantSets` and `resolveVariantSet`, pure text work with no parser.
    - Accept keeps one wrapper's element, adds a `cq-<set>` class, and rewrites `@scope ([data-cubiq-variant="S-n"])` to `@scope (.cq-<set>)`, with `:scope > C` becoming `:scope:is(C)` and `:scope C` becoming `:is(:scope:is(C), :scope C)`. Shared keyframes stay.
    - × keeps the original and drops every rule.
  - `service.resolveDesignVariants` takes a version before and after the write (`recordDesignPage`), so Restore undoes it. IPC is `design:variant-resolve`; the action paragraph comes from `design:action-note`.
  - Bridge: `findVariants` runs on ready and injects `[data-cubiq-variant]:not([hidden]){display:contents}`. It posts `variants` and `variant-rect`; `show-variant` switches the shown one.
  - Canvas: `VariantCycler` (`‹ n / 3 ›`, ×, Accept, ←/→). When sets arrive the selection is cleared, without a notice.
  - Skill `resources/skills/design-variants/SKILL.md` (339 words) plus 11 notes in `resources/design-actions/` (Freeform has none), packaged via `electron-builder.yml`.
  - Lint `collectSlop` skips `[data-cubiq-variant][hidden]`.
  - Canvas-first `.main` is now z 25 (it was 3), so the drawer and prompt bar sit over the canvas bars and under Present (z 30). The prompt pane's left pad no longer reserves room for the old rail.
- **Live results (DeepSeek v4.1 flash free, Zen):**
  - Go on the Harbor h1 with Bolder: one Edit in 41 s, no screenshot loop.
  - It returned 3 real, different variants on 3 axes: 48px tighter, a cyan filled block, 64px full row.
  - The cycler and keys work. Accept and × made no agent turn (the event count was unchanged).
  - Accept → Restore v1 brought the set and the cycler back. × gave a file byte-identical to the original.
  - Claude and Codex were not run (ask first).
- **Choices made** (they differ a little from the plan; revisit if wanted):
  - Multi-select: Go scopes the selection itself, and the skill says "wrap their nearest shared parent".
  - Go captures the element plus marks only when strokes exist (notes go as text).
  - The last action is remembered per thread in memory only.
  - Resolve doesn't run the fence or lint: the agent's write already passed the fence, and autolint runs at turn end.
  - The action paragraph shows in the user's chat bubble (sent as text, not hidden).
- **User decision 2026-10-27: no `NOTICE` file.** Copy Impeccable's ideas and write our own text; never paste its code or text.
- **Next: P2c (Insert `+`)**, then P4; P3 can run in parallel in `../aiharness-wt/design-variety`. Later: merge `track/design-live` into `m4`, and run the Windows CI job.
- Known nits, not fixed:
  - After a reload the bridge's hover target is stale until the mouse moves.
  - The hover box doesn't follow page scroll (unchanged code).
  - A click inside the picked element drops a note instead of picking a child (by design). Use the crumbs or Layers to pick a child.
- **Live setup** (session 1's profile is gone):
  - Port **9477** (another session used 9466). Launch from the worktree with `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud`.
  - Main-process or bridge changes need an app restart (`kill -TERM` the 9477 pid): no hot reload there.
  - Make a design thread with `openChats()` + `createThread(chatsId, "opencode", {kind:"design"})`, then copy a bench page into `ud/chats/<threadId>/designs/<id8>/` (`8b15e090` Harbor as `index.html`, `daf71ebc` as `variant-a.html`).
  - Tier changes through the API need a window reload.
  - In-frame checks: a small CDP script that evaluates on the `type: iframe` target from `curl :9477/json`.
  - **Set the thread to `opencode/deepseek-v4.1-flash-free` before any live run.** A fresh profile's OpenCode default fails at once (AgentRouter "probation").
  - On 2026-10-27 at 10:35, two More styles turns were started from the app window (not by the scripts). Both failed at once, cost nothing, and wrote nothing.

## Session 1 status
- **The plan is approved, and the user said to start it.** Continue P1 without asking (memory `autonomy-no-prompts`).
- **P0 done: every defect seen live.** Details are in the hub `.ai/plans/design-style.md` §1.1; shots in `.ai/plans/design-style-refs/p0/`. P0 ran on the dev app at port 9466, Working tier, dark theme, on Claude's #4 dashboard:
  - the header Select and rail Select light up together;
  - Text + a single click only selects, no edit;
  - Comment is disabled in the Working tier;
  - Pen: the wheel doesn't scroll while drawing, and a stroke stays at its screen spot when the page scrolls (it drifts off its content);
  - Inspector turns picking on and leaves it on after it closes.
- **Worktree created:** `../aiharness-wt/design-live`, branch `track/design-live` at `b9a3ee3` (= m4 + this handoff). `node_modules` is symlinked to the main checkout. No code changes yet.
- **Next: P1** (the global bar). Then P2a/b/c; P3 (variety) can start in parallel in `../aiharness-wt/design-variety` (not created yet).
- **Test setup to reuse for live checks:**
  - profile: copy the P6 bench DB with `sqlite3 <old>/scratchpad/profile/unskilled.db ".backup <new>/ud/unskilled.db"`. The old profile is in session `96f832e5`'s scratchpad. Its design threads point at `.ai/reports/design-enhance-20261026/baseline/project`;
  - launch from the worktree: `npx electron-vite dev --remoteDebuggingPort 9466 -- --user-data-dir=<ud>`;
  - theme: `window.unskilled.updateSettings({theme:"dark"})`;
  - open a thread via `ab snapshot -i` → `ab click @eN` in the same call;
  - in-frame state: a small CDP script that evaluates on the `type: iframe` target from `curl :9466/json` (the agent-browser tab for the iframe disappears when the frame reloads);
  - real clicks and drags: `ab mouse move/down/up` on the app tab.
- The user's own dev app (main checkout, no CDP port) was running all session. Don't kill it.

Goal (user): design mode should work like **Impeccable's live mode video**:
1. pick an element;
2. an action palette (Bolder, Quieter, Distill, Polish, …), ×3;
3. drag = mark, click = note;
4. "Generating variants…";
5. three in-place variants `‹ 1/3 ›`, Accept or ×.

Also in scope:
- fix the duplicate and broken canvas tools (the header Select vs the rail Select, Text, Comment, Pen);
- add Impeccable's rules (detector checks, craft floor, the 4 modes);
- ship the style-variety plan.

Design threads only.

## Read first (main checkout, `.ai/` is gitignored: Mac only)
- **Hub: `.ai/plans/design-style.md`**: findings (code-verified, with file:line), decisions, and the file map. Start here.
- Plan: `.ai/plans/design-live-variants.md` (phases P0–P4, tests, success bar). **Approved by the user 2026-10-26.**
- Folded in as P3: `.ai/plans/design-style-variety.md` (the shortlist + seeded pick, the deck/web filter, the taste fixes).
- Refs: `.ai/plans/design-style-refs/`:
  - `impeccable/`: copies from github.com/pbakaus/impeccable @ `63d672f`, Apache-2.0, with `LICENSE` and `SOURCE.md`. Most useful: `reference/live.md` §4 (variant planning), `reference/craft-floor.md`, `slop-rules.md` (67 rules with our status);
  - `video/`: contact sheets from both recordings;
  - `screens/`: the user's duplicate-tools screenshot.
- Originals (repo root, untracked, the user's): `Screen Recording 2026-10-26 at 5.00.32 / 5.01.18 in the afternoon.mov`, `Screenshot 2026-10-26 at 4.25.16 / 5.01.48 in the afternoon.png`.

## Decisions (user-approved defaults)
1. A global bottom bar replaces the vertical tool rail and the header Select. The Text and Pen tools go: double-click edits, an Edit text button sits on the element bar, and marks live inside Pick.
2. Always ×3.
3. Mic = it focuses the field so OS dictation can fill it (macOS Fn Fn, Windows Win+H).
4. Our tokens, Impeccable's layout.
5. Impeccable is a reference, not a dependency: no binary, hooks or PRODUCT.md. Copy the ideas, reinvent the text: our own English, token-sized, never pasted from Impeccable. **No `NOTICE` file** (user, 2026-10-27).
6. **Accept and × are done in the main process with no agent turn** (`designVariantResolve`). A version snapshot first, so Restore undoes them.
7. Only the chosen action's paragraph (`resources/design-actions/<action>.md`) goes to the agent, plus the `design-variants` skill (≈350 tokens).
8. Per-style `allows:` in a style's `DESIGN.md ## Rules` keeps the new lint from fighting our own styles.

## Phases

| Phase | What | State |
|---|---|---|
| P0 | Live repro of the tool defects, dark theme, screenshots | **done** (session 1) |
| P1 | Global bar (Pick `V`, Insert, Detect, DESIGN.md, Steer, Compare, Present); header Select out; Text, Comment and Pen out of the rail; Inspector no longer turns picking on | **done** (`922f5b5`) |
| P2a | Element bar + 4×3 action palette + in-frame marks and notes (page coordinates) + Go message | **done** (`9e30964`) |
| P2b | `data-cubiq-variant="S-n"` sets in place, bridge detection, cycler, Accept/× in the main process, malformed-set recovery | **done** (`a34d4ae`) |
| P2c | Insert (`+`): variants at a gap | **next** |
| P3 | Style variety (its own plan) + optional `mode` on `design_set_direction` | todo, parallel from P1 |
| P4 | ~35 new slop checks, style exemptions, noise gate, skill floor lines, Detect (eye) overlay | todo |

## Where the work goes
- No code yet. Branch **`track/design-live`** off `m4` (`b9a3ee3`), in its own worktree `../aiharness-wt/design-live` (created).
- P3 goes in a second worktree, `../aiharness-wt/design-variety`.
- One git worktree per parallel brief (memory `parallel-worktrees`).
- Main checkout: leave other-session files alone (`resources/DESIGN-MODE.md` one-line diff, the `road-map-handoff.md` deletion, `docs/testing/`, the recordings and screenshots).
- A dev app is already running from the main checkout (`electron-vite dev`, another session or the user). Don't kill it: run our own copy on port 9466 with its own `--user-data-dir`.

## Verify (Claude, every phase)
- `bun run typecheck`, the full suite, `bun run design:check`. Claude reads the diff itself; a worker's "done" doesn't count.
- The real app in the dark theme: screenshots next to the video frames; no iframe remount, stray scrollbars or layout shake.
- Live runs: DeepSeek free (OpenCode Zen) first. **Ask before any Claude or Codex run.**
- Windows: no shell in resolve; paths through `path.join`; a Windows CI job.
- Commit each phase on its own (only that phase's files, ≤150-character message, no trailer). Then clear `.ai/tmp/`.

## Gotchas
- `/oc` on the Mac: no `oc-run.mjs`.
  - Dispatch with `opencode run --agent orchestrator -m opencode/deepseek-v4.1-flash-free`, and tell it to use its `task` tool immediately.
  - Briefs ≤5 files; no shell commands for implementers.
  - Stagger parallel starts by ~20 s.
  - Memory `oc-dispatch-mac`.
- The Design iframe is cross-origin (`cubiq-design://`): evaluate inside it through its own CDP target. With agent-browser attached, the iframe can stay `about:blank` (memory `test-app-for-real`).
- The guide `resources/DESIGN-MODE.md` is at 1296/1300 tokens: swap words, don't add.
