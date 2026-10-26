# Handoff: design enhance (2026-10-26, Mac, end of session 4: merged into m4)

Goal (user): design mode should make the **best-looking UI, even on a small model**.
- Input: `design-enhance.md`.
- Plan: `.ai/plans/design-enhance.md` (main checkout). Its decisions:
  - Hide the pickers; Auto only.
  - Ship in phases.
  - Higher token spend is fine if the UI gets nicer.
- Research: `.ai/plans/design-enhance-research.md` (main checkout). **Read it first.**
  - §1–3: Stitch crafted set and m01.
  - §4: m02 Pawpal, m03 Gigly.
  - §5: m05 Nestly and the web set w01–w05.
  - **§6: the running slop-UI tells table** (14 tells, each marked lint / lint (new) / lint? / guide).
  - Raw worker research: `.ai/plans/design-enhance-research/p3*.result.md`.

## Where the work is

Worktree **`../aiharness-wt/design-enhance`**, branch **`track/design-enhance`** (from m4 `f7e32f2`; `node_modules` symlinked).
- Not merged, not pushed.
- It is the only extra worktree; `design-baseline` and `design-icons` are removed.
- Main checkout: leave other-session files alone (`resources/DESIGN-MODE.md`, `road-map-handoff.md`, `docs/testing/`, `v2_design.md`).

### Verified by Claude at `0eab21c`
- `bun run typecheck` clean.
- Full suite: 3705 passed.
- `design:check`: 0 errors (48 old warnings).

### Commits

Session 1:

| Commit | Phase | What |
|---|---|---|
| `5b5204a` | P1 | Layers rail (icons, names, collapse, search, hover-highlight), page thumbnails, `bench/design-live.ts` |
| `32a8f15` | P2 | No style/tier pickers in design threads; read-only style label on the canvas |
| `0807265` | P5a+b | "Brief first" (`brief.md`), per-surface `resources/design-patterns/*.md` → `system/patterns.md` |
| `f87a497` | P5c | 14 slop lint rules |
| `120639a` | — | `bench/stitch/` runner, contact sheets, crafted prompts |

Session 2:

| Commit | Phase | What |
|---|---|---|
| `e74e0e6` | P1 fix | Live check found three Layers bugs: big pages now open collapsed to sections; search dims context rows; search/collapse reset per page; no stale outline after a thread switch |
| `5a40dc0` | lint | 3 rules from Stitch: font stack with no generic fallback, running text in capitals, pseudo-data (`ACTIVE_SYNC`, `0x0000`) |
| `fd2b14e` | bench | Stitch runner: web "Page N" parts count as screens; waits for late desktop screens |
| `d022728` | **P4a** | **Style tokens v2** (below) |
| `79d5921` | P4b | docs-workbench, sports-poster and toybox leave the default cream ground. Guide brief: pick the ground from the concept; one "today" date. Guide is at **1296/1300 tokens: full** |
| `c1d01bf` + `4bca182` | **P4d** | `resources/design-icons/icons.svg`: 152 Lucide icons (ISC), built by `scripts/build-icon-sprite.mjs`, no sparkles/rocket/wand. Copied to `system/icons.svg` by `setDesignDirection`, named in its reply, packaged |
| `9a8d901` | **P5b** | Slop rules: equal metric-card rows, zero-padded index labels ("01 / WORK"), centred running text |
| (this) | — | `bench/stitch/lint-pages.sh` + `lint-script.ts`; this handoff |

**What P4a (style tokens v2) changed:**
- Every light style has a dark pair in `@media (prefers-color-scheme: dark) { :root {…} }`. That is the only block `src/main/design/tokens.ts` (the token editor) reads, so there is no `[data-theme]` copy.
- The 5 dark-native styles say "Dark by design" in their header.
- New roles, both schemes:
  - colour: `surface-3`, `border-strong`, `accent-text`, `on-accent`, `accent-soft`, `success-soft`, `warning-soft`, `danger-soft`;
  - type: `--tracking-display`, `--tracking-heading`, `--tracking-label`, `--text-display-sm` / `--leading-display-sm`, `--numeric-data`.
- Each `tokens.css` header says which role goes where.
- Each style's `DESIGN.md` has measurable `## Components` (heights, radii, fills) and a positive `## Rules` list (it replaced `## Refuses`).
- `test/design-styles-contrast.test.ts` pins 17 contrast pairs per scheme for all 24 styles.
- The one-off generators are not in the repo. The dark palettes are hand-picked; the derived roles were computed with a contrast check.

## User notes from session 2 (also in memory)
- **Stitch output is a reference, not gospel**: record what it got wrong next to what to take (memory `stitch-not-gospel`).
- **Cream / warm-paper ground is a slop tell**: Stitch used it only because the prompts asked. 6 of the 7 light prompts did, as did 9 of our 19 light styles (now 6, all paper/print or period concepts).
- **Use `/oc` for implementation.** Taste content (palettes, guide wording, icon picks, pattern notes) stays with Claude.
- Live Claude/Codex runs need the user's OK (P6).

## Session 3 (2026-10-26): done, verified by Claude (typecheck clean, 3720 tests, design:check 0 errors)

| Commit | Phase | What |
|---|---|---|
| `352de1f` | **P4c** | 6 new styles: terminal, wayfinding, workshop, y2k-chrome, arena (dark by design), newsroom. Fonts (OFL, Fontsource 5.3): Geist/Geist Mono, Overpass/Overpass Mono, Alfa Slab One, Michroma, Chivo, Chakra Petch, Sora, Source Serif 4, Public Sans. None on the overused list; no cream grounds. Single-cut faces are declared `font-weight: 100 900` so headings never get a synthesized bold. Style index ≈ 870 est. tokens, so the test cap moved 800 → 900 |
| `946bd15` | **P5b** | End-of-turn fix round: a design turn that ends (turn-end, not stopped) with NEW contrast/targets findings gets one automatic `designFixRound` send right away (`service.ts` finally → `designFixNote`, `autoFixPrompt`). Works for every agent through `Service.send`; no driver changes. Implemented by `/oc` implementer |
| `f757648` | **P5a** | Before/after and worked examples in design-prototype, design-mobile and design-slides; mobile.md anatomies (log row, date block, ticket stub, tier row, fees, map pins, range filter, slots), ≈ 760 tokens (user OK'd going over 700) |
| `fd210df` | **P5b** | Lint §6 #10: text cut off by a hidden-overflow box, and ink-over-ink text. Skips fixed/sticky bars vs page content, text scrolled out of its scroll box, closed `<details>`, faded or hidden ancestors, icon-font ligatures, ellipsis and line clamps. 0 hits on the 17 baseline pages at 390 and 1440; hits 7 bad Stitch pages |

Specimen check for new styles (not in repo): one fixed test layout rendered with each style's tokens, light + forced dark. It checks palette, type and contrast only, not what a real turn builds.

## Session 4 (2026-10-26): merged into m4, worktree removed. Verified by Claude: typecheck clean, 3717 tests, design:check 0 errors

| Commit | What |
|---|---|
| `f12e936` | **Built-in design systems retired** (clean, dashboard, editorial, mono, playful) because fixed palettes make designs look alike. `resources/design-systems/` and its loader/packaging are gone. The 3 design experts are no longer pinned (they start on Auto). Migration 34 moves old design threads on a built-in, or with no system, to Auto. An unknown id falls back to Auto; there is no fallback palette. Project DESIGN.md, `.agents/design-systems` and the style library are unchanged |
| `1e1df0c` | The design composer's ⚡ (fenced Full access) looked clickable and did nothing. It now opens a read-only Permissions popover. Checked live in dark; light not re-shot (same classes as the mode menu) |
| `5b0a888` | `bench/design-live.ts --prompts 1,3,4,7,9` (comma lists) |

**P6 live round (5 prompts × Claude Sonnet / Codex luna / OpenCode Zen DeepSeek free)**
- Data: `.ai/reports/design-enhance-20261026/p6/` (`*.json` per run, `profile/`, `project/designs/`).
- All 15 pages are sound: no broken layouts, and dark pairs work.
- Claude cost $1.50 for 5 (the baseline cost $1.16 for the same 5).
- DeepSeek took 6–11 min per page; #1 hit the time limit. Its only page with lint findings was #9 (29 slop).
- The fix round fired 0 times: no run ended with contrast or target findings.
- **Main finding: the same brief gets the same style, which means the same layout.**
  - Every prompt got the same style from at least 2 of 3 agents.
  - None of the 6 new styles was picked.
  - Claude and DeepSeek #1 and #7 are near-identical pages.
- Taste leftovers:
  - stray "today" dates on login, dashboard and game-menu headers;
  - a highlighter band behind a headline word;
  - a sharp organic blob behind deck illustrations;
  - Claude's desktop pages render small;
  - a deck style (data-report) used for a web dashboard.
- Not done in P6: a written report file. Codex skill loading: `SKILL.md` appears in 8 Codex events, but each read wasn't confirmed. The original plan's full 10-prompt Claude/Codex round was cut to 5 at the user's choice.

## Next (plan in a new session)
1. **Style variety**: draft plan in `.ai/plans/design-style-variety.md`, not yet approved.
   - The agent shortlists 3 styles and CubiQ picks one (seeded by thread id, skipping recent styles).
   - A platform filter.
   - Taste fixes: date-rule wording, desktop scale, highlighter and hard-blob lint rules.
   - Then a DeepSeek-only re-run.
2. Write the P6 report into `.ai/reports/design-enhance-20261026/`.
3. **Push m4 and watch Windows CI** (memory `two-machines`). m4 is merged locally only, not pushed.
4. Housekeeping: rotate the Stitch API key (`.env` `STITCH_API_KEY`).

## How to check things
- **Live UI**: copy `.ai/reports/design-enhance-20261026/baseline/profile` to a scratch dir.
  - Launch: `XDG_CONFIG_HOME=<dir>/xdg-config bun run dev --remoteDebuggingPort 9491 -- --user-data-dir=<dir>` from the worktree.
  - Drive it with `agent-browser --cdp 9491`. The design iframe is its own CDP target: `tab t2` back to `localhost:5173` before each screenshot.
  - Theme: `document.documentElement.dataset.theme="dark"`.
  - Its 18 design threads open with no model call; `codex-luna 4` is the big dashboard.
- **Lint rule noise check**: `bench/stitch/lint-pages.sh <width> '<detail regex>' <pages…>`.
  - It must hit the bad Stitch pages (`stitch/library/*/`).
  - It must stay quiet on the 17 baseline pages (`baseline/project/designs/*/index.html`), except true tells. Today the only one is Northstar's 4 KPI cards.
- **Stitch**: all 9 library files are done and reviewed; the sheets are in `stitch/sheet-*.png`. The runner is idle. Re-running it only lists and downloads (state is per file).

## Working rules learned
- **`/oc` on this Mac**: `opencode run --agent orchestrator -m opencode/deepseek-v4.1-flash-free "$(cat brief)" --format json --print-logs --log-level INFO < /dev/null > out.jsonl 2> log`, wrapped in `perl -e 'alarm shift; exec @ARGV' 1500`, run from the worktree, in the background, with no Monitor.
  - Briefs go in `<worktree>/.ai/tmp`. Start each with "Dispatch this immediately with your `task` tool to the `implementer` subagent; don't look for oc-run.mjs, don't read outside the repo, don't run git".
  - Workers run **no shell commands**; Claude runs typecheck/tests and reads the diff.
  - Keep each brief to ≤ 5 files. Parallel briefs go in separate worktrees, started 20 s apart.
  - Session 2: both implementer runs did exactly what the brief said, when it gave exact code. One threshold mistake was in the brief itself (28px → 24px), found by the real-page check.
- `collectSlop` / `slopFindings` / `collectSlopPage` are serialized with `toString()`: there are no module-level references inside them.
- The Read/Edit tools can't reach the worktree (outside cwd): edit there with scripted patches via Bash.
- An external `<use href="file.svg#id">` is unreliable (file://, exports). Pages copy the symbols they use inline. Stroke attributes must sit on each `<symbol>`.
