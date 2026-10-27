# Handoff: design live variants + style variety (2026-10-27, Mac, session 2: P1 + P2a done, P2b next)

## Session 2 status (read this first)
- **P1 done** (`922f5b5`): `LiveBar.tsx`, one bottom bar in both layouts (Pick `V`, DESIGN.md = the Inspector's System tab, Steer = an inline page-level message, Compare, Present). The header Select, the rail tools and the Inspector's auto-pick are gone; the stage, Compare and the board keep `--live-bar-room` clear.
- **P2a done** (`9e30964`): `ElementBar.tsx` (tag, prompt, 4×3 actions ×3, dictation hint, Go, Edit text, Comment in Real app, Clear N, repick confirm, "Generating variants…" pill). Bridge: `anchor` / `marks` / `repick-ask` up, `clear-marks` / `repick` / `edit-selected` down. Marks are SVG + note inputs in a page-coordinate layer (`[data-cubiq-marks]`), so they stay on their content through scroll (checked live). `DrawOverlay` deleted.
- Choices made in P2a (differ slightly from the plan, revisit if wanted): multi-select acts on the selection itself (the scope block lists them), not on their common parent; Go captures the element + marks only when strokes exist (notes go as text); the last action is remembered per thread in memory only (lost on reload).
- **Go doesn't send the skill or the action paragraph yet**: P2b adds `design-variants` + `resources/design-actions/<action>.md`. `goMessage()` in `ElementBar.tsx` is the hook.
- **Next: P2b**, then P2c; P3 can run in parallel in its own worktree.
- Live setup this session (session 1's profile is gone): port **9477** (another session used 9466 on 2026-10-27), fresh `--user-data-dir` in the scratchpad; design thread made with `openChats()` + `createThread(chatsId, "opencode", {kind:"design"})`, then a bench page copied into `ud/chats/<threadId>/designs/<id8>/` (`8b15e090` Harbor dashboard as `index.html`, `daf71ebc` as `variant-a.html`). Tier changes through the API need a window reload to reach the store.
- A fresh profile's OpenCode default model fails at once (AgentRouter "probation" channel). Two More styles turns were started from the app window at 10:35 (not by the scripts); both failed at once, cost nothing, and wrote nothing. **Set the thread to Zen free DeepSeek before any P2b live run.**

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
5. Impeccable is a reference, not a dependency: no binary, hooks or PRODUCT.md. Our own English, token-sized text. Credit in `NOTICE`.
6. **Accept and × are done in the main process with no agent turn** (`designVariantResolve`). A version snapshot first, so Restore undoes them.
7. Only the chosen action's paragraph (`resources/design-actions/<action>.md`) goes to the agent, plus the `design-variants` skill (≈350 tokens).
8. Per-style `allows:` in a style's `DESIGN.md ## Rules` keeps the new lint from fighting our own styles.

## Phases

| Phase | What | State |
|---|---|---|
| P0 | Live repro of the tool defects, dark theme, screenshots | **done** (session 1) |
| P1 | Global bar (Pick `V`, Insert, Detect, DESIGN.md, Steer, Compare, Present); header Select out; Text, Comment and Pen out of the rail; Inspector no longer turns picking on | **done** (`922f5b5`) |
| P2a | Element bar + 4×3 action palette + in-frame marks and notes (page coordinates) + Go message | **done** (`9e30964`) |
| P2b | `data-cubiq-variant="S-n"` sets in place, bridge detection, cycler, Accept/× in the main process, malformed-set recovery | **next** |
| P2c | Insert (`+`): variants at a gap | todo |
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
