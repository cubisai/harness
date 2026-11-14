# Releasing CubiQ

For maintainers. Users only need the [README](../README.md).

## Build an installer

`bun run dist` builds for the OS you're on: a `.dmg`/`.zip` on macOS (Apple Silicon), an NSIS `.exe` on Windows, an `.AppImage` on Linux. The icon is `build/icon.png`.

## Publish a release

Bump `version` in `package.json` on `main`, then either push a tag `cubiq-v<version>`, or open Actions → release-cubiq → Run workflow on `main` and tick **publish**.

The `release-cubiq` workflow builds all three installers and publishes a GitHub release with them and the `latest*.yml` files the updater reads. It refuses a tag that doesn't match `package.json`'s version, and a version that's already released. A run without **publish** only builds; its installers stay on the run's page for 7 days. Other releases in this repo must not be marked "latest", or the updater looks there.

## Signing

Builds are unsigned until these repository secrets exist; each OS signs only when its own are set. Unsigned, the macOS app is ad-hoc signed and the Windows installer shows a SmartScreen warning. macOS refuses unsigned updates, so auto-update on macOS needs a signed build.

| Secret | What it is |
| :--- | :--- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | A "Developer ID Application" certificate as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | For notarization; needs the certificate above |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | A code-signing certificate as a base64 `.pfx`, and its password |

The macOS build uses the hardened runtime with `build/entitlements.mac.plist`: JIT for V8 and the bundled Claude Code binary, and library validation off for node-pty.

## CI

CI (pull requests to `main`, or run on demand) runs typecheck, tests and a build, then packages the app on Linux and runs the smoke test (`node scripts/smoke.mjs` after `electron-builder --dir`). It uses no secrets: every test talks to a local fake or a mock agent. Windows runs on demand: `gh workflow run ci.yml --ref <branch> -f os=windows`.
