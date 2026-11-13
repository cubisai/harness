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

0. **Resume here: leftovers plan `.ai/plans/m8-leftovers.md` (phases A-F). A-D done (`19e0d6c`, `782e395`, `4cae32e`, `c2fcc19`, `141de69`, `051bf42`, `308c2dd`). Pushed to origin 2026-11-13 (through the handoff commit); Windows CI not yet run on it. Now: E (live-check backlog), then F (bench).**
    - **E, 2026-11-13, in progress.** Pass: patch during a real agent turn (after fix `d736803`), in-place patch on a picker theme switch (and ⌘Z), `Save as composition…` (toast, shows under Compositions in Insert, inserts), block insert (blocks show only when searched; Pricing went in after the selected section). Left: `Preparing style…`/`Retry`, `PlanLip`, `Custom…` (now: type a change into the Actions search), Draw's `Send`, `Build in codebase`. Scripts (run through `m4-drive.mjs`): `.ai/kit-tools/m8-e1-patch.mjs` (marks the frame window, sends `PROMPT`, checks the mark survives), `m8-e2-compose.mjs` (`SEL`), `m8-e3-block.mjs`, `m8-e4-theme.mjs`; `frame-eval.mjs <expr>` evaluates in the canvas frame.
    - `d736803`: an agent edit that added a newline after `</html>` (it lands in body) pushed the page's unchanged `ui.js` script into patchKids' middle, where a script can't be re-made, so the frame reloaded (`patched ok:false reason:"body"`). Unchanged nodes now keep their live copy anywhere in the middle. Checked live: newline added/removed, footer after the script; kit calendar drawing kept. Only reproduced with kit-page pages (no final newline); real agent pages usually end in one.
    - `Retry` needs a catalog entry: `KIT_CATALOG` is empty, so no uninstalled kit is ever listed. To check it: a temporary, uncommitted catalog entry with a GitHub URL that 404s, plus removing that kit from `active.json`, then restart.
    - Seen, not fixed: after an insert moves the layout, the hover outline/tag stays on the old spot until the mouse moves.
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
- Still unverified (phase E): `Preparing style…`/`Retry` (catalog empty) and the live plan card (`PlanLip`).
- Remaining M5 agent-turn checks: `Custom…`, Draw's `Send` and `Build in codebase` (Compare 3 passed 2026-11-12).

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
