# Handoff: design enhance (2026-10-26, Mac)

Goal (user): design mode should make the **best-looking UI, even on a small model**.
- Input: `design-enhance.md`.
- Plan: `.ai/plans/design-enhance.md`. Its decisions:
  - Hide the pickers; Auto only.
  - Ship in phases.
  - Higher token spend is fine if the UI gets nicer.
- Research and taste notes: `.ai/plans/design-enhance-research.md`. Read it first; it holds every finding so far. Raw worker research: `.ai/plans/design-enhance-research/p3*.result.md` (a = styles, c = component/page/screen rules, d = workspace/deck rules, e = 30 template tells).

## Where the work is

Worktree **`../aiharness-wt/design-enhance`**, branch **`track/design-enhance`** (from m4 `f7e32f2`; `node_modules` symlinked).
- Not merged, not pushed.
- `../aiharness-wt/design-baseline` (detached at `f7e32f2`) only ran the baseline app. Remove it when done.
- Main checkout: other-session files are untouched (`resources/DESIGN-MODE.md`, `road-map-handoff.md`, `docs/testing/`, `v2_design.md`).
  - `.env` gained `STITCH_API_KEY` (gitignored).
  - `bun install` added the missing `docx`/`exceljs`/`pptxgenjs` there; m4's full suite now passes.

Commits on the branch:

| Commit | Phase | What |
|---|---|---|
| `5b5204a` | P1 | Layers rail: icons per kind, readable names (`layers.ts`), collapse, search, hover-to-highlight (bridge `hover-layer`), svg as one layer, aria/alt labels. Pages rail: thumbnails (`design:thumb` IPC, cached by mtime). `bench/design-live.ts`. |
| `32a8f15` | P2 | No style or tier pickers in design threads (`DesignFenceChip`); read-only `Style · X` label on the canvas head. `TierMenu.tsx` and the picker components/CSS removed. `design_set_direction` says a look the user names wins. |
| `0807265` | P5a+b | `DESIGN-MODE.md` "Brief first": the agent writes `{dir}/brief.md` (platform, direction, tokens, screens with anatomies, real content, states, avoid) before the first page. Guide cap 900 → 1300 tokens. `resources/design-patterns/<surface>.md` (6 files, ≤ 700 tokens each) copied to `system/patterns.md` by `setDesignDirection`; packaged via `electron-builder.yml`. |
| `f87a497` | P5c | 14 more slop lint rules. Verified in real Chrome on Stitch and baseline pages; no noise on baseline pages after two fixes (default `transition: all` 0s, radius ≤ 2px exempt). |
| `120639a` | — | `bench/stitch/` runner, contact sheets, crafted prompts (README there). |

Verified by Claude:
- `bun run typecheck` clean.
- Full suite 3642 passed.
- `design:check` 0 errors.

**Not yet verified live (no model calls needed)**: P1/P2 in the real app, dark and light themes:
- Layers rail on the 254-element dashboard;
- page thumbnails;
- the composer without chips;
- the canvas style label.

How: copy `.ai/reports/design-enhance-20261026/baseline/profile` to a scratch dir and launch the worktree app on it (`bench/lib/app.ts` `launchApp`, port 9491). Its design threads open with no model call.

## Baseline (P6 "before")

Data: `.ai/reports/design-enhance-20261026/baseline/`. One JSON per run, `project/designs/*`, and `profile/`. Short prompts, m4 `f7e32f2`.
- **Claude Sonnet**: 10/10 runs. 10 distinct styles. About $0.14–0.29 a turn. Lint at the end was clean.
- **Codex GPT-6-Luna**: 7 done. #8 stalled ("no activity from Codex for 10 minutes"). #9–10 not run.
- **User: no more live Claude/Codex runs without asking** (limits). The final P6 round needs their OK, and maybe a small model.

## Stitch (taste source)

Setup and running:
- Stitch MCP is added at **user scope** (`~/.claude.json`, header key). It loads in a new session.
- The key is in `.env` as `STITCH_API_KEY`. Remind the user to rotate it after testing.
- The library runner runs **detached** (`nohup`) on the user's 9 prompt files (`~/Documents/ai-agent/traning-data/`, 4 mobile + 5 web, each a full prompt + 4-step Stitch workflow).
  - Log: `.ai/reports/design-enhance-20261026/stitch-library.log`.
  - Output: `.ai/reports/design-enhance-20261026/stitch/library/<id>/` (PNG + HTML + state.json).
  - Done: m01, m02. m03 was in progress at handoff; then m05, w01–w05.
- If it died, resume (state is per file):

  ```
  set -a; source .env; set +a; node ../aiharness-wt/design-enhance/bench/stitch/flow.mjs .ai/reports/design-enhance-20261026/stitch/library $(ls ~/Documents/ai-agent/traning-data/*.md | grep -v README)
  ```

  Check `ps aux | grep flow.mjs` first; never run two.
- The earlier crafted set (`stitch/crafted*`) has 7 screens: Margin landing, Relay pricing, Northwind dashboard, Atlas kanban, Bloom sign-in, Thread chat.
  - The docs, habit, menu and finance screens were lost to timeouts. Regenerate later only if useful.
- **The user wants each Stitch batch reviewed and extracted before moving on.** Make a contact sheet (`bench/stitch/sheet.py`), view it, and append the lessons to the research doc. m02 and later are not reviewed yet.

## Next, in order

1. **Live UI check of P1/P2** (above). Fix what looks off (memory `ui-visual-bar`). Commit.
2. **Review the Stitch library output** as it lands (m02 onward) and append to the research doc.
3. **P4, style tokens v2** (research doc §1–3):
   - **`tokens.css`** (24 styles, hand-written, all the same 65-line template; no generator):
     - add a surface ladder (`--color-surface-lowest/low/high/highest`, `--color-outline-variant`, `--color-on-accent`);
     - add role-based type tokens with tracking (display −0.02 to −0.03em, label +0.04em) and mobile display sizes;
     - add density-aware spacing/radius notes and a mono/`tnum` data role;
     - add a real **dark pair** under `@media (prefers-color-scheme: dark)` + `[data-theme="dark"]`.
   - **Each `DESIGN.md`**:
     - a `## Components` block with measurable specs (button/input heights and radii, card border vs tint);
     - a positive `## Rules` list (lead with the alternative; negatives prime).
   - **Script check**: text, muted and on-primary contrast ≥ 4.5 in both schemes.
   - **New styles from p3a** (in the research doc's sources; contrast re-verified). Before adding them:
     - drop fonts on the lint's overused list (Fraunces, Newsreader, IBM Plex, Instrument Sans, Cormorant …), or exempt the style's own fonts in the lint;
     - light accents below 4.5:1 (wayfinding 2.9, y2k-glass 4.1, shell 4.6) are for non-text only;
     - fonts are OFL woff2 into `resources/design-fonts` + `LICENSES.md`.
   - **Offline icon sprite** (Lucide, ISC) into `system/icons.svg`.
   - **Watch the style index cost** in `design_set_direction`: about 690 tokens today.
4. **Skills**: worked examples and before/after in `design-prototype`, `design-mobile` and `design-slides`, from the Stitch anatomies.
5. **P6**: ask the user before any live round.
   - Score: distinct styles, end-of-turn lint, a taste review of screenshots, tokens and cost.
   - `bench/design-live.ts --agents … --prompts …` resumes and skips finished runs.
6. Merge into m4 (ask first). Push and watch Windows CI (memory `two-machines`).

## Working rules learned this session

- `/oc` delegation: opencode `orchestrator` + `-m opencode/deepseek-v4.1-flash-free`, briefs in `<worktree>/.ai/tmp`, background, no Monitor.
  - Workers run no shell commands; Claude verifies.
  - `researcher` has 20 steps: split big research into several briefs.
  - Taste content (pattern notes, guide text) is written by Claude; wiring and tests go to `implementer`.
- Stitch: strict rate limit, one call at a time, no generation retries; it builds screens asynchronously.
- The Read/Edit tools can't reach the worktree (outside cwd): edit there with scripted patches via Bash.
- `HANDOFF.md` (main) is stale: session 11's bench fixes **are** merged into m4 and pushed.
