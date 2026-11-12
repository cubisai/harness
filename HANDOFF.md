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

0. **Resume here: GradientDeck merged into `m4` (`14fd6d4`, 2026-11-12); Windows CI on the same code (`8509f7e`, run 43185767592). User asked to do all leftovers next (items 2-4 below, the unverified live checks and the gallery).**
    - Spec: `.ai/plans/gradientdeck-production.md`. Branch `track/gd-refs` merged and deleted (remote copy kept).
    - Phase 6: `resources/design-styles` removed; legacy `style:`/`kit:foundation/<x>` threads keep a frozen `system/` ("Legacy style · Name"); no reference falls back to Foundation's base theme; Compare 3 without references uses installed kit themes. 4,460 tests, design:check 0 errors.
    - **Bug fixed in `cdc0efe`:** `src/main/index.ts` wrapped `setDirection` with 4 arguments and dropped `reference`, so in the app an agent's reference pick always fell back to Foundation's base theme (unit tests call the service directly and missed it). Now `(...args)` pass-through, pinned by a source test in `design-reference-direction.test.ts`.
    - Live-checked (m4-built legacy threads, then the phase 6 app): legacy `system/` bytes identical after a turn; chip/Style row/board label say "Legacy style · Atelier/Market Day"; picker without refs = Auto + Foundation + Download card; Compare 3 without refs = 3 different kits, with refs = 3 references; picker switch legacy → Rainmaker pins `.reference` + `REFERENCE.md`, ⌘Z offered; fresh Auto with no refs → `kit:foundation`, no `Pick one of:`; Codex Auto with refs → `gradientdeck/depot@…` pinned.
    - Seen, not phase 6: a DeepSeek turn got CubiQ's `run_code` (no `search`, no `tools.cubiq`), could not reach `design_set_direction` and built without a system; a rerun got opencode's Code Mode and worked. A page's unlayered `button { color: inherit }` beat the kit's `@layer cubiq-ui` button colour (text = background); the rendered lint does flag it (contrast 1.0:1), so the agent shipped despite a finding.
    - **Phase 7 bench (2026-11-12, `cdc0efe`, prompts 1/3/7, TokenHarbor `deepseek-v4.1-flash:free`, the after-bench model).** Raw: `.ai/plans/m8-bench/refs-deepseek.json` (+ `-oldscorer`), `refs-sol.json`; scorer `.ai/kit-tools/m8-score-refs.ts` (reference, retrieval, page-CSS grounding/hex, rendered full lint in headless Chrome).
        - Kit share: landing 0.08 → 0.50, login 0.38 → 0.35, deck 0.32 → 0.08 (deck now 0 unknown parts/0 bad props, was 2/5, but 5 hex in its own `deck.css`). Final rendered lint: landing 0, login slop 2, deck targets 1 + slop 1.
        - All 3 hit the 12-min cap (before: landing 6.4, login 7.2). Pages are written by ~4-5 min; first lint had 34 findings (6 contrast, 23 targets) and the agent fixed to 0, then kept polishing. Input tokens 202k → 392k. Reference retrieval is small: 1.2k/2.9k/3.3k tokens per run.
        - Picks: Notion (landing), Apple from glideapps/whatsapp/apple (login), **Kindsight (SaaS) for the coffee deck**: the agent passed alison-roman with alternates touchy-coffee + kindsight, and the seeded shortlist picked the off-topic alternate. User chose to favour the first pick: weights now 0.7/0.2/0.1 (was 0.5/0.3/0.2); industry filter rejected (112 refs are "other", incl. alison-roman).
        - gpt-6.1-sol via `agentrouter-responses` (bench agent `opencode-agentrouter-sol`): AgentRouter errors "item was created under a different OpenAI resource" and reports no usage, so its numbers aren't usable. Picks were sensible (Evernote, Headspace, Sweetgreen); it reads more (9-13k tokens per run).
    - Providers on 2026-11-12: Zen free and PGS Grove are spent (PGS refills 2026-11-13 10:32 UTC); TokenHarbor free works; Codex is allowed.
    - Live recipe: scratch profile with `active.json` kits (below); the old profile's `design-references` (48 MB) is in `scratchpad/ud` of the earlier session and can be copied to test the "with references" case. Offline: `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9`. Zen free hit its limit on 2026-11-12; use PGS Grove (`updateThread(id,{model:"PGA/deepseek-v4.1-flash-1017"})`). Real download: 2,590 files, 43 MB, 93 s. `finn` compact always times out (recorded as missing, by design).
    - Flakes: `test/mcp-http.test.ts` heartbeat under load; a full-suite run once failed 5 unnamed tests. Rerun before concluding.
    - `m4` is ahead of origin by the handoff commits. The user runs that push.
1. **M8 Windows gate passed** on `eae4e6a` ([run 42742566763](https://github.com/cubisai/harness/actions/runs/42742566763); extras skipped). Ordinary `m4` pushes don't trigger CI: `gh workflow run ci.yml --repo cubisai/harness --ref m4 -f os=windows`. Rerun a lone ACP "can't start" timeout once.
2. **M8 revised: GradientDeck references first.** Research/rollout plan: `.ai/plans/gradientdeck-replacement.md`. The original `.ai/plans/design-mode-v2.md` M8 notes and benchmarks below are the comparison baseline, not the new style-selection design.
    - M8 bench (a)-(e) detail (baseline `6429027`, `1e29423` kit lint, `5593114` skills, after-bench numbers and scoring limits) moved to the archive; raw `.ai/plans/m8-bench/{before,after}.json`, scorer `.ai/kit-tools/m8-score.mjs`. Varelyo `icon.name` is a text prop: **re-pack kits before publish**.
    - **Reliability work still owed after the reference experiment:** protect/restore managed `system/`, direction before building, full lint including external CSS, token budget, Foundation blocks, then fresh DeepSeek/Sonnet/Codex comparisons. No protection implementation has started.
3. **GradientDeck experiment (2026-11-10), superseded by item 0:** research corpus `.ai/plans/gradientdeck-corpus/` and local MCP `.ai/kit-tools/gradientdeck-mcp.mjs` (notes: `.ai/plans/gradientdeck-replacement.md`). References are data, not kits: no logos, media or proprietary fonts; confirm redistribution before ever bundling.
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
- Start the app: `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`, with `run_in_background`. Without those flags the hidden window runs no rAF and throttles timers, so anything frame-driven looks one step stale. Check `ps` first and never kill the user's own app. Stop it: `pgrep -f '<scratchpad>/ud' | xargs kill -9`. Restart after main changes (`bridge.ts`, `patch.ts`).
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
