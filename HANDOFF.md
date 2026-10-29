# Handoff (2026-10-29, Mac): one file for every open track

This replaces the old `HANDOFF.md`, `DESIGN-LIVE-HANDOFF.md`, `DESIGN-ENHANCE-HANDOFF.md` and `road-map-handoff.md`. Their full history is in git: `git show 2e2dd54:<file>`.

## Where things stand
- **Branch `m4`**, pushed to origin at `2e2dd54`. No worktrees are open (`../aiharness-wt/` is empty). The user will open the PR from `m4` to `main`.
- **CI:** Windows and Ubuntu are green on `2e2dd54` (manual run `40809032756`). The last PR-triggered run is on `c44d3bb` and red only from fixes made since. Push again to refresh it.
- **Local suite:** green except the 10 OpenCode v2 tests (`opencode-ask` 9, `opencode-guard` 1). CI doesn't install OpenCode, so it doesn't see them. See R3.
- **Main checkout, not ours:** another session left `CLAUDE.md` and `resources/DESIGN-MODE.md` (one blank line) uncommitted, plus `docs/testing/`. Leave them alone.

## Next: release builds (plan `.ai/plans/release-builds.md`, Mac only; WAITING FOR THE USER'S APPROVAL)
The README (`README.md:133-153`) describes a release workflow, but the file was lost when this repo was split out (`cc594bf`): `.github/workflows/` has only `ci.yml`, so a tag builds nothing today.
- **R1 `release-cubiq.yml`** (renamed from `release-unskilled`; tag `cubiq-v<version>`):
  - Triggers: the tag, or a manual run with a **publish** box (off = build only).
  - A `check` job: the tag must equal `cubiq-v` + the `package.json` version, and a version that's already released is refused.
  - A build matrix: macOS (`dmg` + `zip`), Windows (`nsis` `.exe`), Linux (AppImage), each with `electron-builder --publish never`.
  - A `publish` job: `gh release create` with every file plus `latest*.yml`, marked latest.
  - Rename the README section to match.
- **R2 PR builds:** a `package` job in `ci.yml` uploads the macOS `.dmg` and Windows `.exe` as artifacts (7 days), with no secrets (`test/ci-workflow.test.ts` enforces that).
- **R3 OpenCode v2 guard, a real bug:** on OpenCode v2.2.0 the guard plugin (`src/main/inject/opencode-guard.ts`) no longer blocks a guarded `git` call, and the sub-agent permission asks break the same way. Find what changed in v2's plugin hooks and ACP asks, fix it for v1 and v2, and test both shapes.
- **R4 flake:** `test/history-fixtures.test.ts` "seeds the big thread", timeout 15 s → 45 s (it timed out once on Windows).
- **Open questions for the user:**
  1. Approve the plan.
  2. PR builds on macOS bill 10× (≈100 minutes per PR push): run them on every push, or only with a `build` label? The recommendation is the label.
  3. Apple Silicon only, or an Intel build too (a second runner; `node-pty` must be built for x64)?

### Unsigned builds (works today)
- macOS: needs at least an ad-hoc signature on Apple Silicon, else macOS says "damaged". Check with `codesign -dv` in CI; `CSC_IDENTITY_AUTO_DISCOVERY=false` when there are no secrets.
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

## Done this session (in `m4`)
- `467252b` **Style chip back** in the design composer, next to the fence chip:
  - Nothing picked (or a style that's gone) = Auto; once the agent picks, it reads `Auto · <style>`.
  - Style names only, with no palette (user: "shouldn't display theme, just style").
  - Colours follow the style unless the prompt names one: the guide's "The brief wins", plus the switch note.
- `65d1a78` **Canvas fixes from the user's screenshots:**
  - The Inspector hides its Elements tab while the Layers rail is open.
  - The canvas-first prompt pane keeps clear of an open Inspector (`--design-inspector-w`), so it is centred with the live bar.
  - The live bar sits 12px above the Chat handle.
- `track/design-live` (P0–P4 of design live, plus `zinc-console` and `clean-inset` styles and `ai-parts.md`) was merged in; its worktree and branch are gone.
- **CI fixes:**
  - `3331bc7`: the design fence allows `/dev/null`-style streams (and `NUL` on win32); tests pin LF line ends; the `/tmp` fence case follows the host's temp dir.
  - `c44d3bb`: the shells test waits for its shells to exit; doctor-gather expects the platform's path join.
  - `2e2dd54`: the real agent-browser tests skip when the CLI doesn't run.

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
