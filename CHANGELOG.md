# Changelog

What changed in each CubiQ release. The app shows this list in **About CubiQ**, and each GitHub release uses its version's section as the release notes.

Maintainers: add a line under **Unreleased** as you go, then run `bun run release` (see README → Releases).

## [Unreleased]

## [0.1.3] - 2026-11-19

### Added

- One-line installers: `curl -fsSL https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.sh | bash` on macOS and Linux, `irm https://raw.githubusercontent.com/cubisai/harness/main/scripts/install/install.ps1 | iex` on Windows
- Coding threads with Claude, Codex, OpenCode, Cursor, custom ACP agents and compatible model endpoints, with a choice of agent and model for each thread
- A changes panel for reviewing diffs, with git worktrees, commit, merge and push
- A browser and terminal inside the workspace, a Library for skills and MCP servers, memory, automations, and Creator mode apps
- Design mode: pages, app screens, mobile flows and slide decks on a live canvas, with kits, variants, comments and HTML, PNG or PDF export
- The About sheet shows these release notes, and opens on them once after an update
- When macOS blocks a project folder (Desktop, Documents, iCloud Drive…), CubiQ says which Privacy & Security switch to turn on and opens System Settings there

### Changed

- macOS builds without a Developer ID now update themselves: CubiQ downloads the release, checks its checksum and signature, and swaps the app when you restart
- The update card links to the incoming version's notes before you restart
