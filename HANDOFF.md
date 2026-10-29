# Handoff (2026-10-29, Mac, updated after the release-builds session): one file for every open track

This replaces the old `HANDOFF.md`, `DESIGN-LIVE-HANDOFF.md`, `DESIGN-ENHANCE-HANDOFF.md` and `road-map-handoff.md`. Their full history is in git: `git show 2e2dd54:<file>`.

## Where things stand
- **Branch `track/release`** (pushed) holds this session's work on top of `m4`: R1–R4 of `.ai/plans/release-builds.md` (approved 2026-10-29: every PR push builds installers, Apple Silicon only) and a shells-test fix. **Not merged into `m4` yet**: the main checkout still has another session's uncommitted `CLAUDE.md`, `resources/DESIGN-MODE.md` and `docs/testing/`. Fast-forward `m4` once that's settled (`git merge --ff-only track/release` in the main checkout), then remove `../aiharness-wt/release` and the branch.
- **CI on `track/release`:** run `40820793700` (Windows+Ubuntu+extras): both `package` jobs green (the `.dmg` passed `codesign --verify` and the packaged smoke on the macOS runner), Ubuntu and codex-e2e green; Windows failed only on a shells temp-dir race, fixed in `c39b94e` and green in run `40827470388`.
- **Local suite:** fully green (3906 passed), the OpenCode v2 tests included.
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
- Open the PR from `m4` (after the merge above) to `main`. Its `package` job uploads the installers.
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
