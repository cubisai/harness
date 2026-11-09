# Handoff: CubiQ Design Mode 2.0

Short on purpose: current state, next steps, open questions and live traps. Replace text rather than adding to it, and move finished detail to the archive.

**On another machine, read `HANDOFF_2.md` first**: how to pull both branches, recreate the worktree and restore the git-ignored `.ai/` folders.

- Archive (M3 kit method, M4 and M5 checks, all old traps): `.ai/plans/handoff-archive-2026-11-06.md` (git-ignored, Mac only). Older: `git show 850f3cf:HANDOFF.md`.
- Plan: `.ai/plans/design-mode-v2.md` (M0-M8). Spec: `design_plan.md` and `design_mode_mock.html`. Search them, don't read them whole.
- **Reference:** the screen recording `Screen Recording 2026-11-05 at 5.30.18 in the afternoon.mov` in the main checkout. To see it: `ffmpeg -i <mov> -vf fps=1/3 f%02d.png`, then tile them 2x2.

## Start here

1. Worktree `../aiharness-wt/design-v2`, branch `track/design-v2`. To recreate it: `git worktree add`, then `bun install` and `node node_modules/electron/install.js`.
2. Before every commit: `bun run typecheck`, `bun run test`, `bun run design:check`. Commit only that change's files, 150 characters or fewer, no trailer.
3. Update this file at each milestone (the user's request). Keep it under about 100 lines.

## User decisions

- Full v2 replaces today's design mode. `designV2` is a build switch until M7. Milestones M0-M7 are approved: work straight through. Stop after 2 failed fixes on one piece, or to ask before merging into `m4`.
- **Follow the recording** for whatever the plan still lacks (2026-11-06). That includes the pill: **no floating pill.** The selection is a Composer chip (`Selection: Grid ×`), with a name tag and 8 handles on the canvas.
- 6 kits in `design-kits/`, all approved. Foundation is bundled. Kit UI is written by Claude, not workers, from real library values, with no copied source and no NOTICE (fonts carry `OFL.md`). Only the user pushes `cubisai/design-kits`.
- No Varelyo branding beyond that one kit's name. Delete tests that pin the old UI in M7 together with that UI.
- Later, not approved: Guardian, external MCP, multi-tab, parallel agents, Sketch, Connect, multi-brand, user repos, signed catalog, Change History.

## Status

| # | State |
|---|---|
| M0-M4 | Closed, Windows green |
| M5 | Pill and Typography pushed, Windows green (run 42166030432). Closes when the agent-turn items have run live |
| M6 | **Closed 2026-11-09.** Slices 1-5 done; fixes through `17d3ee7`. Journey D moves to M8 |
| M7 | **Gate passed 2026-11-09.** Code in `8cf24c7` and `6429027`, CI green, both live turns pass. Waiting on the user's merge answer |
| M8 | Planned 2026-11-06: agent side kit-first (skills, guide, tools, styles). See the plan |

## Next, in this order

1. CI: `gh run list --workflow ci.yml --branch track/design-v2`. Rerun a lone ACP "can't start" timeout once. `6429027` green (run 42569038106).
2. **M7, gate passed; merge is the user's call.** `8cf24c7` removed the `designV2` switch (main, settings, types, Settings sheet, App, ThreadView), `LiveBar`, `ElementBar`, `InspectorPanel`, the crumbs, the dead Insert mode, the old 32-style `DesignStyleMenu` and 56 dead CSS rules. What v2 still uses moved to `design/variants.tsx`: cycler, Explore `goMessage`, `insertMessage`, `placeFloatingBar`, `escClears`. Tests: 3 files deleted, the rest repointed (`design-variants.test.tsx` is new). `DESIGN.md` §7.8 describes the studio. An undeclared page now opens on Desktop.
    - `6429027` (the user asked for it before merge): removed the old pick path, the marks/notes layer and Insert mode from the page script (`bridge.ts`). Gone with them: the `marks`, `repick-ask`, `gap`, `gap-rect`, `insert-cancel` and `text-edit` messages, the `design:edit-text` and `design:edit-style` IPCs (with the service methods, `applyTextEdit` and `applyStyleEdit`), `TweaksPanel` and 2 dead CSS rules. `go()` now sends only the direction and words. Pick is always v2 (`startSelectV2`). The gap geometry stays, because the seam `+` uses it.
    - Passed on `6429027`: typecheck, 4456 tests, design:check. On S3-I: m6-actions (11), m6-customize (7), m5-rest (11), m6-smooth (31). Flat walk (`M5_FLAT=1 m5-select`) on "Z ping" and on the project thread. The sweep and all 14 threads were checked on `8cf24c7`.
    - Also checked: a draft (New design shows the v2 picker), a project-folder thread ("P-design folder" in project "proj"), and a code thread ("P-code thread"). Chat mode is fine.
    - m5-select's kit walk fails on S3-I because of the fixture: it needs a hero with `h1 span` and a table. It isn't a regression.
    - **Fixed `.ai/kit-tools/m4-drive.mjs`:** it now attaches to the visible `.design-frame`. Before, it took the first `cubiq-design://` iframe, which can be the chat turn card's hidden `?v=2` thumbnail, and that gave false failures.
    - **Live turns pass (2026-11-09, PGS Grove `PGA/deepseek-v4.1-flash-1017`, because Zen free was at its limit):** select, chip, `/`, "3 variants: Bolder", turn, then the cycler going 1/3 → 2/3, and Discard.
        - Kit: J-F match ("Copy link", 32 s). Flat: new thread "F-flat turn" (`a26b971e`, design system `auto`, "Start free", 29 s).
        - Discard restores the selected part only. The agent's other edit stayed: J-F's share listener became `querySelectorAll('[data-agent-id^="btn-share"]')`. That's harmless, but Discard doesn't undo it.
        - Script: `<session 70827509…>/scratchpad/turn.mjs` (env `THREAD SEL DIR MODEL SHOTS`), run through `m4-drive.mjs`. After a restart, the sidebar needs Design mode plus `[aria-controls=sidebar]` before `prep.mjs` can find threads.
    - Notes: `design:history` logs "No such page" on threads with no page. A project page's `../../tokens.css` didn't apply (page serving is outside M7, so look at it separately).
    - Scratch, Mac only. Profile: `ccb15691…/scratchpad/ud`, with the "proj" project added straight into `unskilled.db` at `c0fd174b…/scratchpad/proj`. The S3-I page is backed up at `c0fd174b…/scratchpad/s3i-backup.html`. `c0fd174b…/scratchpad/prep.mjs <title>` opens a thread in Design with Customize open.
    - **Asked 2026-11-09:** merge `track/design-v2` into `m4`? Don't merge without a yes.
3. **M8** after M7 (user, 2026-11-06; plan `## M8`): one lean guide, 4 skills (`design-build`, `design-variants`, `design-kit`, `design-review`), grounded tools, 32 flat styles retired, before-and-after bench. Add from M6: a tool that renders one draft part, guidance on page token overrides (`@layer page` loses to `tokens.css`), the no-literal rule, and journey D (new kit grounding).
4. **The user runs `publish`:** `release-kits.sh pack` again first (`ui.js` changed), then fill `KIT_CATALOG` with release URLs and SHA-256 hashes.

## M6 close (2026-11-09)

- Journeys: G4 pass (DeepSeek); F and I pass on Codex and Sonnet high; DeepSeek fails F (no vision) and I (builds a page); D fails everywhere tried (M8). Detail in the archive.
- Fixes: `8f18d76` System samples render the `kit/` draft; `5e7f2f2` `z.record` schemas emptied Claude's whole cubiq tool list (no `run_code`/`design_*` since `f2d4873`): never use `z.record` in a harness tool, `test/claude-tool-list.test.ts` guards it; `911029b` design tools always load for Claude; `17d3ee7` 900px: Composer height follows chips, System states stack in narrow frames, stacked panel ends above the Composer, header title keeps room.
- Scratch (session `ccb15691…/scratchpad`, Mac): profile `ud` with J-*, S-*, S2-*, S3-*, C-* threads; `zip/scratch/journey.mjs` (fixed: `TITLE`/`EFFORT` env, closes both CDP connections), `sweep.mjs`.

## Done in M6

Slices 1 and 2 and the in-place patch are described in the archive. **Not run live yet:**
- The patch during a real agent turn.
- A theme switch through the picker.
- `Save as composition…` and block insert.
- `Preparing style…`.
- Draft, flat-style and project-folder threads.

**Not yet told to the user:**
- System mode: the Typography specimen uses system fonts (kit fonts aren't loaded in the app). Palette ramps are worked out, not kit tokens.
- Page tokens are written inline on `<html>`.
- Kit hand-edit undo ends on restart.
- A kit move covers every page, and `⌘Z` restores all of them.
- AI adaptation after a move is a chat request.
- `Save as composition…` refuses over 4 KB.
- System mode chat is the same thread, not the recording's separate "New design system chat".
- The turn card counts parts on the page, not what the agent touched; "new" means not on the page before that turn.
- `Move to…` is click-a-target then Before/After/Inside, not drag. `Go to component` opens System mode's part page, not a `.tsx`.
- Unbuilt M5 items: the breakpoint bar, `⌥`-drag clone, `Tab` into the canvas, and `⌘F`.

**Open with the user:** their 2026-11-05 "widgets, change one and all follow" request.
- Smoothness is done.
- Still open: a component gallery with live previews (slice 3), more Foundation parts (27 today), and `Apply to all N` for props across pages.
- Look at varelyo.com before building any of it.

## Live testing

- Start the app: `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud`, with `run_in_background`. Check `ps` first and never kill the user's own app. Stop it: `pgrep -f '<scratchpad>/ud' | xargs kill -9`. Restart after main changes (`bridge.ts`, `patch.ts`).
- Kits: copy `design-kits/kits/*` to `<ud>/design-packs/kits/<id>@1.0.0`, and write `active.json` as `{"<id>":{"version":"1.0.0","sha256":"local-check","source":"local"}}` for each kit.
- Threads: run `m3-setup.mjs`, then `bun .ai/kit-tools/kit-page.ts design-kits/kits/<id> <ud>/chats/<thread>`. To open one: click (98, 22) to unfold the sidebar, then `button.thread-open`.
- A fresh profile lists API-made threads only after `location.reload()`.
- `m5-*.mjs` now use the tag, chip and Actions, not the pill. At a 1920×969 window, `m5-select`'s grid `h2` sits under the Composer (3 false failures). `m5-scenario` leaves a click listener in the frame: run it twice without a reload and Preview counts 2.
- Scripts run through `node .ai/kit-tools/m4-drive.mjs <absolute script path>` with `M5_FILE`, `M4_FILE` or `M5_SHOTS`. Scroll the frame to the top and reset the page between scripts, with one driver at a time.

## Live traps

- Any scroll closes a `Select`, including Layers scrolling to a new selection: in scripts, wait about 1 s after selecting before opening one, and scroll the popup list itself to reach far options. After a theme switch, the panel's computed colours (`el.style`) are stale until the next selection.
- Bridge helpers are serialized one by one: a helper can't call another by name.
- A new bridge message needs `readBridgeMessage`. A new `DesignChange` kind needs a case in `documents.ts`.
- Each `designHistory` call hands out waiting conflicts once: pass every result through `showConflicts`.
- Settings updates reset `paneLayout`. Tests have no DOM: use `parse5`, and check DOM code in Chrome or the app.
- Scripts must never read the system clipboard (it holds the user's data): stub `navigator.clipboard` as `m6-actions.mjs` does. Actions items below the fold need `scrollIntoView` before a click.
- A failed script step can type into the Composer and send it. In zsh, `kill $PIDS` with several ids fails silently.

## How to work

- Workers: Zen free, then PGA, then TokenHarbor, then Haiku `Explore`. Check `git status` after each run.
- UI follows `DESIGN.md`. Check it in the real app, in dark and light, at 900px.
- Live model runs: DeepSeek free first. Codex, Claude Sonnet (high) and PGS Grove are allowed; ask before anything else. Codex usage was reset on 2026-11-09 (it had been at 92% of the 30-day limit). Claude weekly was at 94% that morning; the user said to go ahead.
- Lower priority: the PR from `m4` to `main`, the first `release-cubiq.yml` run, the native provider's image-to-text-model bug, and GitHub #10.
