# Handoff: design enhance (2026-10-26, Mac, end of session 2)

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

## Next, in order (6 left)
1. **P4c, new styles** from p3a (research doc sources):
   - OFL fonts into `resources/design-fonts` + `LICENSES.md`;
   - drop fonts on the lint's overused list, or exempt a style's own fonts;
   - accents under 4.5:1 are non-text only (`accent-text` handles text);
   - avoid cream grounds unless the concept is paper/print;
   - every new style needs v2 tokens, a dark pair (or "Dark by design"), Components and Rules, and must pass `test/design-styles-contrast.test.ts`;
   - watch the style index cost in `design_set_direction` (about 690 tokens).
2. **P5a, skills**: worked examples and before/after in `design-prototype`, `design-mobile` and `design-slides`. Add mobile anatomies to `resources/design-patterns/mobile.md` (≤ 700 tokens): time-first log row, date block, ticket stub, sold-out tier, fee breakdown, map price pins, filter histogram, schedule slots. All are in research §4–5.
3. **P5b remainder**:
   - **End-of-turn fix round**: when contrast or targets findings remain at the end of a turn, re-run the lint once and ask for one fix round. Today `src/main/design/autolint.ts` only notes findings for the *next* turn (`service.ts` ~1439). Needs research of the Stop path per agent (Claude Stop hook / Codex / OpenCode) before a brief.
   - Lint candidate from §6 #10: text clipped by its box, or overlapping text.
4. **P6**: **ask the user before any live round** (maybe a small model).
   - Same 10 prompts, `bench/design-live.ts --agents … --prompts …` (resumes).
   - Baseline data: `.ai/reports/design-enhance-20261026/baseline/`.
   - Score: distinct styles, end-of-turn lint, taste review of screenshots (dark + light), tokens, cost.
5. **Merge** into m4 (**ask first**), push, watch Windows CI (memory `two-machines`).
6. Housekeeping: remind the user to **rotate the Stitch API key** (`.env` `STITCH_API_KEY`).

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
