# Handoff: design live variants + style variety (2026-10-28, Mac, session 5 end: P4 done; P3 and the merge into m4 next)

## Session 5 status (read this first)
- **P4 done**, three commits on `track/design-live`:
  - `09b617d` P4a: the 4 slop check groups, ids, `Lint allows:` exemptions. repeated-label now needs a container that is an `li`/`article` or a card ≤ 600×600 outside `table`/`nav`, two different tags, and treats `9:41` as a number. Gate: no check on > 30% of the 32 good pages (top: repeating-stripes 18%); repeated-label 34% → 0, still fires on a real card.
  - `d752abf` P4b: prototype skill floor (icon sprite, no glyph icons, themed `::selection`/caret/scrollbars/focus, `tabular-nums`, mono only for code and data), 1467 → 1471 words.
  - `a9d830c` P4c: **Detect** (eye) in `LiveBar`. IPC `design:detect` lints the saved page as the auto-lint does (contrast, targets, slop; `withoutAllowed`), `detectPins` groups per element (≤ 40 pins, ≤ 3 details, body/html apart). Bridge `set-findings` draws amber numbered squares (top-right, clickable, `data-cubiq-finding`); a click selects the element and posts `finding`; the canvas fills the prompt with `Fix: …` and sets Polish. A page reload re-runs it quietly; leaving the page ends it.
- **User report fixed in P4c:** no way to dismiss a selection. The element bar (and the insert bar) now has a ×; Esc clears a selection with no tool on, in the app (`escClears`: not in a text field, dialog or menu) and in the frame.
- **Bug found live and fixed in P4c (from P2b):** DeepSeek named a set `hero-em` and wrapped with `span` inside an `h1`. All four parsers (bridge, `variants.ts` ×2, `frame.ts`) now take inner hyphens (≤ 24 chars), the resolver takes `span` wrappers, and `cut` keeps the text's own spaces inline. The skill says "letters and digits" and "a `span` inside text or a heading".
- **Live (DeepSeek v4.1 flash free, Stillnote page `4a392b27`, dark):** Detect → 2 pins; pin 2 → Polish Go → a `hero-em` set in 46 s; pins re-ran (the band pin left); cycler 1/3; Accept kept the span with `cq-hero-em`, a version saved. The 3 variants were only slightly different (a tiny inline target). Claude and Codex were not run.
- Checks: typecheck clean, `design:check` 0 errors (48 old warnings), full suite green except `test/opencode-ask.test.ts` (9–10 fail, same on a clean HEAD: the user updated to OpenCode v2).
- **Next:** P3 (style variety) in `../aiharness-wt/design-variety`; fix `opencode-ask` for OpenCode v2 (separate); then merge `track/design-live` into `m4` and run the Windows CI job.
- Nits, not fixed: the cycler sits low when the set is inline (no variant rect for `display:contents` spans); the crushed-tracking detail joins `<br>` text ("thoughta place").
- Live setup this session: port 9477, profile `ud` in session `6407e2d8`'s scratchpad; a thread's design folder is `ud/chats/<thread>/designs/<first 8 of thread id>/`; `fr.mjs` there evaluates in the frame over CDP. agent-browser jumps between the app and frame tabs: pick the "CubiQ - http" tab before each call.

## Session 4 status (read this first)
- **P4 is half done, all uncommitted** in `../aiharness-wt/design-live` (`track/design-live`). Nothing from P4 is committed yet.
- **Done (Claude-verified: `tsc -p tsconfig.node.json` clean; lint, autolint and slop tests pass):**
  - `LintFinding.id` (optional). Every existing slop check now has an id (`eyebrow`, `hard-offset-shadow`, `side-stripe`, … 29 ids). `push(id, selector, detail)` in `slopFindings`; 11 test literals updated.
  - 4 new check groups, one file each, each a self-contained page collector plus a pure check (serialized via `toString`):
    - `slop-layout.ts`: nested-cards, icon-tile-stack, heading-rhythm, monotonous-spacing, edge-flush-cards, text-at-viewport-edge, cramped-padding, jagged-mask, image-overlay, broken-image;
    - `slop-type.ts`: italic-serif-display, hero-chip, oversized-headline, crushed-tracking, flat-hierarchy, justified-text, tight-body-leading, tiny-text, wide-tracked-body, skipped-heading, stub-line;
    - `slop-surface.ts`: ghost-card, radial-halo, ai-palette, gray-on-color, repeating-stripes, grid-background, glow-border, pulsing-dot, blinking-cursor, marquee, hidden-at-rest, em-dash-overuse, repeated-label, not-x-y, theater, highlighter;
    - `slop-system.ts` (Claude): token-font, token-size, token-radius vs the `:root` `--font-*`/`--text-*`/`--radius-*` tokens.
    - Layout, type and surface were written by 3 parallel DeepSeek implementers (briefs in `.ai/tmp/p4/`), then read and fixed by Claude. Tests: `test/design-slop-{layout,type,surface,system}.test.ts`, each with a self-containment test (`new Function(toString)`).
  - `lint.ts`: `SLOP_GROUPS` → `designLint` `h.groups`, a failing group is reported as `skipped slop <name>`.
  - **Style exemptions:** `parseAllows` / `styleAllows(root)` / `withoutAllowed` in `autolint.ts`, read from `<design>/system/DESIGN.md` `## Rules` (`- Lint allows: a, b`). Applied in the `design_lint` tool (`tools.ts`) and the auto-lint (`index.ts`). 9 styles got a `Lint allows:` line: atelier, museum-label, field-guide (italic-serif-display), arcade-cabinet (blinking-cursor), chalk-keynote (highlighter), neo-brutal (hard-offset-shadow, highlighter), memphis-pop (hard-offset-shadow), paper-planner (highlighter, grid-background, repeating-stripes), ledger-paper (repeating-stripes).
  - `bench/stitch/lint-pages.sh` prints the check id and matches the pattern against it.
- **Real-DOM check:** the fixture page `p4/bad.html` (in this session's scratchpad `865fb0db…/scratchpad/p4/`) trips every new check except pulsing-dot (the fixture's dot was an inline span, 0×0) and em-dash-overuse (the fixture's other prose dilutes it).
- **Noise gate (first run, before the tweaks below):** 32 good pages (baseline + P6 designs), 5 Stitch pages; per-check table in the scratchpad (`good.txt`, `stitch.txt`). Only **repeated-label fired on > 30% of good pages (34%)**. Next highest: stub-line 21%, repeating-stripes 18%, oversized-headline 15%, highlighter 15%; most of these were our own styles or slide decks.
- **Tweaks after the gate:**
  - oversized-headline: fires only above max(96px, the system's `--text-display`), and skips `.slide`;
  - stub-line: headings only, lines grouped by vertical overlap, "alone" = the word spans the whole last line;
  - jagged-mask: only `url(` masks (a gradient mask is a fade);
  - broken-image: `currentSrc`/`srcset` count as a source.
- **Next, in order:**
  1. **repeated-label** (still noisy): it treats whole panels, tables, nav bars and phone mockups as one card. Plan: container = nearest `li`/`article` or a card ≤ 600×600, not inside `table`/`nav`; require the two leaves to have different tags; treat `9:41`-style times as numbers.
  2. Re-run the gate: `AGENT_BROWSER_SESSION=p4gate zsh bench/stitch/lint-pages.sh 1440 . <pages>`, on `.ai/reports/design-enhance-20261026/{baseline,p6}/project/designs/*/index.html` and `stitch/crafted-all/*.html`. Then `bun run typecheck`, the full suite, `bun run design:check` (the styles' DESIGN.md files changed). Then commit P4a (lint + exemptions) on its own.
  3. **Skill floor** in `design-prototype/SKILL.md`, token-neutral (1467 words now). Already covered: mode → ambition, light/dark from use, one motion moment. To add: theme the browser surfaces (`::selection`, `caret-color`, scrollbars, focus ring, `tabular-nums`); monospace only for code and data; icons from the shipped sprite (`icons.svg`, `service.ts:1586`), never glyphs.
  4. **Detect (eye)** in `LiveBar`. Plan: an IPC lints the open page through `shooter.evaluate` (as `design_lint` does) with `withoutAllowed`. The renderer sends the findings to the bridge as clickable pins; the current comment pins (`bridge.ts` `setPins`, ~line 670) are `pointer-events:none`, so Detect needs its own message. A click picks the element, and the ElementBar opens with the finding as the prompt and Polish as the action. Cite `DESIGN.md` §1/§5/§6/§7/§9 in any UI brief.
- Claude and Codex were not run.

## Session 3 status (read this first)
- **P2c done** (`81f8b13` on `track/design-live`, not merged into `m4` yet).
  - LiveBar `+` (Insert) sits beside Pick, and the two take turns. Esc clears the gap first, then stops Insert (in the frame and in the app).
  - Bridge insert mode: a hover line at the nearest gap, a click picks it, and the picked line follows scroll. Messages up: `gap`, `gap-rect`, `insert-cancel`. Down: `insert`, `clear-gap`.
  - Two pure helpers are serialized into the bridge, both tested:
    - `gapChoice`: the outermost level whose edge is within 10px, else the innermost level with siblings, by halves;
    - `childGap`: the pointer is in the space between a container's children, so take the nearest child within 40px.
  - Insert bar = `ElementBar insert`: the tag, "What goes here?", dictation and Go, with no action chip.
  - `insertMessage` writes its own anchor line instead of `withScope`, whose "change only this element" contradicts an insert. The skill `design-variants` has an Insert bullet; there's no action note.
  - `variants.ts` resolve:
    - a dropped block's comment goes with it;
    - a copied `[data-cubiq-variant]` rule is removed;
    - blank runs close up;
    - `cut` drops one doubled blank line, so × on a spaced-out insert is byte-identical.
- **Live (DeepSeek v4.1 flash free, Option A Harbor page, dark):**
  - After the balance card, "savings goals": a well-formed `goals` set in about 60 s, 3 different variants (strip, filled lead, big number). × gave the original file byte for byte (after the `cut` fix).
  - Between Accounts and Spending in the side column, "next 2 payments": a `pay` set in 65 s. Accept of variant 2 left a clean `<style>` (its own comment and rules) and no `data-cubiq-variant` anywhere.
  - Checked live: scroll-follow, the Esc order, and Pick↔Insert exclusivity. Claude and Codex were not run.
- Checks: typecheck, `design:check` (0 errors, 48 old doc warnings), full suite 3773 passed.
- **Next: P4** (rules + Detect). P3 can run in parallel in `../aiharness-wt/design-variety` (not created yet). Later: merge `track/design-live` into `m4`, and run the Windows CI job.
- Known nits, not fixed:
  - The insert bar covers the content just under the gap (as the element bar does).
  - The Layers rail's hover box shows wherever the real mouse pointer rests.
  - Agent pages may throw their own script errors (Harbor: `s_load is not defined`); these are unrelated.
- Live setup is the same as session 2 (port 9477, the profile in session `4a4dda1d`'s scratchpad `ud`). The bench page backup is `before.html` in session `a83c3aaa`'s scratchpad.

## Session 2 status (read this first)
- **Work happens in the worktree** `../aiharness-wt/design-live`, branch `track/design-live` (not merged into `m4` yet). The plan is approved: continue without asking (memory `autonomy-no-prompts`).
- **P1 done** (`922f5b5`): `LiveBar.tsx` is the one bottom bar in both layouts: Pick `V`, DESIGN.md (opens the Inspector's System tab), Steer (an inline page-level message), Compare, Present. The header Select, the rail tools and the Inspector's auto-pick are gone. The stage, Compare and the board keep `--live-bar-room` clear.
- **P2a done** (`9e30964`): `ElementBar.tsx` holds the tag, prompt, 4×3 actions ×3, a dictation hint, Go, Edit text, Comment (Real app tier), Clear N, a repick confirm and the "Generating variants…" pill.
  - Bridge messages up: `anchor`, `marks`, `repick-ask`. Down: `clear-marks`, `repick`, `edit-selected`.
  - Marks are SVG plus note inputs in a page-coordinate layer (`[data-cubiq-marks]`), so they stay on their content through scroll (checked live).
  - `DrawOverlay` is deleted.
- **P2b done** (`a34d4ae`):
  - `src/main/design/variants.ts`: `listVariantSets` and `resolveVariantSet`, pure text work with no parser.
    - Accept keeps one wrapper's element, adds a `cq-<set>` class, and rewrites `@scope ([data-cubiq-variant="S-n"])` to `@scope (.cq-<set>)`, with `:scope > C` becoming `:scope:is(C)` and `:scope C` becoming `:is(:scope:is(C), :scope C)`. Shared keyframes stay.
    - × keeps the original and drops every rule.
  - `service.resolveDesignVariants` takes a version before and after the write (`recordDesignPage`), so Restore undoes it. IPC is `design:variant-resolve`; the action paragraph comes from `design:action-note`.
  - Bridge: `findVariants` runs on ready and injects `[data-cubiq-variant]:not([hidden]){display:contents}`. It posts `variants` and `variant-rect`; `show-variant` switches the shown one.
  - Canvas: `VariantCycler` (`‹ n / 3 ›`, ×, Accept, ←/→). When sets arrive the selection is cleared, without a notice.
  - Skill `resources/skills/design-variants/SKILL.md` (339 words) plus 11 notes in `resources/design-actions/` (Freeform has none), packaged via `electron-builder.yml`.
  - Lint `collectSlop` skips `[data-cubiq-variant][hidden]`.
  - Canvas-first `.main` is now z 25 (it was 3), so the drawer and prompt bar sit over the canvas bars and under Present (z 30). The prompt pane's left pad no longer reserves room for the old rail.
- **Live results (DeepSeek v4.1 flash free, Zen):**
  - Go on the Harbor h1 with Bolder: one Edit in 41 s, no screenshot loop.
  - It returned 3 real, different variants on 3 axes: 48px tighter, a cyan filled block, 64px full row.
  - The cycler and keys work. Accept and × made no agent turn (the event count was unchanged).
  - Accept → Restore v1 brought the set and the cycler back. × gave a file byte-identical to the original.
  - Claude and Codex were not run (ask first).
- **Choices made** (they differ a little from the plan; revisit if wanted):
  - Multi-select: Go scopes the selection itself, and the skill says "wrap their nearest shared parent".
  - Go captures the element plus marks only when strokes exist (notes go as text).
  - The last action is remembered per thread in memory only.
  - Resolve doesn't run the fence or lint: the agent's write already passed the fence, and autolint runs at turn end.
  - The action paragraph shows in the user's chat bubble (sent as text, not hidden).
- **User decision 2026-10-27: no `NOTICE` file.** Copy Impeccable's ideas and write our own text; never paste its code or text.
- **Next: P2c (Insert `+`)**, then P4; P3 can run in parallel in `../aiharness-wt/design-variety`. Later: merge `track/design-live` into `m4`, and run the Windows CI job.
- Known nits, not fixed:
  - After a reload the bridge's hover target is stale until the mouse moves.
  - The hover box doesn't follow page scroll (unchanged code).
  - A click inside the picked element drops a note instead of picking a child (by design). Use the crumbs or Layers to pick a child.
- **Live setup** (session 1's profile is gone):
  - Port **9477** (another session used 9466). Launch from the worktree with `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud`.
  - Main-process or bridge changes need an app restart (`kill -TERM` the 9477 pid): no hot reload there.
  - Make a design thread with `openChats()` + `createThread(chatsId, "opencode", {kind:"design"})`, then copy a bench page into `ud/chats/<threadId>/designs/<id8>/` (`8b15e090` Harbor as `index.html`, `daf71ebc` as `variant-a.html`).
  - Tier changes through the API need a window reload.
  - In-frame checks: a small CDP script that evaluates on the `type: iframe` target from `curl :9477/json`.
  - **Set the thread to `opencode/deepseek-v4.1-flash-free` before any live run.** A fresh profile's OpenCode default fails at once (AgentRouter "probation").
  - On 2026-10-27 at 10:35, two More styles turns were started from the app window (not by the scripts). Both failed at once, cost nothing, and wrote nothing.

## Session 1 status
- **The plan is approved, and the user said to start it.** Continue P1 without asking (memory `autonomy-no-prompts`).
- **P0 done: every defect seen live.** Details are in the hub `.ai/plans/design-style.md` §1.1; shots in `.ai/plans/design-style-refs/p0/`. P0 ran on the dev app at port 9466, Working tier, dark theme, on Claude's #4 dashboard:
  - the header Select and rail Select light up together;
  - Text + a single click only selects, no edit;
  - Comment is disabled in the Working tier;
  - Pen: the wheel doesn't scroll while drawing, and a stroke stays at its screen spot when the page scrolls (it drifts off its content);
  - Inspector turns picking on and leaves it on after it closes.
- **Worktree created:** `../aiharness-wt/design-live`, branch `track/design-live` at `b9a3ee3` (= m4 + this handoff). `node_modules` is symlinked to the main checkout. No code changes yet.
- **Next: P1** (the global bar). Then P2a/b/c; P3 (variety) can start in parallel in `../aiharness-wt/design-variety` (not created yet).
- **Test setup to reuse for live checks:**
  - profile: copy the P6 bench DB with `sqlite3 <old>/scratchpad/profile/unskilled.db ".backup <new>/ud/unskilled.db"`. The old profile is in session `96f832e5`'s scratchpad. Its design threads point at `.ai/reports/design-enhance-20261026/baseline/project`;
  - launch from the worktree: `npx electron-vite dev --remoteDebuggingPort 9466 -- --user-data-dir=<ud>`;
  - theme: `window.unskilled.updateSettings({theme:"dark"})`;
  - open a thread via `ab snapshot -i` → `ab click @eN` in the same call;
  - in-frame state: a small CDP script that evaluates on the `type: iframe` target from `curl :9466/json` (the agent-browser tab for the iframe disappears when the frame reloads);
  - real clicks and drags: `ab mouse move/down/up` on the app tab.
- The user's own dev app (main checkout, no CDP port) was running all session. Don't kill it.

Goal (user): design mode should work like **Impeccable's live mode video**:
1. pick an element;
2. an action palette (Bolder, Quieter, Distill, Polish, …), ×3;
3. drag = mark, click = note;
4. "Generating variants…";
5. three in-place variants `‹ 1/3 ›`, Accept or ×.

Also in scope:
- fix the duplicate and broken canvas tools (the header Select vs the rail Select, Text, Comment, Pen);
- add Impeccable's rules (detector checks, craft floor, the 4 modes);
- ship the style-variety plan.

Design threads only.

## Read first (main checkout, `.ai/` is gitignored: Mac only)
- **Hub: `.ai/plans/design-style.md`**: findings (code-verified, with file:line), decisions, and the file map. Start here.
- Plan: `.ai/plans/design-live-variants.md` (phases P0–P4, tests, success bar). **Approved by the user 2026-10-26.**
- Folded in as P3: `.ai/plans/design-style-variety.md` (the shortlist + seeded pick, the deck/web filter, the taste fixes).
- Refs: `.ai/plans/design-style-refs/`:
  - `impeccable/`: copies from github.com/pbakaus/impeccable @ `63d672f`, Apache-2.0, with `LICENSE` and `SOURCE.md`. Most useful: `reference/live.md` §4 (variant planning), `reference/craft-floor.md`, `slop-rules.md` (67 rules with our status);
  - `video/`: contact sheets from both recordings;
  - `screens/`: the user's duplicate-tools screenshot.
- Originals (repo root, untracked, the user's): `Screen Recording 2026-10-26 at 5.00.32 / 5.01.18 in the afternoon.mov`, `Screenshot 2026-10-26 at 4.25.16 / 5.01.48 in the afternoon.png`.

## Decisions (user-approved defaults)
1. A global bottom bar replaces the vertical tool rail and the header Select. The Text and Pen tools go: double-click edits, an Edit text button sits on the element bar, and marks live inside Pick.
2. Always ×3.
3. Mic = it focuses the field so OS dictation can fill it (macOS Fn Fn, Windows Win+H).
4. Our tokens, Impeccable's layout.
5. Impeccable is a reference, not a dependency: no binary, hooks or PRODUCT.md. Copy the ideas, reinvent the text: our own English, token-sized, never pasted from Impeccable. **No `NOTICE` file** (user, 2026-10-27).
6. **Accept and × are done in the main process with no agent turn** (`designVariantResolve`). A version snapshot first, so Restore undoes them.
7. Only the chosen action's paragraph (`resources/design-actions/<action>.md`) goes to the agent, plus the `design-variants` skill (≈350 tokens).
8. Per-style `allows:` in a style's `DESIGN.md ## Rules` keeps the new lint from fighting our own styles.

## Phases

| Phase | What | State |
|---|---|---|
| P0 | Live repro of the tool defects, dark theme, screenshots | **done** (session 1) |
| P1 | Global bar (Pick `V`, Insert, Detect, DESIGN.md, Steer, Compare, Present); header Select out; Text, Comment and Pen out of the rail; Inspector no longer turns picking on | **done** (`922f5b5`) |
| P2a | Element bar + 4×3 action palette + in-frame marks and notes (page coordinates) + Go message | **done** (`9e30964`) |
| P2b | `data-cubiq-variant="S-n"` sets in place, bridge detection, cycler, Accept/× in the main process, malformed-set recovery | **done** (`a34d4ae`) |
| P2c | Insert (`+`): variants at a gap | **done** (`81f8b13`) |
| P3 | Style variety (its own plan) + optional `mode` on `design_set_direction` | todo, parallel from P1 |
| P4 | ~35 new slop checks, style exemptions, noise gate, skill floor lines, Detect (eye) overlay | todo |

## Where the work goes
- No code yet. Branch **`track/design-live`** off `m4` (`b9a3ee3`), in its own worktree `../aiharness-wt/design-live` (created).
- P3 goes in a second worktree, `../aiharness-wt/design-variety`.
- One git worktree per parallel brief (memory `parallel-worktrees`).
- Main checkout: leave other-session files alone (`resources/DESIGN-MODE.md` one-line diff, the `road-map-handoff.md` deletion, `docs/testing/`, the recordings and screenshots).
- A dev app is already running from the main checkout (`electron-vite dev`, another session or the user). Don't kill it: run our own copy on port 9466 with its own `--user-data-dir`.

## Verify (Claude, every phase)
- `bun run typecheck`, the full suite, `bun run design:check`. Claude reads the diff itself; a worker's "done" doesn't count.
- The real app in the dark theme: screenshots next to the video frames; no iframe remount, stray scrollbars or layout shake.
- Live runs: DeepSeek free (OpenCode Zen) first. **Ask before any Claude or Codex run.**
- Windows: no shell in resolve; paths through `path.join`; a Windows CI job.
- Commit each phase on its own (only that phase's files, ≤150-character message, no trailer). Then clear `.ai/tmp/`.

## Gotchas
- `/oc` on the Mac: no `oc-run.mjs`.
  - Dispatch with `opencode run --agent orchestrator -m opencode/deepseek-v4.1-flash-free`, and tell it to use its `task` tool immediately.
  - Briefs ≤5 files; no shell commands for implementers.
  - Stagger parallel starts by ~20 s.
  - Memory `oc-dispatch-mac`.
- The Design iframe is cross-origin (`cubiq-design://`): evaluate inside it through its own CDP target. With agent-browser attached, the iframe can stay `about:blank` (memory `test-app-for-real`).
- The guide `resources/DESIGN-MODE.md` is at 1296/1300 tokens: swap words, don't add.
