# CubiQ

A minimal desktop coding-agent harness for Windows, macOS, and Linux, with modular plugin and skill support.

You open a project folder, start a thread, and work with Claude inside it. Typing `/` shows workflow skills. The agent picks up design and review skills by itself as the work calls for them.

## How skills get in without costing context

The app follows the contract in [HARNESS.md](plan/docs/HARNESS.md) (see also [Research: AI Coding-Agent Harnesses](plan/docs/research-ai-agent-harnesses.md)):

- **Model-invoked skills (15)** go to Claude as a local plugin, generated into the app's data folder from the bundled `skills/`. Claude lists them and loads each one only when it needs it. Inside a plugin they are named `skilled:<name>`, so the app rewrites every `Call the Skill tool with "x"` in the plugin's copies to match.
- **User-invoked skills (23)** never go to the agent. The `/` menu lists them from `skills.json`. When you pick one, the app puts the skill's body into your message, the same thing Claude Code does for a typed `/command`.
- **git-guardrails** runs as a pre-tool hook on every shell command the agent issues. It needs Python 3; without it the guard is off.

## Library

The Library (⌘⇧L, the books icon in the sidebar, or ⌘K) shows what the agents get, like the plugin and skill views in other harnesses:

- **Skills:** every skilled skill, searchable, split into the workflow skills you start with `/` and the ones the agent loads by itself. Each one shows its full SKILL.md, what it calls and what calls it, its files, and how it reaches each installed agent (Claude's plugin, Codex's skills folder, `DSH_BUNDLED_SKILL_DIR`, or `install.py`). Workflow skills have a **Use in Thread** button.
- **MCP Servers:** your own servers, the app's built-in browser tools, and, read-only, the servers each agent already loads from its own config: Claude Code's `~/.claude.json` and `.mcp.json`, Codex's `~/.codex/config.toml`, Gemini's `settings.json`, and OpenCode's `opencode.json`. Env and header values are never shown.
- **Agents:** every agent the app knows, installed or not, with how it runs, how skills and MCP servers reach it, and a copyable install command for the missing ones.

### Your MCP servers

Add a server in the Library (a command, or a URL for Streamable HTTP, plus env vars or headers) and every agent gets it in every thread, next to its own:

- Claude gets it through the Agent SDK's `mcpServers`.
- Codex gets it in the thread's config (`mcp_servers`).
- ACP agents get it in `session/new`. They get stdio servers always, and URL servers when they support HTTP MCP.

Changing the list reloads the agent's session at the next message, so a running conversation picks it up. **Test** connects and lists the server's tools. Switching a server off keeps it without passing it on. The servers live in `mcp.json` in the data folder, in the same shape as Claude Code's `.mcp.json`, so entries copy across; the file is readable only by you.

## Open in editor

- **Changes panel:** **Open in <editor>** opens the project, and its menu lists every editor found, plus Show in Finder / File Explorer / Files. Each changed file has an open button that opens it at its first change, and clicking a hunk header opens that spot.
- **In the conversation:** file names in inline code (`src/auth.ts:42`) and the paths on Read/Edit/Write rows are links that open the file at that line.
- **⌘K:** has Open Project in … for each editor.

Editors found: Cursor, VS Code (and Insiders), Windsurf, VSCodium, Zed, Sublime Text, the JetBrains IDEs (IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, CLion, RustRover, PhpStorm, RubyMine), and Xcode on macOS.

The last editor you pick becomes the default; Settings → Editor changes it. How it works:

- **Finding editors without PATH.** Apps started from the Dock or Start menu don't get your shell's PATH, so the app also looks where installers put editors: `.app` bundles in `/Applications` and `~/Applications`, Program Files and `%LOCALAPPDATA%\Programs` (including versioned JetBrains folders), `~/.local/bin`, `/snap/bin` and flatpak on Linux, and JetBrains Toolbox's scripts on every OS.
- **Jumping to the line.** Each editor family gets its own syntax: `--goto file:line:col` for VS Code and its forks, `file:line:col` for Zed and Sublime, `--line N --column M file` for JetBrains, and `xed --line N` for Xcode.
- **Starting the editor.** It runs detached, without the API keys you saved in Settings and without Electron's own variables in its environment. Windows `.cmd` launchers go through `cmd.exe` with every argument quoted. If an editor was uninstalled since the app looked, it looks again.

## Command palette

⌘K (Ctrl+K on Windows and Linux) opens one search box over everything: actions (new thread, the side panel's tabs, permission mode, agent, model, theme), skilled's workflow skills, every thread in every project, and the projects themselves. Arrow keys move, Return runs, Esc closes. With nothing typed it shows the actions and your five most recent threads. Start with `>` to list actions only. Picking a skill puts it in the current thread's message box, or starts a thread with it when none is open.

## Threads, the Message Center and the message box

- **Sidebar sections:** each project's threads are grouped **Pinned**, **Active**, and **Settled** (idle for more than three days and not running), newest first. The pin on a row's hover pins it until the app restarts. Each row names its agent, and the branch when the project isn't on its default one.
- **Shortcuts:** ⌘1–⌘9 (Ctrl on Windows and Linux) open the nth thread in the sidebar's order; ⌘\ collapses the sidebar to a rail that keeps every footer button.
- **Message Center** (the bell in the sidebar footer): permissions waiting on threads other than the open one, and turns that finished while you were elsewhere, with their agent and duration. Clicking a row opens the thread and clears it.
- **Queued messages:** sending while a turn runs queues the message as a dashed bubble; it goes out once, as the next turn, when the current one ends. Stop clears the queue.
- **Context chips:** an element picked in the browser pane becomes a chip in the message box instead of pasted text; its full description goes out with the message. Backspace in an empty box removes the last chip.
- **Files tab:** the side panel's third tab lists the project's files (what git tracks plus untracked files it doesn't ignore); clicking one opens it in your editor.

## Settings

Settings (⌘, or the gear in the sidebar) is one sheet with a list of groups on the left:

- **Appearance:** System, Light, or Dark; Motion (Instant by default, Subtle, or Full; your system's reduce-motion setting always wins); Density (Comfortable or Compact rows).
- **Threads:** the agent and permission mode a new thread starts with, and the editor files open in.
- **Agents & Providers:** each agent's credentials and the provider list, and the installed agents. Keys are encrypted with the OS keychain (Electron `safeStorage`), never sent to the window, and passed only to the agent they belong to; saving or removing one restarts running agents.
- **Skills & MCP:** the skill count, with shortcuts into the Library.
- **Data & Security:** where keys are kept, and the data folder.
- **Updates:** the version, and whether new ones download by themselves (on by default).

The thread header shows one quiet meter: the thread's tokens and cost so far, summed from each finished turn.

Beside it, a limit meter shows how close the thread's agent is to its plan's rate limits (Claude's 5-hour and weekly windows, Codex's windows), once one passes 50%. It turns orange from 80% and red when a limit is hit, with reset times on hover. The app never asks for these: Claude Code sends a `rate_limit_event` and Codex an `account/rateLimits/updated` notification, both built from the headers on responses the agent gets anyway. There's no polling, and no call to Claude's usage endpoint or Codex's `account/rateLimits/read`, so watching the limits can't use them up. The numbers are only as fresh as the agent's last turn; API-key logins have no plan limits, so they show none.

## Terminal

The terminal drawer (⌃\`, at the bottom of the window) is a real shell in the project folder: `$SHELL` on macOS and Linux, and PowerShell 7, Windows PowerShell, or cmd on Windows. It runs through node-pty and xterm.js, with one shell per project that keeps running while the drawer is closed. If the shell exits, press any key to start a new one.

## Agents

Every thread runs one agent, picked in the header. Switching agents asks how: **Hand off** gives the new agent a checkpoint of the thread (goal, decisions, files changed, commands and their results; never reasoning or convention files, which each agent loads itself) after marking a git ref to come back to; **Start fresh** opens a clean session; **Switch back** resumes the session the thread already had with that agent.

What each agent can do here comes from its capabilities, not its name. The Library shows them as chips and a "can't do here" list, and the app says so where an agent falls short (a permission card notes when a command can't be vetoed before it runs, a switch notes what isn't carried).

- **Claude** (always there) uses the Claude Agent SDK. It gets skilled's model-invoked skills as a plugin, plus the browser tools.
- **Codex** appears when `codex` is on your PATH. It runs as `codex app-server`, one process for all threads, and resumes threads from Codex's own history. It uses your Codex login. skilled's model-invoked skills reach it as an extra skills root, and Ask and Auto-edit both run Codex under the `untrusted` approval policy with a `workspace-write` sandbox, because `on-request` lets Codex run commands without asking. In Auto-edit the app accepts Codex's file changes itself and still asks for commands; the git guardrail checks every command. Full is `never` with full access. The browser tools are in its config from the first turn.
- **Any agent that speaks ACP** (the [Agent Client Protocol](https://agentclientprotocol.com)) goes through one generic driver. Each thread keeps its agent process alive between turns and resumes the stored session after a restart when the agent supports it. Models come from the agent's own `model` config option.
  - **DeepSeek** appears when `dsh` ([deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), `npm i -g @deepseek-ai/dsh`) is on your PATH. It runs as `dsh --profile acp` and uses your dsh configuration and `DEEPSEEK_API_KEY`. skilled's model-invoked skills reach it through `DSH_BUNDLED_SKILL_DIR`, so nothing is written into your project.
  - **Antigravity** is off unless you opt in: Settings → Agents & Providers, after acknowledging that driving Google's Antigravity ACP server from another app is third-party access its Terms of Service (section 6) treat as a breach that can get the account suspended. The acknowledgement is kept, with the date and the disclosure version. Once on, it appears after a restart when Google's own [Antigravity ACP server](https://antigravity.google) (the ACP registry's `antigravity-acp`) is on your PATH; that is `agy_acp_server.par` on macOS/Linux and `agy_acp_server.exe` on Windows, and its `localharness_external` sibling must sit next to it. The first run needs a Google sign-in: the app shows the link the server prints on stderr. On a machine that has never signed in, the model list stays empty until the first successful turn signs in. The app runs Google's binary with your Google sign-in. It takes HTTP MCP servers only, not stdio, so the app's browser tools reach it but stdio servers don't. It is marked **Unsupported** and is never offered a provider from your list. CI never runs it.
  - **OpenCode** appears when `opencode` is on your PATH, and runs as `opencode acp`.
  - **Cursor** appears when `cursor-agent` is on your PATH.
  - OpenCode and Cursor have no setting for an extra skills folder, so skilled's model-invoked skills reach them only if you run `python3 install.py --model-only` in the project (they read `.agents/skills`). The `/` menu works for them either way.
  - **Your own:** add them to `agents.json` in the app's data folder. An entry with a preset's id replaces the preset:

    ```json
    { "agents": [{ "id": "qwen", "label": "Qwen Code", "command": "qwen", "args": ["--acp"], "env": {} }] }
    ```

  The permission modes carry over. Ask asks for every tool call. Auto-edit allows reads and file edits without asking. Full allows everything.

The `/` menu works the same for every agent, since the app composes the skill's text itself. The browser tools reach Codex and ACP agents too (for ACP, if the agent accepts HTTP MCP servers; deepseek-harness does). The app serves them from a local MCP server on 127.0.0.1, which only accepts requests carrying a per-run token.

## The built-in browser

The Browser tab (⌘⇧B) is a real Chromium page beside the thread: open your dev server there, and the agent can drive the same page. The agent always has seven tools: `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_logs`, and `browser_screenshot`. Until you open the tab they answer "Browser pane not open"; they're always offered because adding tools mid-conversation would invalidate the prompt cache and reload the session.

- Snapshots are text with element refs (`[e3] button "Sign in"`), a fraction of a screenshot's tokens. Screenshots are saved to files, and the model sees the image only when it asks.
- Clicks are real mouse events through the Chrome DevTools Protocol. Console errors, uncaught exceptions, and failed or 4xx/5xx requests are captured as they happen.
- `verify-in-browser` picks these tools up automatically, so a UI check runs where you can watch it.
- **Pick an element** with the target button: hover to highlight, click to add the element's selector, text, HTML, and a cropped screenshot to your message. Esc cancels.
- The pane has no Node access and no preload, and loads only http(s), file, and data URLs. `browser_eval` asks before it runs in Ask mode; the other tools don't.

## Running it

From the repo root:

```bash
bun install
bun run dev       # Electron with hot reload
bun run test      # unit tests
bun run typecheck
```

Claude uses your existing Claude Code login (run `claude` once in a terminal), or `ANTHROPIC_API_KEY`. It reads your usual Claude Code settings and `CLAUDE.md`.

To look at the UI without Electron or an agent: `bun run preview:ui`, then open `http://localhost:5199/?state=thread`. Other states: `permission`, `running`, `project`, `welcome`, `settings`, `update`, `palette`, `limits`, `library`, `library-mcp`, `library-agents`. This uses canned data from `src/renderer/src/mock.ts`.

## Building installers

`bun run dist` builds for the OS you're on: a `.dmg`/`.zip` on macOS, an NSIS `.exe` on Windows, an `.AppImage` on Linux. The icon is `build/icon.png`, rendered from `build/icon.svg`.

To release, bump `version` in `package.json` on main, then either:

- push a tag `unskilled-v<version>`, or
- on GitHub, open Actions → release-unskilled → Run workflow, pick `main`, and tick **publish**. That tags the commit for you, and works from a phone.

The `release-unskilled` workflow builds all three, then publishes a GitHub release with the installers and the `latest*.yml` files the updater reads. It refuses a version that's already released. A manual run without **publish** only builds.

### Updates

Installed copies check this repo's latest GitHub release at start and every four hours, download a newer version in the background, and install it when you quit. The sidebar shows **Update ready · Restart** to install right away. It works in the macOS and Windows builds and the Linux AppImage, never in dev. On macOS it needs a signed build, because macOS refuses unsigned updates. Other releases in this repo must not be marked "latest", or the updater will look there and find nothing.

### Signing

Builds are unsigned until these repository secrets exist. Each OS signs only when its own are set.

| Secret | What it is |
| :--- | :--- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | A "Developer ID Application" certificate as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | For notarization. Needs the certificate above |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | A code-signing certificate as a base64 `.pfx`, and its password |

The macOS build uses the hardened runtime with the entitlements in `build/entitlements.mac.plist`: JIT for V8 and the bundled Claude Code binary, and library validation off for node-pty.

CI runs typecheck, tests and a build on all three OSes, then packages the app on Linux and runs the smoke test against it (`node scripts/smoke.mjs`, after `electron-builder --dir`). It uses no secrets: every test talks to a local fake or a mock agent, and the workflow sets only an allowlisted pair of variables (`test/ci-workflow.test.ts` checks both). The smoke test (`--smoke`) checks that the window loads, the preload bridge works, the skills catalog and settings answer, the bundled Claude Code binary runs, the browser tools can open a page, type, click, pick an element, and read the console, a real shell answers through node-pty, and, each in a scratch folder: the provider registry resolves plans, a Milestone 3 install migrates without losing a key or a session, a handoff checkpoint carries commands but no reasoning, and Claude's adapter output renders exactly like the canonical rows every agent must produce. `plan/docs/rollback.md` is the rollback drill. Set `UNSKILLED_SMOKE_SCREENSHOT=<file.png>` to also save a screenshot of the window. On Linux, CI also installs Codex, so `test/codex-e2e.test.ts` runs the real `codex app-server` against a fake model: it adds the browser tools mid-thread, then approves and runs one. `test/claude-e2e.test.ts` does the same for the bundled Claude Code binary against a fake Messages API, on every OS. Both fakes send plan rate-limit headers. The Codex test checks the limits arrive without any extra request; the Claude test checks an API-key session makes no extra request and shows no plan limits, since they don't apply to API keys.

## Layout

| Path | What it is |
| :--- | :--- |
| `src/main/index.ts` | Electron entry point: window, IPC, smoke mode |
| `src/main/service.ts` | Everything the UI can ask for. No Electron imports, so it runs in tests |
| `src/main/agents/` | The `AgentDriver` interface; the Claude (Agent SDK), Codex (app-server), and ACP drivers; the shared stdio JSON-RPC transport; and the agent registry |
| `src/main/skills/` | Reading `skills.json`, generating the plugin, composing prompts |
| `src/main/updater.ts` | Background updates from GitHub releases (electron-updater) |
| `src/main/mcp/` | Your MCP servers (`mcp.json`), each agent's format for them, the Test connection, and reading the agents' own MCP config |
| `src/main/library.ts` | What the Library shows: skill details and the agent catalog |
| `src/main/editors.ts` | Finding editors and opening files in them at a line |
| `src/main/settings.ts` | Settings and encrypted API keys, in `settings.json` in the data folder |
| `src/main/db.ts` | SQLite store (`node:sqlite`): projects, threads, events |
| `src/main/git.ts` | Working-tree diff for the Changes panel |
| `src/main/mcp-http.ts` | The harness's tools as a local MCP server, for ACP agents |
| `src/main/terminal.ts` | The terminal drawer's shells (node-pty) |
| `src/main/browser/` | The browser pane's controller (DevTools Protocol), page snapshots, and the agent's `browser_*` tools |
| `src/main/guard.ts` | git-guardrails pre-tool hook |
| `src/preload/` | The `window.unskilled` bridge |
| `src/shared/types.ts` | The main ↔ renderer contract |
| `src/renderer/` | React UI. Hand-written CSS in `styles/app.css`, state in `store.ts`, the command palette's search in `palette.ts` |

## Stack

Electron 44 (the same Chromium on every OS, which the built-in browser needs), React 19, Vite via electron-vite, Zustand, `node:sqlite`, the Claude Agent SDK, and xterm.js with node-pty, the app's one native module. node-pty uses Node-API, so the same build works in Node and Electron. The UI uses no component library: system fonts, macOS vibrancy and Windows Mica, light and dark themes from CSS tokens.

