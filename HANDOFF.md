# Handoff: CubiQ Design Mode 2.0

Short on purpose: current state, next steps, open questions and live traps. Replace text rather than adding to it, and move finished detail to the archive.

**On another machine, read `HANDOFF_2.md` first**: how to pull both branches, recreate the worktree and restore the git-ignored `.ai/` folders.

- Archive (M3 kit method, M4 and M5 checks, all old traps): `.ai/plans/handoff-archive-2026-11-06.md` (git-ignored, Mac only). Older: `git show 850f3cf:HANDOFF.md`.
- Plan: `.ai/plans/design-mode-v2.md` (M0-M8). Spec: `design_plan.md` and `design_mode_mock.html`. Search them, don't read them whole.
- **Reference:** the screen recording `Screen Recording 2026-11-05 at 5.30.18 in the afternoon.mov` in the main checkout. To see it: `ffmpeg -i <mov> -vf fps=1/3 f%02d.png`, then tile them 2x2.

## Start here

1. Work on `m4` in the main checkout (the worktree and `track/design-v2` were merged and removed 2026-11-09). For new work, branch off `m4` into a fresh worktree (`git worktree add ../aiharness-wt/<name> -b track/<name> m4`, then `bun install` and `node node_modules/electron/install.js`). The kit tools now live in the main checkout's `.ai/kit-tools` and `.ai/kit-release` (git-ignored, Mac only).
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
| M7 | **Closed 2026-11-09.** Merged into `m4` (`14be44f`) |
| M8 | **In progress.** (a) (b) (c) and the DeepSeek after-bench done; merged into `m4` (`3931300`) and **pushed** 2026-11-09. Open: deck grounding, `system/` hand-writes, (d) styles, Sonnet/Codex runs |

## Next, in this order

1. CI: `gh run list --workflow ci.yml --branch m4` for `3931300` (not checked yet). Rerun a lone ACP "can't start" timeout once.
2. **M8, on `m4`.** Plan `## M8` plus the notes under it in `.ai/plans/design-mode-v2.md`.
    - (a) Baseline (`6429027`, PGS `PGA/deepseek-v4.1-flash-1017` via opencode, bench agent `opencode-pga-deepseek`; Zen free is at its limit): 0 kit parts on all 3 pages; landing has no direction call; login and deck hit the 12-min cap. Raw: `.ai/plans/m8-bench/before.json`.
    - (b) `1e29423`: lint rule `kit` (`grounding.ts`: unknown part, bad prop value, page CSS redrawing a part, `Kit:` coverage line); `design_kit_inspect` `search:` / `page:`; `design_set_direction` takes `kit` + `theme` + `appearance` from a kit-theme index, and Auto stores `kit:foundation/<style>`. Varelyo `icon.name` is now a text prop (46 icons, over the 32-option cap): **re-pack kits before publish**.
    - (c) `5593114`: guide 548 words; 4 skills `design-build`, `design-variants`, `design-kit` (+ extract path), `design-review` (critique + handoff) replace the 7 old ones.
    - (e) After-bench, same DeepSeek model (landing on PGS before it ran out of credit, login and deck on TokenHarbor `deepseek-v4.1-flash:free`, bench agent `opencode-tokenharbor-deepseek`). Raw: `.ai/plans/m8-bench/after.json`, scorer `.ai/kit-tools/m8-score.mjs <bench out>`.
        - Landing: `foundation/clean-inset`, 15/187 kit parts (8%), 0 errors, 6.4 min (before 0/158).
        - Login: `foundation/soft-health`, 49/129 (38%), 0 errors, 0 hex, finished in 7.2 min (before 0/164, 21 hex, cap).
        - Deck: 124/392 (32%), but invented `stat`/`meter`, 5 bad prop values, 20 `[data-ui]` rules in `page.css`, cap again, no lint run. It skipped `design_set_direction` and **hand-wrote `system/`** (`.system` = `kit:foundation/roast`, 4 files, no `components.json`).
        - Tokens in: 162k before, 201k after (the plan wanted fewer).
    - **Next fixes:** block agent writes to `system/` (fence) or rebuild it at turn end; make a deck call direction first; more Foundation blocks (only 3, so landing pages stay hand-built); get decks to run lint within the cap; trim tokens. Then one live run each on Claude Sonnet and Codex.
    - Mid-way check after (b) only: Auto landed on `kit:foundation/newsroom`, but the page was 9/230 kit parts and had 2 redraws, so the result rests on (c).
3. **Discuss next with the user: the 32 flat styles (M8 d).** They are Foundation's only themes (compat `*`) and every Auto pick uses one. The user asked "can we just delete them all?".
    - Claude's view: a full wipe leaves Auto with Foundation's default look or a kit colour swap; decks and mobile lose their only styles (2 each); and it needs the whole style path removed (More styles, style previews, the fonts pack, the direction index, migrating `style:x` threads).
    - Proposed instead: cut to about 12–16 distinct styles covering web, mobile and deck, chosen through an oc review.
    - Ready for that: specimens (each style on Foundation's hero, feature-grid, pricing and form/table parts) plus contrast numbers (scratchpad, gone after that session: rebuild by putting each style's `tokens.css` and Foundation's `ui.css` behind its 3 blocks plus field/table/alert/tabs/badge). All 32 pass contrast, so the cut is about taste.
    - Wait for the user's choice: "cut" or "all".
4. **M8, still open from M6:** a tool that renders one draft part; guidance on page token overrides (`@layer page` loses to `tokens.css`); journey D (new-kit grounding, failed everywhere in M6). The no-literal rule is now in the guide and the lint.
5. **The user runs `publish`:** `release-kits.sh pack` again first (`ui.js` changed), then fill `KIT_CATALOG` with release URLs and SHA-256 hashes.

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
