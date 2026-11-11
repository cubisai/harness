# Handoff: CubiQ Design Mode 2.0

Short on purpose: current state, next steps, open questions and live traps. Replace text rather than adding to it, and move finished detail to the archive.

**On another machine:** use the merged `m4` checkout; the old worktree and track branch are no longer needed. `.ai/` is git-ignored: copy `.ai/plans`, `.ai/kit-tools` and `.ai/kit-release` from the Mac before using local plans or scripts.

- Archive (M3 kit method, M4-M7 checks and old traps): `.ai/plans/handoff-archive-2026-11-06.md` (git-ignored, Mac only). Older: `git show 850f3cf:HANDOFF.md`.
- Plan: `.ai/plans/design-mode-v2.md` (M0-M8). Spec: `design_plan.md` and `design_mode_mock.html`. Search them, don't read them whole.
- **Reference:** the screen recording `Screen Recording 2026-11-05 at 5.30.18 in the afternoon.mov` in the main checkout. To see it: `ffmpeg -i <mov> -vf fps=1/3 f%02d.png`, then tile them 2x2.

## Start here

1. Work on `m4` in the main checkout (the worktree and `track/design-v2` were merged and removed 2026-11-09). For new work, branch off `m4` into a fresh worktree (`git worktree add ../aiharness-wt/<name> -b track/<name> m4`, then `bun install` and `node node_modules/electron/install.js`). The kit tools now live in the main checkout's `.ai/kit-tools` and `.ai/kit-release` (git-ignored, Mac only).
2. Before every commit: `bun run typecheck`, `bun run test`, `bun run design:check`. Commit only that change's files, 150 characters or fewer, no trailer. Update this file at each milestone (the user's request); keep it under about 100 lines.

## User decisions

- Full v2 is always on; M7 removed `designV2` and the old UI. M0-M7 were approved; M5 still has outstanding live checks. Stop after 2 failed fixes on one piece, and ask before merging into `m4`.
- **Follow the recording** for whatever the plan still lacks (2026-11-06). That includes the pill: **no floating pill.** The selection is a Composer chip (`Selection: Grid ×`), with a name tag and 8 handles on the canvas.
- 6 kits in `design-kits/`, all approved. Foundation is bundled. Kit UI is written by Claude, not workers, from real library values, with no copied source and no NOTICE (fonts carry `OFL.md`). Only the user pushes `cubisai/design-kits`.
- No Varelyo branding beyond that one kit's name. M7 removed the obsolete UI and its pinned tests.
- **2026-11-10:** replace the 32 taste/style presets with real-site DESIGN.md data from GradientDeck; collect all references and expose a local read-only MCP for testing. This replaces the "cut or all" question; production deletion/migration is not done yet.
- Later, not approved: Guardian, production external MCP (the GradientDeck test above is allowed), multi-tab, parallel agents, Sketch, Connect, multi-brand, user repos, signed catalog, Change History.

## Status

| # | State |
|---|---|
| M0-M4 | Closed, Windows green |
| M5 | Selection chip and Typography pushed, Windows green (run 42166030432). `3 Variants` passed live on kit and flat threads in M7; remaining agent-turn checks below |
| M6 | **Closed 2026-11-09.** Slices 1-5 done; fixes through `17d3ee7`. Journey D moves to M8 |
| M7 | **Closed 2026-11-09.** Merged into `m4` (`14be44f`); CI green on `6429027` (run 42569038106) |
| M8 | **In progress; direction revised 2026-11-10.** Kit-first changes merged/pushed (`3931300`); Windows CI green on `eae4e6a` (run 42742566763). GradientDeck research/local MCP experiment replaces the 32-style taste review. Production migration, grounding/full lint and model runs remain open |

## Next, in this order

0. **Session 2026-11-11, resume here (GradientDeck production, build in progress):**
    - Spec approved: `.ai/plans/gradientdeck-production.md` (defaults taken: OFL font substitution, mixed → light + derived dark, compact + extended, first-run download, nothing bundled).
    - Worktree `../aiharness-wt/gd-refs`, branch `track/gd-refs` off `m4`. Deps installed. Phase 1 **committed `ad95541`** (store, downloader, IPC `design:references:*`, `designReferencesAsked` setting). Phase 2 **uncommitted**: `references.ts` (search/get/facets text), caching in `references-store.ts`, two tools in `tools.ts` (`design_reference_search`, `design_reference_get`, only when `deps.references` is set), `test/design-references.test.ts`. Typecheck clean; 44 related tests pass. Not yet done: passing `references` into the deps in `src/main/index.ts` (~line 576), the full test run, a review pass, and the commit. Delete `.ai/tmp/` in the worktree before the next phase.
    - Real download (phase 1, live network): 2,590 files, 43 MB, 93 s; no-change update 22 s. `finn` compact always times out (recorded as missing, by design).
    - Next: finish phase 2 → phase 3 (adapter `adaptReference` plus a dev-only corpus sweep over `.ai/plans/gradientdeck-corpus`; Windows CI). Remaining phases 4-7 are in the spec.
    - Pre-release: the 32 styles are still in use; nothing user-visible has changed yet. Only the store and tools are new.
    - Worktree reads: the Read tool refuses paths outside the main checkout. To allow `aiharness-wt`, run `/add-dir /Users/phumrin/Documents/ai-agent/aiharness-wt` in the session.
    - Earlier this session: renderer narrow-width work committed (`f8bde92`, live-checked by `.ai/kit-tools/m8-narrow.mjs`; the rail now folds on the canvas width, not the header).
    - Flakes: a full-suite run failed 5 unnamed tests once (passed on rerun), and `test/mcp-http.test.ts` heartbeat failed once under load (passes alone, also on `m4`). Rerun before concluding anything.
    - Nothing is pushed: `m4` is 5 commits ahead of origin (`15b1a06` through `bdaf273`). The user runs the push.
1. **M8 Windows gate passed** on `eae4e6a` ([run 42742566763](https://github.com/cubisai/harness/actions/runs/42742566763); extras skipped). Ordinary `m4` pushes don't trigger CI: `gh workflow run ci.yml --repo cubisai/harness --ref m4 -f os=windows`. Rerun a lone ACP "can't start" timeout once.
2. **M8 revised: GradientDeck references first.** Research/rollout plan: `.ai/plans/gradientdeck-replacement.md`. The original `.ai/plans/design-mode-v2.md` M8 notes and benchmarks below are the comparison baseline, not the new style-selection design.
    - (a) Baseline (`6429027`, PGS `PGA/deepseek-v4.1-flash-1017` via opencode, bench agent `opencode-pga-deepseek`; Zen free is at its limit): 0 kit parts on all 3 pages; landing has no direction call; login and deck hit the 12-min cap. Raw: `.ai/plans/m8-bench/before.json`.
    - (b) `1e29423`: lint rule `kit` (`grounding.ts`: unknown part, bad prop value, page CSS redrawing a part, `Kit:` coverage line); `design_kit_inspect` `search:` / `page:`; `design_set_direction` takes `kit` + `theme` + `appearance` from a kit-theme index, and Auto stores `kit:foundation/<style>`. Varelyo `icon.name` is now a text prop (46 icons, over the 32-option cap): **re-pack kits before publish**.
    - (c) `5593114`: guide 548 words; 4 skills `design-build`, `design-variants`, `design-kit` (+ extract path), `design-review` (critique + handoff) replace the 7 old ones.
    - (e) After-bench, same DeepSeek model (landing on PGS before it ran out of credit, login and deck on TokenHarbor `deepseek-v4.1-flash:free`, bench agent `opencode-tokenharbor-deepseek`). Raw: `.ai/plans/m8-bench/after.json`, scorer `.ai/kit-tools/m8-score.mjs <bench out>`.
        - Landing: `foundation/clean-inset`, 15/187 `data-ui` elements (8%), no scored HTML grounding findings, 6.4 min (before 0/158).
        - Login: `foundation/soft-health`, 49/129 (38%), no scored HTML grounding findings, 0 inline hex, finished in 7.2 min (before 0/164, 21 inline hex, cap).
        - Deck: 124/392 (32%, including invented `stat`/`meter`), 5 bad prop values, 20 `[data-ui]` rules in `page.css`, cap again. It skipped `design_set_direction` and **hand-wrote `system/`** (`.system` = `kit:foundation/roast`, 4 files, no `components.json`).
        - **Scoring limits:** all 3 have `lint: null`; no clean full lint run is evidenced. Coverage counts every `data-ui`, including unknown parts. CSS checks inspect inline `<style>` only, not external `page.css`; these numbers do not close M8 verification.
        - Tokens in: about 163k before, 202k after (+24%; the plan wanted fewer).
    - **Reliability work still owed after the reference experiment:** protect/restore managed `system/`, direction before building, full lint including external CSS, token budget, Foundation blocks, then fresh DeepSeek/Sonnet/Codex comparisons. No protection implementation has started.
3. **GradientDeck experiment done (2026-11-10):** all 1,295 references represented in `.ai/plans/gradientdeck-corpus/`: 2,589 Markdown files (~43 MB); Finn compact timed out, its extended file is available. Audit records the missing variant honestly. Local MCP `.ai/kit-tools/gradientdeck-mcp.mjs` has search/get/facets and paginated resources; 13 full-corpus + 13 fixture checks pass. Client setup/results: `.ai/plans/gradientdeck-replacement.md`.
    - These are references, not runnable kits or drop-in Foundation themes. Keep original bytes/provenance separate from normalized tokens and existing kit parts. Do not put all 1,295 entries in tool descriptions or overwrite CubiQ's root DESIGN.md.
    - Next: approve reference-to-kit application and legacy-thread migration, then remove all 32 from selection/packaging and run visual/model benchmarks. Confirm corpus redistribution before bundling/publishing; no logos, media or proprietary fonts copied. App code/styles are untouched by this experiment; do not keep retrying Finn's compact endpoint.
4. **M8, still open from M6:** a tool that renders one draft part; guidance on page token overrides (`@layer page` loses to `tokens.css`); journey D (new-kit grounding, failed everywhere in M6). The no-literal rule is now in the guide and the lint.
5. **The user runs `publish`:** `release-kits.sh pack` again first (`ui.js` changed), then fill `KIT_CATALOG` with release URLs and SHA-256 hashes.

## Live coverage and remaining checks

- M6 journeys: G4 pass (DeepSeek); F and I pass on Codex and Sonnet high; DeepSeek fails F (no vision) and I (builds a page); D fails everywhere tried (M8). Completed implementation and check details are in the archive.
- M7 checked draft, flat-style and project-folder threads, plus `3 Variants`, cycling and Discard on kit and flat threads. Picker/theme flows passed in M6; **the in-place patch during a picker theme switch remains unverified**, not the picker generally.
- Still unverified: patch during a real agent turn, `Save as composition…` and block insert, `Preparing style…`/`Retry` (catalog empty), and the live plan card (`PlanLip`).
- Remaining M5 agent-turn checks: `Custom…`, Draw's `Send`, `Compare 3 other styles`, and `Build in codebase`.

**Not yet told to the user:**
- System mode: Typography uses system fonts (kit fonts aren't loaded in the app), palette ramps are worked out rather than kit tokens, and chat uses the same thread, not the recording's separate "New design system chat".
- Page tokens are written inline on `<html>`; `Save as composition…` refuses over 4 KB.
- Kit hand-edit undo ends on restart. A kit move covers every page, and `⌘Z` restores all of them; AI adaptation after a move is a chat request.
- The turn card counts parts on the page, not what the agent touched; "new" means not on the page before that turn.
- `Move to…` is click-a-target then Before/After/Inside, not drag. `Go to component` opens System mode's part page, not a `.tsx`.
- Unbuilt M5 items: the breakpoint bar, `⌥`-drag clone, `Tab` into the canvas, and `⌘F`.

**Open with the user:** their 2026-11-05 "widgets, change one and all follow" request.
- In-place smoothness is implemented (unverified paths above). System mode already has live component previews with Variants/Playground/Usage.
- Still open: a browse-all component gallery with previews reused by Insert and Swap, more Foundation parts (27 today), and `Apply to all N` for props across pages. The gallery is an extension of the built System mode, not an unbuilt slice 3.
- Look at varelyo.com before building any of it.

## Live testing

- Scratchpads don't survive a restart: rebuild with the steps below (about 2 minutes). Opening a thread: click the button titled `Show sidebar…`, click `button.thread-open` until `.design-frame` src has the id, then `Hide sidebar…` (the store isn't on `window`). See `m8-narrow.mjs`.
- Start the app: `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud`, with `run_in_background`. Check `ps` first and never kill the user's own app. Stop it: `pgrep -f '<scratchpad>/ud' | xargs kill -9`. Restart after main changes (`bridge.ts`, `patch.ts`).
- Kits: copy `design-kits/kits/*` to `<ud>/design-packs/kits/<id>@1.0.0`, and write `active.json` as `{"<id>":{"version":"1.0.0","sha256":"local-check","source":"local"}}` for each kit.
- Threads: run `m3-setup.mjs`, then `bun .ai/kit-tools/kit-page.ts design-kits/kits/<id> <ud>/chats/<thread>`. To open one: click (98, 22) to unfold the sidebar, then `button.thread-open`. A fresh profile lists API-made threads only after `location.reload()`.
- `m5-*.mjs` now use the tag, chip and Actions, not the pill. At a 1920×969 window, `m5-select`'s grid `h2` sits under the Composer (3 false failures). `m5-scenario` leaves a click listener in the frame: run it twice without a reload and Preview counts 2.
- Scripts run through `node .ai/kit-tools/m4-drive.mjs <absolute script path>` with `M5_FILE`, `M4_FILE` or `M5_SHOTS`. Scroll the frame to the top and reset the page between scripts, with one driver at a time.

## Live traps

- Never use `z.record` in a harness tool: it broke Claude's whole cubiq tool list (`5e7f2f2` fixed it). `test/claude-tool-list.test.ts` guards this.
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
