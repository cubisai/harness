# Handoff: design live variants + style variety (2026-10-26, Mac, session 1: plan approved, P0 next)

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
| P0 | Live repro of the tool defects in the Quick / Working / Real app tiers, dark theme, screenshots | **next** |
| P1 | Global bar (Pick `V`, Insert, Detect, DESIGN.md, Steer, Compare, Present); header Select out; Text, Comment and Pen out of the rail; Inspector no longer turns picking on | todo |
| P2a | Element bar + 4×3 action palette + in-frame marks and notes (page coordinates) + Go message | todo |
| P2b | `data-cubiq-variant="S-n"` sets in place, bridge detection, cycler, Accept/× in the main process, malformed-set recovery | todo |
| P2c | Insert (`+`): variants at a gap | todo |
| P3 | Style variety (its own plan) + optional `mode` on `design_set_direction` | todo, parallel from P1 |
| P4 | ~35 new slop checks, style exemptions, noise gate, skill floor lines, Detect (eye) overlay | todo |

## Where the work goes
- No code yet. Branch **`track/design-live`** off `m4` (`db014be`), in its own worktree `../aiharness-wt/design-live` (not created yet).
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
