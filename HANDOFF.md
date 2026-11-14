# Handoff: CubiQ Design Mode 2.0

Short on purpose: current state, next steps, open questions and live traps. Replace text rather than adding to it, and move finished detail to the archive.

**On another machine:** use the merged `m4` checkout; the old worktree and track branch are no longer needed. `.ai/` is git-ignored: copy `.ai/plans`, `.ai/kit-tools` and `.ai/kit-release` from the Mac before using local plans or scripts.

- Archive (M3 kit method, M4-M7 checks and old traps): `.ai/plans/handoff-archive-2026-11-06.md` (git-ignored, Mac only). Older: `git show 850f3cf:HANDOFF.md`.
- Plan: `.ai/plans/design-mode-v2.md` (M0-M8). Spec: `design_plan.md` and `design_mode_mock.html`. Search them, don't read them whole.
- **Reference:** the screen recording `Screen Recording 2026-11-05 at 5.30.18 in the afternoon.mov` in the main checkout. To see it: `ffmpeg -i <mov> -vf fps=1/3 f%02d.png`, then tile them 2x2.

## Start here

1. Work on `m4` in the main checkout. **No worktrees** (user, 2026-11-12: about 1 GB each); all were removed, and `track/plugin-split` (separate harness-plugin repo idea) was deleted at the user's request. Kit tools live in `.ai/kit-tools` and `.ai/kit-release` (git-ignored, Mac only).
2. Before every commit: `bun run typecheck`, `bun run test`, `bun run design:check`. Commit only that change's files, 150 characters or fewer, no trailer. Update this file at each milestone (the user's request); keep it under about 100 lines.

## User decisions

- Full v2 is always on; M7 removed `designV2` and the old UI. M0-M7 were approved; M5 still has outstanding live checks. Stop after 2 failed fixes on one piece, and ask before merging into `m4`.
- **Follow the recording** for whatever the plan still lacks (2026-11-06). That includes the pill: **no floating pill.** The selection is a Composer chip (`Selection: Grid ×`), with a name tag and 8 handles on the canvas.
- 6 kits in `design-kits/`, all approved. Foundation is bundled. Kit UI is written by Claude, not workers, from real library values, with no copied source and no NOTICE (fonts carry `OFL.md`). Only the user pushes `cubisai/design-kits`.
- No Varelyo branding beyond that one kit's name. M7 removed the obsolete UI and its pinned tests.
- **2026-11-10:** replace the 32 taste/style presets with real-site DESIGN.md data from GradientDeck. Done and merged 2026-11-12 (`14fd6d4`).
- **2026-11-12:** "real components like shadcn" = a browse-all gallery built from the existing kits' parts (Insert/Swap reuse it), not shipping library source.
- Later, not approved: Guardian, production external MCP (the GradientDeck test above is allowed), multi-tab, parallel agents, Sketch, Connect, multi-brand, user repos, signed catalog, Change History.

## Status

| # | State |
|---|---|
| M0-M4 | Closed, Windows green |
| M5 | Selection chip and Typography pushed, Windows green (run 42166030432). `3 Variants` passed live on kit and flat threads in M7; remaining agent-turn checks below |
| M6 | **Closed 2026-11-09.** Slices 1-5 done; fixes through `17d3ee7`. Journey D moves to M8 |
| M7 | **Closed 2026-11-09.** Merged into `m4` (`14be44f`); CI green on `6429027` (run 42569038106) |
| M8 | **In progress.** GradientDeck phases 1-7 merged into `m4` (`14fd6d4`, 2026-11-12; local checks 4,461 passed). Leftovers below |

## Next, in this order

0. **Resume here: leftovers plan `.ai/plans/m8-leftovers.md` (phases A-F). A-E done (A-D: `19e0d6c`…`308c2dd`; E fix `d736803`, `ae82013`). Pushed through `cf9ff96`; `ae82013` and later not pushed; Windows CI not run. F's DeepSeek runs done; Codex/Sonnet runs not run.**
    - **F, 2026-11-14 (`4deae8d`, prompts 1/3/7, `bench/design-live.ts --agents opencode-zen-deepseek,opencode-pga-deepseek`, profile seeded with 6 kits + references).** Scores `.ai/plans/m8-bench/f-zen-pgs-deepseek.json` (`m8-score-refs.ts`); phase 7 = `refs-deepseek.json`. Kit share (Zen/PGS vs phase 7): landing 0.38/0.31 vs 0.50, login 0.39/0.16 vs 0.35, deck 0.12/0.04 vs 0.08. Final lint: landing 0 / contrast 1 (+2 kit), login slop 1/2, deck 0 / slop 5. Login finished (10.6 / 5.9 min; phase 7 hit the cap); landing and deck still hit the 12-min cap. Tokens in 68-139k per run (phase 7 116-152k).
    - Reference picks are on topic now, the coffee deck included (redbrick-coffee, assembly-coffee-london; phase 7 picked Kindsight): the 0.7/0.2/0.1 weighting works. Pages look good in screenshots.
    - F findings: deck scratch pages came from `design_screenshot` refusing `index.html?s=2`/`#N` (agents built wrapper pages to see a slide); the 5 deck hex were the template's own `var(--x, #hex)` fallbacks; PGS landing re-ran lint 12× on 3 findings it couldn't clear.
    - **Fixed `cb06de5`:** `design_screenshot` takes `#N`/`?query`; `design_lint` says "Stop fixing… report" from the 3rd identical result per page+width (resets after 15 min); clean note and `design-build` say delete helper pages; `deck.css` fallbacks removed (all kits define the 5 tokens).
    - **Re-run on PGS only** (Zen hit "Free usage limit reached" mid-run; scores `.ai/plans/m8-bench/f2-pgs-deepseek.json`): deck made no scratch pages (was 3); landing stopped 0.2 min after its first clean lint (8.6 min, was cap). Login still hit the cap and left `probe.html`, but its post-clean work found real bugs (a `hidden` alert shown by the theme's `display:flex`, a stale JS selector), so a hard stop would cost quality. Kit share is noisy at n=1 (landing 0.07, login 0.26, deck 0.36).
    - **F still open:**
        - Agents still write hard-coded colours: they define their own page tokens with hex (`--color-carbon: #1d1d1b` in the deck's `deck.css`; 10 hex on the landing page). This is the open M6 page-token-override item (item 4): it needs a rule for when a page may define its own tokens.
        - The PGS deck didn't use the deck scaffold: it skipped `deck.js`, so slide navigation in that deck doesn't work.
        - Zen has no results for the re-run (free quota ran out mid-landing): re-run `--agents opencode-zen-deepseek --prompts 1,3,7` once its quota resets.
    - **E closed 2026-11-14 (Codex, shadcn kit thread in Chats).** All pass: patch in a real turn, theme in-place patch, `Save as composition…`, block insert, `Preparing style…`→`Couldn't download Mantine`→`Retry` (temporary 404 catalog entry, reverted), `PlanLip` (0→3 of 3, opens, gone at turn end), `Custom…` (Actions search + Enter; headline went blue), Draw `Send` (strokes, note, screenshot and circled element reached the agent). `Build in codebase` failed in Chats: the build thread starts in its own empty folder and can't find `designs/<id>/`; `ae82013` disables it there ("Needs a project folder") with a store guard. **Not checked live: a project-folder build** (`addProject` is a native dialog).
    - **Open bug (not fixed, `codex.ts` has someone else's uncommitted work):** Codex `fileChange` updates arrive as bare `@@` hunks with no `---/+++` header, so `parseUnifiedDiff` counts nothing and the turn card says `+0 −0` (the uncommitted diff fixes only add/delete). Fix belongs in `resultPayloadFor`.
    - Seen, not fixed: after an insert moves the layout, the hover outline stays on the old spot until the mouse moves; Codex widened a one-line `Custom…` request into a 44px-target lint pass; the sidebar unfolded once at a turn end (not reproduced).
    - Scripts: `.ai/kit-tools/m8-e1..e4*.mjs` via `m4-drive.mjs`; the E5-E10 scripts lived in the session scratchpad. GradientDeck references download with `window.unskilled.designReferencesDownload()` (1,295 refs, 44 MB; one `finn` compact timed out).
    - A-D, journey D, the Zen free fix `9058ae5`, C's gallery, craft rules, GradientDeck phases 6-7 and the phase 7 bench: archive, section "M8 leftovers A-D". Live recipe with references: copy an old profile's `design-references`; offline: `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9`.
    - Providers 2026-11-13: Zen free and PGS are spent again after journey D (PGS refills 10:32 UTC); TokenHarbor free ends turns at its output limit; explabs has no credits. The user chose AgentRouter Sol (`updateThread(id,{model:"agentrouter-responses/gpt-6.1-sol"})` on an OpenCode thread; slow, about 1 min for a one-line edit), then **Codex for speed** (`createThread(chats,"codex",{kind:"design"})`). Use Codex for the rest of E.
    - Live recipe for TokenHarbor: launch the app after `set -a; source .env`, then `discoverProviderModels({id:"tokenharbor",wireProtocol:"openai-chat",baseURL:"https://tokenharbor.ai/v1",secret:{kind:"envRef",envVar:"TOKENHARBOR_API_KEY"},models:[]})` and `saveProvider` with the discovered model entry; agent `provider-tokenharbor`. Journey D driver pattern: `designSetIntent(id,{kind:"new-kit"})` then `send`; poll `listEvents` (no `isRunning` in the preload API).
    - Flakes: `test/mcp-http.test.ts` heartbeat under load; a full-suite run once failed 5 unnamed tests. Rerun before concluding.
    - `m4` pushed 2026-11-13 at the user's request. Windows CI only runs on demand (item 1).
1. **M8 Windows gate passed** on `eae4e6a` ([run 42742566763](https://github.com/cubisai/harness/actions/runs/42742566763); extras skipped). Ordinary `m4` pushes don't trigger CI: `gh workflow run ci.yml --repo cubisai/harness --ref m4 -f os=windows`. Rerun a lone ACP "can't start" timeout once.
2. **M8 revised: GradientDeck references first.** Research/rollout plan: `.ai/plans/gradientdeck-replacement.md`. The original `.ai/plans/design-mode-v2.md` M8 notes and benchmarks below are the comparison baseline, not the new style-selection design.
    - M8 bench (a)-(e) detail (baseline `6429027`, `1e29423` kit lint, `5593114` skills, after-bench numbers and scoring limits) moved to the archive; raw `.ai/plans/m8-bench/{before,after}.json`, scorer `.ai/kit-tools/m8-score.mjs`. Varelyo `icon.name` is a text prop: **re-pack kits before publish**.
    - **Reliability work still owed after the reference experiment:** protect/restore managed `system/`, direction before building, full lint including external CSS, token budget, Foundation blocks, then fresh DeepSeek/Sonnet/Codex comparisons. No protection implementation has started.
3. **GradientDeck experiment (2026-11-10), superseded by item 0:** research corpus `.ai/plans/gradientdeck-corpus/` and local MCP `.ai/kit-tools/gradientdeck-mcp.mjs` (notes: `.ai/plans/gradientdeck-replacement.md`). References are data, not kits: no logos, media or proprietary fonts; confirm redistribution before ever bundling.
4. **M8, still open from M6:** guidance on page token overrides (`@layer page` loses to `tokens.css`). Part preview and journey D are done (item 0).
5. **The user runs `publish`:** `release-kits.sh pack` again first (`ui.js` changed), then fill `KIT_CATALOG` with release URLs and SHA-256 hashes.

## Live coverage and remaining checks

- M6 journeys: G4 pass (DeepSeek); F and I pass on Codex and Sonnet high; DeepSeek fails F (no vision) and I (builds a page); D passes on Zen DeepSeek (2026-11-13). Completed implementation and check details are in the archive.
- M7 checked draft, flat-style and project-folder threads, plus `3 Variants`, cycling and Discard on kit and flat threads. Picker/theme flows passed in M6; the in-place patch on a theme switch passed in E.
- Phase E covered every M5 agent-turn check and `PlanLip`/`Retry`; only a project-folder `Build in codebase` run is still unverified.

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
- Start the app: `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`, with `run_in_background`. Without those flags the hidden window runs no rAF and throttles timers, so anything frame-driven looks one step stale. Check `ps` first and never kill the user's own app. Stop it: `pgrep -f '<scratchpad>/ud' | xargs kill -9`. Restart after main changes (`bridge.ts`, `patch.ts`).
- Kits: copy `design-kits/kits/*` to `<ud>/design-packs/kits/<id>@1.0.0`, and write `<ud>/design-packs/active.json` (not inside `kits/`; there the kits stay unknown and `setDesignSystem` falls back to Auto) as `{"<id>":{"version":"1.0.0","sha256":"local-check","source":"local"}}` for each kit.
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
- The driver's `key("Enter")` sends `rawKeyDown` with no char event, so it never submits a `<form>`: click its submit button. Several `cubiq-design://` targets exist (rail thumbnail `?v=2`, shooter page): evaluate in the one whose URL equals `.design-frame`'s `src`. The frame's CSP blocks `fetch`.

## How to work

- Workers: Zen free, then PGA, then TokenHarbor, then Haiku `Explore`. Check `git status` after each run.
- UI follows `DESIGN.md`. Check it in the real app, in dark and light, at 900px.
- Live model runs: DeepSeek free first. Codex, Claude Sonnet (high) and PGS Grove are allowed; ask before anything else. Codex usage was reset on 2026-11-09 (it had been at 92% of the 30-day limit). Claude weekly was at 94% that morning; the user said to go ahead.
- Lower priority: the PR from `m4` to `main`, the first `release-cubiq.yml` run, the native provider's image-to-text-model bug, and GitHub #10.
