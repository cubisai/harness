# CubiQ

CubiQ is a desktop app for working with AI coding agents. Open a project folder, start a thread, and let Claude, Codex, OpenCode or another agent read, edit and run your code while you watch every change. It runs on macOS, Windows and Linux.

It also has a **Design mode**: describe a page, app screen, phone flow or slide deck, and the agent builds it as live HTML on a canvas you can click, edit and export.

## Install

Download the installer for your system from the [Releases page](https://github.com/cubisai/harness/releases):

| System | File |
| :--- | :--- |
| macOS (Apple Silicon) | `.dmg` |
| Windows | `CubiQ-Setup-<version>.exe` |
| Linux | `.AppImage` |

Installed copies update themselves: a new version downloads in the background and installs when you quit, or right away from **Update ready · Restart** in the sidebar.

**First launch of an unsigned build.** On macOS, open System Settings → Privacy & Security and choose **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/CubiQ.app`). On Windows, SmartScreen may warn you: choose More info → Run anyway.

No release yet? [Build it yourself](#build-from-source).

## Connect an agent

CubiQ drives the agents you already use, with their own sign-in. You need at least one:

- **Claude** is built in. Sign in once with `claude` in a terminal (Claude Code), or set `ANTHROPIC_API_KEY`.
- **Codex** appears when the `codex` CLI is installed and signed in.
- **OpenCode** appears when `opencode` is installed. **Cursor** appears when `cursor-agent` is installed.
- **Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)** can be added in `agents.json` in CubiQ's data folder.
- **Your own model provider**: in Settings → Agents & Providers, add an OpenAI-compatible, Responses or Anthropic endpoint with its key. It shows up as its own agent in the model picker.

API keys you enter are encrypted with your system keychain and used only to call that provider.

## Working with agents

- **Threads.** Each thread runs one agent in a project folder. Pick the agent and model in the thread header; switching agents can hand off a summary of the work so far.
- **Permission modes.** *Ask* asks before every tool call, *Auto-edit* lets the agent read and edit files but still asks before commands, *Full* allows everything. A git guardrail checks every shell command.
- **Changes.** The side panel shows the working-tree diff. Open any file or hunk in your editor (VS Code, Cursor, Zed, JetBrains IDEs, Xcode and more) at the exact line.
- **Skills.** Type `/` for workflow skills. The agent loads its other skills by itself when the work calls for them.
- **Library** (⌘⇧L). Every skill, MCP server and agent in one place. MCP servers you add here reach every agent in every thread.
- **Built-in browser** (⌘⇧B). Open your dev server beside the thread; the agent can click, type, read the console and take screenshots in the same page. Pick an element to attach it to your message.
- **Terminal** (⌃\`). A real shell in the project folder.
- **Message Center.** The bell in the sidebar lists permission requests from other threads and turns that finished while you were away.
- **Usage.** The thread header shows the thread's tokens and cost, and how close you are to your plan's rate limits.

Press ⌘K (Ctrl+K on Windows and Linux) to search actions, skills, threads and projects.

## Design mode

Switch the sidebar to **Design** and describe what you want: "Landing page for a note-taking app", "Mobile login", "Pitch deck for a coffee brand".

- The first time, CubiQ offers to download its library of real-site design references (about 45 MB; also in Settings → Design). The agent picks a fitting look from it and builds the page from **Foundation**, CubiQ's component kit, so every page shares one set of tokens and parts.
- The canvas shows the page live as it's written. Click to select an element, double-click to edit its text, and change its props, spacing and colours in the panel.
- Ask for **variants** to compare layouts side by side, **comment** on the canvas, or **draw** on it to show the agent what you mean.
- Preview at desktop, tablet and phone sizes, present a deck, and export to HTML, PNG or PDF.
- **Build in codebase** hands a finished design to a coding thread that implements it in your project (needs a project folder).

## Settings

Open Settings with ⌘, (Ctrl+, on Windows and Linux): appearance (light, dark, density, motion), the default agent and permission mode for new threads, your editor, providers and keys, and automatic updates.

## Build from source

You need [Bun](https://bun.sh) and Git.

```bash
git clone https://github.com/cubisai/harness.git
cd harness
bun install
bun run dev     # start the app
bun run dist    # build an installer for this system
```

Checks: `bun run typecheck`, `bun run test` and `bun run design:check`.

## Privacy

CubiQ runs on your machine. Your projects, threads and settings stay in its local data folder. Prompts go only to the agent or provider you choose, under that service's own terms. Saved keys are encrypted with your system keychain.
