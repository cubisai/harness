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
| M6 | Slices 1-5 done. Last fixes `8f18d76`, `911029b` (Windows green run 42557473060), `5e7f2f2` (run 42559289386 not checked). Open: journey D (M8 grounding) |
| M7 | Not started: turn v2 on; delete the old UI, the switch and its tests; update docs |
| M8 | Planned 2026-11-06: agent side kit-first (skills, guide, tools, styles). See the plan |

## Next, in this order

1. CI: `gh run list --workflow ci.yml --branch track/design-v2`. Rerun a lone ACP "can't start" timeout once.
2. **Done in M6 slice 3 (`d927301`), for reference:** `SystemMode.tsx` replaces the System view; pure helpers in `system-mode.ts`.
    - Rail: search (`⌘K`), Foundations with counts, Components by category with usage and `new`/`draft` tags. Bar: theme menu, Light/Dark, crumbs.
    - Colors: role cards (Fill and Container × Default, Hover, Active; a state the kit lacks is `derived`), palettes worked out from each role, then `SystemPanel` rows (`bare`, `filter`).
    - Brand colour: picker with hex and kit palette, `Review` shows `designReach` over `BRAND_TOKENS` (shared, tested against `brandEdits`), `Apply`, toast `Changes applied · … Undo ⌘Z`.
    - Component page: `Variants | Playground | Usage N`. The sample's `states` request inlines ui.css with `:hover`/`:focus` also matching `[data-cq-hover]`/`[data-cq-focus]`. Panel: Canvas shows, add/remove variant (Copy from), add/remove prop.
    - ⌘Z/⇧⌘Z in System view walk `designSystemHistory`. The step toast now also shows in System view.
    - Samples (user feedback 2026-11-06): controls (`isStatefulPart`: a control, or a ≤6-element wrapper of one field) get a borderless state table; everything else a docs-style gallery, one centered bordered box per variant, overlays open in place.
    - Canvas lost its CSS sometimes: system files now write whole (temp + rename), and a failed stylesheet reload keeps the old sheet and retries (`355592c`). Not reproduced on demand; a stress run stayed styled.
    - Fixed: `copyVariantRules` only read top-level rules, so Add variant failed on all 6 kits (they use `@layer` and nesting). It now walks nested blocks.
3. **M8, the agent side rebuilt kit-first** (user, 2026-11-06; full spec in the plan's `## M8` section). The 7 skills, `DESIGN-MODE.md`, the style index in `design_set_direction` and `design_lint` all predate kits. M8 replaces them with one lean guide, 4 skills (`design-build`, `design-variants`, `design-kit`, `design-review`), grounded tools and no flat styles, with a before-and-after bench. **User decided 2026-11-06:** the 4 skills, retire the 32 flat styles (good ones become Foundation themes), order M6 → M7 → M8.
4. **Recording gaps: all built.** Actions (`b2a1062`, `m6-actions.mjs`), Customize (`acf7c8b`, `m6-customize.mjs`), and the agent turn (`5eeba59`): the Composer lip becomes a plan card while a turn with a plan runs (`PlanLip`, render-tested only, **not seen live yet**), and a v2 design turn ends with `DesignTurnCard` (`Built from MUI · N reused · M new`, part chips, version card with thumbnail that shows that version on the canvas). The kit manifest isn't versioned, so there's no `StatCard extended` line.
5. **M6 slice 4: done (`d73f57a`).** `+` has `Start a new kit…` and `Match a screenshot…` (file picker → ref chip + `Match a screenshot` chip) in v2 design threads. The Composer renders `designChip` (also set by the style picker and System mode's `+ New component`). System mode publishes `designSystemWhere` `{page, theme}`: chips `Library · Colors · MUI · Dark`, each removable (`Library` gone = about the page). On send, `designIntent()` (`design/intent.ts`, tested) goes through `designSetIntent` before the message. Live: 24/24 in dark and light (scratch `m6-intent.mjs`, not saved to kit-tools).
    - Not built: a separate "New design system chat" thread (multi-thread is unapproved). System mode uses the same thread; only the empty drawer says "New design system chat" (render not seen live: the test thread had messages). `Connect my components…` stays out (later).
6. **M6 slice 5, in progress:** journeys D, F, G, H, I live. Allowed without asking (2026-11-06): Codex, Claude Sonnet, and OpenCode on PGS Grove.
    - H (Flow → Grid, Columns, undo) is covered by `m5-scenario.mjs`; G steps 1-3 (brand colour, reach, Apply, toast) were checked live in slice 3. D, F, G4 and I need agent turns.
    - **User decided 2026-11-06:** write the `design-kit` skill now (pulled forward from M8; done, `7b68985`), then run D, F, G4, I. M8 later reshapes it with the other 3 skills.
    - Journey threads (scratch profile `645c0ed4…/scratchpad/ud`, Mac only): `J-D new kit` (no kit), `J-F match` (Foundation + page), `J-G system` (shadcn/ui + page), `J-I component` (Mantine + page). Driver: `journey.mjs <D|F|G|I> <threadId> <outPrefix>` with `MODEL=…`; reference image `screen.png` (dark, indigo). Both are in the zip under `scratch/`.
    - D (PGS Grove): saved a kit but kept "My kit", added no parts, used own classes (14 `data-ui` of 281 classes). **Not a pass** (M8 grounding gap).
    - **2026-11-09, PGS Grove, fresh Mac profile `ccb15691…/scratchpad/ud`:**
      - F (251 s): flow works (ref chip, intent, turn card). Not a pass: DeepSeek can't see images ("no image returned to me"); 1 kit part used (`badge`), 114 own classes; dark overrides sit in `@layer page` in `page.css`, which loses to unlayered `tokens.css`, so the "locked dark" page renders light. Needs a vision model (Codex/Sonnet) and M8 guidance on page token overrides.
      - G4 (38 s): **pass**. One scoped rule in `kit/ui.css` (default variant pill + semibold), pages untouched, no save. Literal `999px`/`14px` despite the skill's no-literal rule. Found and fixed: System mode samples rendered the saved kit's CSS, not the `kit/` draft, so the change was invisible (`8f18d76`, tested, checked live).
      - I (564 s): **not a pass**. Ignored the new-component path: rewrote `index.html` as a pricing page from Card/Badge/Button, added no part to `kit/`, left `seg-test.html` (its `rm` was blocked). The kit move to `mantine-custom` was the user's own click on Remove prop.
      - Codex: F **pass** (181 s: read the image, one `design_tokens_apply` of 27 tokens, 25 kit parts kept, lint fixed); I **pass** (260 s: valid `pricing-card` in `kit/`, no save). Small: Appearance shows Light on a dark-token page.
      - Sonnet high: F and I **pass** after `5e7f2f2` (F 48 s: `design_tokens_apply` + screenshot; I 199 s: `run_code` ×6, `design_kit_inspect` ×4).
      - **Found:** `z.record` input schemas made the cubiq server's `tools/list` fail for Claude, so Claude had no cubiq tools at all (no `run_code`, `design_*`, todo) since `f2d4873`, while the server showed "connected". Fixed with `z.object({}).catchall(...)` in 3 tools; `test/claude-tool-list.test.ts` lists the real design tools. Never use `z.record` in a harness tool.
      - M8 notes: no tool renders one draft part (both agents left the new card unseen); DeepSeek skips the new-component path and can't see images.
      - Driver fixed (`scratch/journey.mjs` in the session scratchpad, not in the zip yet): `TITLE`/`EFFORT` env, closes both CDP connections. Threads are made by `s-setup.mjs`-style scripts per agent.
    - Next: M7.
7. **The user runs `publish`:** `release-kits.sh pack` again first (`ui.js` changed), then fill `KIT_CATALOG` with release URLs and SHA-256 hashes.

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
- Live model runs: DeepSeek free first. Codex, Claude Sonnet and PGS Grove are allowed; ask before anything else.
- Lower priority: the PR from `m4` to `main`, the first `release-cubiq.yml` run, the native provider's image-to-text-model bug, and GitHub #10.
