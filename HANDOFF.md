# Handoff (2026-10-31, Mac): CubiQ Design Mode 2.0 Studio Overhaul + Open Tracks

---

## 🚀 Active Track: CubiQ Design Mode 2.0 & Studio UX Overhaul (2026-10-31)

### 1. Context & User Review Findings
The user provided 4 screen recordings and 2 screenshots defining the gold standard for CubiQ Design Mode (inspired by the Varelyo / Studio / Cycles app interaction paradigm):
- **[`Screen Recording 2026-10-31 at 11.53.54 in the morning.mov`](./Screen%20Recording%202026-10-31%20at%2011.53.54%20in%20the%20morning.mov):** Complete studio workflow demonstrated on a real app screen (`Cycles 24`):
  - Canvas element selection: Blue bounding box + solid blue header badge with swap diamond (`Button ⟐`).
  - Multi-selection: Shift-clicking 4 StatCards displays `4 selected` with checklist in inspector; context menu & inspector offer `Wrap in 4 in Grid` / `Wrap in Stack`.
  - Grid Layout inspector: Tactile segmented `Columns [ 1 | 2 | 3 | 4 ]` control; clicking columns live re-layouts cards with smooth CSS grid transition.
  - Seam insertion: Hovering between sections displays hairline seam + black `+` button (`Add below`); clicking opens palette with position tabs `[ Before | After | Inside ]` + component search (`prog` -> `ProgressCard`).
  - Component swap: Clicking `Swap component…` on `Button ("Ends in 4 days")` opens popover with search `Q Swap Button for...`, intelligence notice (*"Becomes Dropdown — drops variant, which Dropdown does not take"*), and taxonomy (`Inputs`: Dropdown, Input, TextField; `Layout`; `Data display`). Swapping immediately updates canvas to Dropdown and inspector to Dropdown props.
  - Dual Mode inspector: Segmented `[ Design | Code ]` switch; clicking `Code` opens real TSX source (`CyclesPage.tsx`) importing from `@/uikit`.
  - Foundations & Brand Token Overhaul: Changing `Brand colour` (`#5e5ad2` -> Teal `#0f968a`) calculates impact (*"rewrites 14 colour tokens, 102 component instances"*); clicking Apply updates all buttons and progress bars live across the app and triggers toast: `Changes applied · Brand colour -> Teal 500 · Undo [Z]`.
- **[`Screen Recording 2026-10-31 at 11.56.03 in the morning.mov`](./Screen%20Recording%202026-10-31%20at%2011.56.03%20in%20the%20morning.mov):** Live Linear-style `Cycles 24` app running at `localhost:5173/cycles/24` in dark mode; prompt-driven branding (*"Brand it like this screen: dark and calm, use indigo accent #5E5AD2, status colors: red/amber/green"*).
- **[`Screen Recording 2026-10-31 at 11.56.43 in the morning.mov`](./Screen%20Recording%202026-10-31%20at%2011.56.43%20in%20the%20morning.mov):** Core architecture principles:
  - *"Layers are components"*: Every layer is a kit component, props 1 click away.
  - *"Props, not pixels"*: Changing columns or gap in inspector live updates the component and syncs to JSX (`<Grid columns={4} gap="16">`).
  - *"Variables"*: 3-layer tokens (`Core` -> `Semantic` -> `Component`).
- **[`Screen Recording 2026-10-31 at 11.57.22 in the morning.mov`](./Screen%20Recording%202026-10-31%20at%2011.57.22%20in%20the%20morning.mov):** *"Start from scratch"* vs *"Bring your components"* (`@company/uikit` or `starter-uikit`).
- **[`Screenshot 2026-10-31 at 11.53.07 in the morning.png`](./Screenshot%202026-10-31%20at%2011.53.07%20in%20the%20morning.png):** Visual reference for anchored `Swap Button for...` popover, compatibility notice, and Layers rail with component pill tags.
- **[`Screenshot 2026-10-31 at 12.09.20 in the afternoon.png`](./Screenshot%202026-10-31%20at%2012.09.20%20in%20the%20afternoon.png):** Visual reference for Inspector:
  - Header: `Dropdown` title + `···` + `✕`.
  - Tabs: `[ ⟐ Design ] [ <> Code ]` + `⌨`.
  - Filter: `🔍 Filter props and values      ⌘F`.
  - Breakpoint bar: `📱 Breakpoint    Writes the base value` with `[ 📱 ] [ 📱 ] [ 🖥 ] [ 💻 ]`.
  - Content card: `Value` (with blue dot + `···`), `Placeholder` (with `···`).
  - Size card: Tactile notched track (`|`, `!`, `'`) with right-aligned `sm` badge.
  - State card: `Disabled` toggle switch + `···`.

---

### 2. Completed Architecture Specification (`design_plan.md`)
The normative architecture plan has been fully updated and synchronized:
1. **§1A Architecture Contracts (Normative):**
   - §1A.1: Same-kit Theme Switching vs Cross-kit Migration.
   - §1A.2: Authoritative Editing Model & DocumentMutationService (debounced 250ms, auto-stamping `data-agent-id` only when unambiguous).
   - §1A.3: Interaction State Machine & WCAG 2.2 SC 2.5.8 (≥24×24 CSS px targets).
   - §1A.5: One transient contextual selection pill, zero persistent floating toolbars.
   - §1A.8: Updated specification of mock capabilities.
   - §1A.9: Studio Workspace Layout & View Transitions (3-column studio entrance, global sidebar collapsed, layers and customize open by default, scale-locked desktop artboard, popover dock alignment).
2. **§5 Canvas & Direct Selection:**
   - §5.3: Semantic layer iconography (`⛶` sections, `⎈` component instances, `T` text, page sheets).
   - **§5.4: Canvas Selection Badge & Swap Component Popover (`Swap Button for…`):** Blue border + anchored blue badge `Button ⟐`, compatibility intelligence warnings, grouped taxonomy (`Inputs`, `Layout`, `Data display`, `Feedback`), atomic mutation and undo.
   - **§5.5: Multi-Selection & Structural Wrapping (`Wrap in Stack / Grid`):** Shift-click canvas/layers selection, `N selected` checklist, 1-click `Wrap in Stack`, `Wrap in 4 in Grid`, `Wrap in Card`.
   - **§5.6: Canvas Seam Insertion Palette (`[ Before | After | Inside ]`):** Hairline seam `+` trigger, categorized component insertion palette.
3. **§6 Live Inspector Panel:**
   - §6.1: Dual-state panel (Page Theme when idle, Element Style when selected) + Content `Value` & `Placeholder` overrides + tactile notched Size slider.
   - **§6.3: Inspector Chrome, Dual Tabs (`[ Design | Code ]`), Search Filter (`⌘F`), and Breakpoint Bar:** Pixel-perfect alignment with Screenshot 12.09.20.
   - **§6.4: Layout Inspector for Stack & Grid (Tactile Segmented Columns Stepper):** `Columns [ 1 | 2 | 3 | 4 ]`, `Gap`, `Render as`.
4. **§8 Foundations & Tokens:**
   - **§8.4: Foundations & Brand Token Palette Live Regeneration:** `Brand colour` (`#5e5ad2` -> Teal `#0f968a`), impact calculation notice, toast `Changes applied · Brand colour -> Teal 500 · Undo [Z]`, live propagation across all buttons, progress bars, and badges.

---

### 3. Current State of Interactive Prototype (`design_mode_mock.html`)
- **CSS Styles Added:**
  - `.selection-badge` (anchored blue chip with diamond `⟐`).
  - `.swap-popover` (popover with search, intelligence notice, categorized items).
  - `.seam-palette` (seam insertion with `Before`/`After`/`Inside` tabs).
  - `.insp-tabs-row`, `.insp-filter-row`, `.insp-device-grid` (matching Screenshot 12.09.20).
  - `.grid-col-seg` (tactile column stepper `[ 1 | 2 | 3 | 4 ]`).
  - `.multi-sel-list` (checklist for multi-selected elements).
- **DOM Elements Added:**
  - Anchored `#selectionBadge`, `#swapPopover`, and `#seamPalette` inside `.artboard-scaler`.
  - Updated `#panelElement` header, tabs, filter input, breakpoint bar, layout card, and added `#panelMultiSelect`.
  - Added `#pageCycles` (the full `Cycles 24` interactive canvas DOM with `PageHeader`, `Ends in 4 days`, `+ New issue`, `Grid` with 4 metric cards, `Burndown chart`, and `IssueList`) inside `#fnPage`.
  - Added `cycles.html` to `#pageMenu` dropdown.

---

### 4. What Left Needs to Be Done (Action Items for Next Turn)
1. **In `design_mode_mock.html`:**
   - Wire the remaining JavaScript functions into `<script>`:
     - `openSwapPopover()`, `filterSwapOptions()`, `performSwap()`: swapping `Button "Ends in 4 days"` into `Dropdown` with `Ends in 4 days`, updating inspector and layers live.
     - `openSeamPalette()`, `filterSeamOptions()`, `setSeamPos()`, `insertComponentFromPalette()`: inserting components at hairline seams.
     - `toggleMultiSelect()` on canvas (Shift+Click) and `wrapSelected('grid')` / `wrapSelected('stack')`: wrapping selected metric cards.
     - `setGridColumns(n)`: updating `grid-template-columns: repeat(N, 1fr)` live when clicking `1`, `2`, `3`, `4`.
     - `filterPropCards()`: filtering prop cards via `⌘F` input.
     - `setInspectorTab()`: toggling between Design and Code tabs.
     - `switchMockPage('cycles.html')`: showing `#pageCycles` and re-running `renderLayersTree()`.
   - Run `node --check` to verify syntax and open in browser to verify zero console errors.
2. **In Production Codebase (`src/renderer/**` & `src/main/**`):**
   - Follow `design_plan.md` roadmap (Phase 1 & Phase 2) to promote these verified mock components into:
     - `src/renderer/src/design/DesignCanvas.tsx` (Canvas selection badge `Button ⟐`, seam hover `+ Add below`).
     - `src/renderer/src/design/InspectorPanel.tsx` (Inspector header, tabs, filter `⌘F`, Breakpoint bar, Content `Value`/`Placeholder`, tactile slider track, Layout columns stepper).
     - `src/renderer/src/design/SwapPopover.tsx` (floating swap popover component).
     - `src/renderer/src/design/SeamInsertPalette.tsx` (seam insertion palette).
     - `src/main/design/bridge.ts` (smart hit testing & selection extent calculation).
   - Ensure all editor chrome uses Ink Flat tokens from `src/renderer/src/styles/app.css` and strictly adheres to `DESIGN.md` (no literal colors, no emojis, controls ≥24px/28px).

---

## Completed: Code Mode v3 + structural `run_code` uptake + pre-turn deliverable snapshot (2026-10-31)

- **Plans:** `.ai/plans/code-mode-enhance.md` (full 3-phase spec), `.ai/plans/run-code-uptake-v2.md`, `.ai/plans/run-code-uptake.md`.
- **What's built:**
  - **Phase 1 — Speed:**
    - Zero-stall lazy `parentOf` resolution + immediate `ctx.parentId` fast path (`src/main/code-mode.ts`, `src/main/agents/types.ts`).
    - Single-crossing QuickJS `JSON.parse` marshaling in `toHandle()` and `load()` (`src/main/harness/tools/code.ts`).
    - Async `node:fs/promises` I/O across `read`/`glob`/`grep`, `MAX_IN_FLIGHT = 16` (`code-broker.ts`), concurrent directory walks + expanded `SKIP_DIRS` (`glob.ts`), cached `rgPath` lookup + batched JS `scanFiles` with whole-file multiline pre-check (`grep.ts`).
    - In-memory `boundPreview()` (`bound.ts`) so structured child calls inside `run_code` skip `.txt` spill-file disk writes (`code-broker.ts`).
  - **Phase 2 — Accuracy & Script Quality:**
    - `read` (`read.ts`): >2 MB paged window reads (`offset` + `limit` up to 64 MB file size, capping the returned slice at 2 MB instead of rejecting up front) and `\r\n` → `\n` normalization in scripts.
    - `glob` & `grep` (`glob.ts`, `grep.ts`): script `grep` content line cap raised `300` → `4000` chars; `limit` added to `glob` and `grep`; `context` (`0..20`, `before`/`after` arrays) added to `grep` content mode.
    - Parameter aliases (`types.ts`, `read.ts`, `glob.ts`, `grep.ts`): camelCase and model-native aliases (`file_path`/`filePath`, `start_line`/`end_line`, `dir`/`directory`, `query`/`regex`, `include`/`filePattern`, `ignoreCase`/`case_insensitive`, `outputMode`/`mode` `"files"`/`"lines"`/`"counts"`).
    - Sandbox ergonomics (`code.ts`): `console.info/debug/warn/error`, pure POSIX `path` helpers (`join`, `dirname`, `basename`, `extname`, `normalize`), tolerant batch `tools.readMany` (`read_many`), trailing options merge for two-arg calls like `tools.grep("pat", { output_mode: "content" })`, adjusted `Line N:` stack trace reporting, expanded `explain()`, and empty `=> undefined` hints.
  - **Phase 3 — Structural Agent Uptake (`codeMode === "off"` 100% unchanged):**
    - **OpenCode v2 (`2.2.0`):** `acp/driver.ts` sets `CUBIQ_CODE_MODE=1` per process when `codeMode !== "off"` and `run_code` is attached; `OPENCODE_GUARD_V2_SOURCE` (`src/main/inject/opencode-guard.ts`) captures `cubiq`'s HTTP MCP `{ url, headers }` via `ctx.mcp.transform`, removes built-in `read`/`glob`/`grep` via `ctx.tool.transform`, and registers top-level `run_code` (`options: { codemode: false }`, Effect `Schema` cloned from built-in string field, zero external imports). `acpCodeHint` sends `CODE_HINT` and `harnessTool` matches top-level `run_code` so child rows nest under it.
    - **Codex (`0.159.2`):** `codeTool` wired into `createCodexDriver` (`src/main/index.ts`, `src/main/agents/codex.ts`); `thread/start` registers `run_code` via `dynamicTools` (`deferLoading: false`; omitted on `thread/resume`), sends `CODE_HINT` in `developerInstructions`, handles `item/tool/call` + `dynamicToolCall` items with deduped `tool-use` emission (`startedTools`) and direct `parentId` nesting, and keeps MCP `run_code` fallback.
  - **Pre-turn deliverable snapshot (`src/main/artifacts.ts`, `src/main/service.ts`, `bench/lib/project.ts`):** `snapshotDeliverables` captures `path -> { mtimeMs, size }` before `runTurn` so pre-existing deliverables checked out or copied inside the `Date.now() - 2000` coarse-clock window (e.g. `src/renderer/src/assets/experts/*.svg`) no longer trigger false turn-end cards or auto-open the Preview panel; `layTree` also passes `preserveTimestamps: true`.
- **Live-checked (`read-heavy` on pinned `17b3eba`, `codeMode: "on"` vs `"off"`):**
  - **Uptake (`codeMode: "on"`):** 100% `run_code` uptake (`0` `look`, `0` `shell`, `0` orphan child rows) across OpenCode 2.2.0 (`opencode-tokenharbor`: 13 `run_code`, 212 children), Codex 0.159.2 (`codex-luna`: 8 dynamic `run_code`, 38 children, no `tool_search`), and Native (`tokenharbor-deepseek`: 24 `run_code`, 278 children). OpenCode Zen free hit account cap; Codex Ask-mode approval with `codeMode: "off"` verified live.
  - **Token & speed comparison (`on` vs `off`):** Codex `gpt-6-luna` ran **56% faster** (`53.5 s` vs `122.8 s`) with **21.9% fewer total tokens** (`290.7k` vs `372.1k`, `-10.4%` billed-equiv input, `89.8%` cache hit). DeepSeek `v4.1-flash:free` used more tokens with `on` (`511k` OpenCode / `669k` Native, `89–91%` cache hit) than `off` (`331k` / `219k`) because in Full-access `off` mode it wrote a temporary TS compiler AST script via shell instead of iterating regex scripts in QuickJS.

## Completed earlier: issue tracker + PR flow in CubiQ (P1–P3 done in m4 2026-10-30)

- **Plans:** `.ai/plans/issue-tracker.md` (P1/P2 code map), `.ai/plans/issue-agent-aware.md` (P3).
- **P1/P2** (see git `8633f86` for the old detail): `/issue`, `/issue-setup`, `/triage`, `/pr` as `/` commands; the app's own setup card; `Thread.issue` with the full issue once, then one line.
- **P3 as built (user's calls 2026-10-30):**
  - `issue_create` harness tool (`src/main/issues-tool.ts`, `createIssue` in `issues.ts`): GitHub/Gitea via `gh|tea api` with a JSON body file, GitLab via `glab api` (attachments upload with `--form`), local files (attachments copied to `<folder>/attachments/NNNN/`). Labels = type + `needs-triage`. GitHub and Gitea attachments are left out on purpose (their CLIs can't upload) and named in the result.
  - `set_thread_issue` tool: an existing issue becomes the thread's chip. Both tools only in threads whose folder has `.cubiq/issues.json`, fixed per thread for the app run (a thread opened before `/issue-setup` gets them after a restart).
  - Guide note `ISSUES_NOTE` (`guide.ts`), only with a tracker. Alone it got 1 unprompted offer in 7 live runs, so:
  - **Reply check** (`issue-offer.ts`, `service.setIssueOffer`): after a finished turn whose reply names a problem, the background model (`pickBackground`, ~300 tokens, accounted as purpose `issue`) decides; an offer is an `issue-offer` event, the **File issue?** card (`IssueOfferCard`, ThreadView). File sends the user's yes; Dismiss is kept in localStorage. Settings → Threads → Issues turns it off (`issueOffers`).
  - Composer: Tab completes a `/` command (Enter runs it); chat chips show `/issue-setup`, not `$issue-setup`.
- **Live-checked:** the card and filing on Claude Haiku, Codex gpt-6-luna, OpenCode (TokenHarbor `deepseek-v4.1-flash:free`) and native PGS DeepSeek; GitHub #10 filed for real (the sidebar "Running while waiting on a card" bug, left open).
- **Known bug:** the native provider's Read hands an image to a text-only model; the turn dies ("does not accept image input").
- **opencode:** Zen free is capped; `oc` dispatch uses PGS Grove `PGA/deepseek-v4-flash-0731`.

## Where things stand
- **Branch `m4`**, pushed: this session's work (R1–R4 of `.ai/plans/release-builds.md`, approved 2026-10-29: every PR push builds installers, Apple Silicon only, plus a shells-test fix) was merged in from `track/release`, along with the other session's `CLAUDE.md`, `DESIGN-MODE.md` and `docs/testing/`. No worktrees are open.
- **CI (run on `track/release` before the merge):** run `40820793700` (Windows+Ubuntu+extras): both `package` jobs green (the `.dmg` passed `codesign --verify` and the packaged smoke on the macOS runner), Ubuntu and codex-e2e green; Windows failed only on a shells temp-dir race, fixed in `c39b94e` and green in run `40827470388`.
- **Local suite:** fully green (4,008 passed across 312 test files), OpenCode v2 E2E and Codex dynamic-tool tests included.
- **`release-cubiq.yml` never ran for real**: `workflow_dispatch` needs the file on `main`. After the PR merges: Actions → release-cubiq → Run workflow without **publish** first (build only), then a tag or **publish**.

## Done this session
- `5c79388` **R3, a real bug:** on OpenCode v2 the agent and its sub-agents read files outside the project with no card in Ask mode. v2's base rule allows every action, and `toV2Permissions` dropped `external_directory`. Now the v2 translation keeps it and adds v1's default (`external_directory` ask) first, so later rules (expert read dirs) still win. On 2.2.0 a sub-agent's ask arrives over ACP, so the v2 plugin needs no `answerAsk`. The git guard itself worked on v2: the failing tests always built the v1 plugin and config, and the fake model called `bash`/`task` (v2: `shell`/`subagent`, `read` takes `path`). The tests now follow the CLI's major (`openCodeGuardedPlan` in `test/helpers.ts`). Live check in the app: an Ask thread on Zen DeepSeek showed "Allow Read? …/outside/notes.txt", and a denial kept the file out.
- `610f5f7` **R4:** the `history-fixtures` big-thread timeout is 45 s.
- `0c27841` **R1 + R2:** `release-cubiq.yml` and the `package` job in `ci.yml`. Signing notes:
  - Unsigned macOS builds pass `-c.mac.identity=-` (ad-hoc). Without it electron-builder leaves the app unsigned and Apple Silicon calls it "damaged".
  - On a PR, electron-builder skips all signing unless `CSC_FOR_PULL_REQUEST=true`. That's safe here: no secrets.
  - Notarization follows the `APPLE_*` env by itself (electron-builder 26), so `electron-builder.yml` is unchanged.
  - `test/ci-workflow.test.ts` pins both workflows.
- `c39b94e` Windows CI: the shells stop-scope test stops its last shell before cleanup.

## Next
- Open the PR from `m4` to `main`. Its `package` job uploads the installers.
- The first real release (above). Signing remains the user's step; see below.

### Unsigned builds (works today)
- macOS: ad-hoc signed (`-c.mac.identity=-`); both workflows check it with `codesign --verify --deep --strict`.
  - First open: System Settings → Privacy & Security → **Open Anyway** (macOS 15+), or `xattr -dr com.apple.quarantine /Applications/CubiQ.app`.
  - No auto-update: macOS refuses unsigned updates; `src/main/updater.ts:40` already keeps that error quiet.
- Windows: a SmartScreen warning (More info → Run anyway). Auto-update works unsigned.

### Signing macOS (the user's steps; the workflow picks the secrets up with no edit)
1. Apple Developer Program, $99/year (an organization account needs a D-U-N-S number).
2. A **Developer ID Application** certificate (account holder only): Xcode → Settings → Accounts → Manage Certificates → +, or a CSR from Keychain Access uploaded on developer.apple.com.
3. Export it as a `.p12` with its private key and a password.
4. Repo secrets: `MAC_CSC_LINK` = `base64 -i cert.p12`, and `MAC_CSC_KEY_PASSWORD`.
5. Notarization secrets: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from appleid.apple.com), and `APPLE_TEAM_ID` (from the Membership page).
6. The hardened runtime and `build/entitlements.mac.plist` are already set up. To check a build: `spctl -a -vvv CubiQ.app` reads "Notarized Developer ID", and `xcrun stapler validate CubiQ.dmg` passes.
- Windows signing is optional: Azure Trusted Signing (≈$10/month) or a `.pfx` in `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`.

## Still open from older tracks (lower priority)
- **Design live** (detail: `git show 2e2dd54:DESIGN-LIVE-HANDOFF.md`):
  - A live run that uses `resources/design-patterns/ai-parts.md` (e.g. an agent-run screen in `clean-inset`), and a re-check of `zinc-console`'s 32px nav rows.
  - Optional: soften the 44px target rule for sidebar nav rows in `design-prototype/SKILL.md`.
  - Nits: the variant cycler sits low on inline (`span`) sets; the crushed-tracking detail joins `<br>` text.
- **Bench** (detail: `git show 2e2dd54:HANDOFF.md`; those fixes are already in `m4`):
  - Bench half of item 5: `bench/run.ts` waits for `learnOverview().drafting === 0` before stopping, then recounts lessons.
  - Item 9: give the bench app's OpenCode its own config dir (`XDG_CONFIG_HOME`) and keep the provider auth.
  - Item 4: a todo nudge in Claude's Stop hook when a multi-part request has several edits and no list. Run `--tasks build-cli --k 3 --scratch` first, which costs money: ask.
  - Items 6, 8 and 10: code mode on read-heavy tasks; PGS Grove credits (the user's call); Claude's cost (`bun run cache:report`).

## How to work here
- **Checks before every commit:** `bun run typecheck`, `bun run test`, `bun run design:check`. Claude reads the diff itself; a worker's "done" doesn't count.
- **UI changes:** follow `DESIGN.md`. Check them in the real app: dark and light themes, and 900px wide.
- **Windows:** `gh workflow run ci.yml --ref m4 -f os=windows` (or `windows+ubuntu`). A force-push to the `windows` branch was blocked by the permission check this session.
- **Live app:** `npx electron-vite dev --remoteDebuggingPort 9477 -- --user-data-dir=<scratchpad>/ud`, then `agent-browser --cdp 9477`.
  - Pick the `localhost:5173` tab before each eval; the design frame is its own tab.
  - In a fresh profile: `openChats()`, `createThread(id, "opencode", {kind:"design"})`, and put a page in `ud/chats/<thread>/designs/<first 8>/index.html`.
  - Never kill the user's own dev app.
- **Live model runs:** DeepSeek free (OpenCode Zen) first. Ask before any Claude or Codex run.
- **Commits:** only that change's files, a message of 150 characters or fewer, no trailer.
