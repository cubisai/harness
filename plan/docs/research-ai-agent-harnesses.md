# Research: AI Coding-Agent Harnesses

Single consolidated research file (per the `research` skill convention). **Findings only — nothing
here is implemented.**

**Date:** 2026-09-25
**Scope:** AI coding-agent harnesses — the apps that drive coding agents, how they abstract over
different agents (Claude Code, Codex, OpenCode, ACP…), how they handle other models
(BYOK / DeepSeek), and whether conversation context survives switching agents.
**Method:** parallel subagent research against primary sources (official docs, GitHub repos,
specs, live sites) plus static analysis of a local clone of `pingdotgg/t3code` (MIT). High-stakes
claims were re-fetched directly and marked ✅ **spot-checked**.
**Tag key:** `[P]` verified against a primary source · `[S]` secondary/corroborated · `[U]` unverified / not found.
**Caveat:** dates, versions, and pricing are as of 2026-09-25 and move fast.

## Contents

| Part | Covers |
|---|---|
| [Part 1 — Control surfaces & harnesses](#part-1) | T3 Code · OpenCode v2 · ZCode · WorkBuddy · first-party apps · OSS harnesses · DeepSeek's ecosystem |
| [Part 2 — Running other models (DeepSeek / BYOK)](#part-2) | Claude Code · Codex · other harnesses · `dsh` · caveats · DeepSeek API · how it fits together |
| [Part 3 — Agent switching & context portability](#part-3) | source-level T3 teardown · ACP · why context doesn't port · blueprint |
| [Appendix](#appendix) | reliability & method notes |

## At a glance

| Harness / app | Maker | Platform | Built on | Agent | BYOK / custom providers | DeepSeek |
|---|---|---|---|---|---|---|
| **T3 Code** | Theo / T3 (MIT) | Mac/Win/Linux + mobile | TS/Node · Effect · Electron | **wraps** Claude, Codex, OpenCode, Cursor, Grok, Antigravity | no native driver [U] | indirect (via OpenCode) |
| **OpenCode v2** | anomalyco | terminal / web / desktop | TS/Bun · Effect · OpenTUI | **own** agent | yes — any OpenAI-compatible base URL | first-class (`/connect`) |
| **ZCode** | Z.ai / Zhipu | Mac/Win/Linux (Electron) | Electron + own runtime | **own** (self-developed) | yes — OpenAI + Anthropic-compatible | yes (BYOK preset) |
| **WorkBuddy** | Tencent | Win/Mac | Electron + CodeBuddy CLI | **own** (CodeBuddy-based) | yes — custom model JSON | yes (`models.json`) |
| **Codex** | OpenAI | Mac/Win/Linux | CLI + desktop Codex view + IDE ext | **own** | **yes** — `model_providers` | **yes** (official) |
| **Claude Code** | Anthropic | Mac/Win/Linux | CLI + IDE extensions | **own** | gateway only; Claude models only officially | works, unsupported by Anthropic |
| **Antigravity** | Google | Mac/Win/Linux | agentic IDE | **own** | curated catalog only | no |
| **Cursor** | Cursor | [U] | desktop IDE | **own** | fixed BYOK list; no arbitrary base URL | no |
| **DeepSeek Harness (`dsh`)** | DeepSeek (MIT) | web/npm + SDK | Cordis plugins | **own** | yes — 3 wire protocols | native |
| **OpenClaw** | OpenClaw Foundation (MIT) | Win/Mac/Linux + mobile | TS/Node + local Gateway | **plugins** (Claude, Codex, local) | yes | yes (onboarding) |
| **Goose** | Block / aaif (Apache-2.0) | Win/Mac/Linux | Rust | **own** | yes | yes (`custom_deepseek`) |
| **Crush** | Charm (FSL-1.1-MIT) | terminal | Go | **own** | yes — OpenAI/Anthropic-compatible | generic |
| **Cline** | Cline (Apache-2.0) | VS Code / JetBrains / CLI / desktop | TS · Tauri | **own** | yes — any OpenAI-compatible | yes |
| **OpenHands** | OpenHands (MIT) | web / self-host | TS/React + Python | **own** + ACP agents | yes | yes |

---

<a id="part-1"></a>

# Part 1 — Control surfaces & harnesses

Product survey: what each harness is built on, what it wraps, and how it exposes models.
Sections: 1.1 T3 Code · 1.2 OpenCode v2 · 1.3 ZCode · 1.4 WorkBuddy · 1.5 first-party official
apps · 1.6 open-source app-harness survey · 1.7 DeepSeek's own agent ecosystem · 1.8 sources.

---

## 1.1 T3 Code

**Identity** [P] ✅ **spot-checked** — `github.com/pingdotgg/t3code`, by Theo Browne / T3
(the T3 Stack / t3.chat lineage). MIT-licensed. README self-describes it as an
**"agent harness control surface."** ~23.5k stars, 6.1k forks. Announced publicly
2026-03-07; releases are **`0.0.x`** and the desktop app is branded **"T3 Code (Alpha)"**
— README states *"We are very very early in this project. Expect bugs"* and is
*"mostly not accepting contributions."*

**What it's built on** [P]
- TypeScript ESM monorepo, Node server (Electron desktop + Expo mobile + React/Vite web).
- **Effect**-based server with WebSocket/RPC transport.
- Key point: **it orchestrates and does not implement the model loop.** It drives other
  agents' runtimes.
- Uses `@anthropic-ai/claude-agent-sdk`, an **effect-codex-app-server** wrapper,
  `@opencode-ai/sdk/v2`, and **ACP** adapters.

**How it wraps other harnesses** [P] ✅ (matches the fetched README)

| Harness | Status | Mechanism |
|---|---|---|
| Claude Code | **Supported** | Claude Agent SDK (`claude auth login`) |
| OpenAI Codex | **Supported** | Codex app-server (`codex login`) — not a generic OpenAI client |
| OpenCode | **Supported** | `@opencode-ai/sdk/v2`, local or external server |
| Cursor | **Supported** | `cursor-agent` via ACP (`agent login`) |
| Grok Build | **Supported** | `grok agent stdio` via ACP |
| Google Antigravity | **Supported** | official ACP agent + Google auth |
| **Generic BYOK / OpenAI-compatible / DeepSeek** | **Unclear — no native driver found** [U] | No generic OpenAI-compatible provider in the built-in driver registry; exact custom `baseURL`/key/model schema not confirmed |

**Features** [P] — projects, durable threads, **worktrees**, branch selection, multi-model
selection, terminal + PTY, diffs and PR review, GitHub/GitLab/Forgejo/Gitea/Bitbucket/Azure
DevOps integrations, permission modes (Supervised / Auto-accept edits / Auto / Full access),
built-in provider-scoped MCP tooling, web + macOS + iOS + Android with remote access
(T3 Connect / LAN / Tailscale / SSH). No first-class plugin manager or subagent abstraction
was found [U].

**Relationship to opencode & DeepSeek** — T3 has a *first-class* OpenCode integration and acts
as a control surface around an OpenCode server. **DeepSeek support is therefore indirect**,
inherited from OpenCode's provider config — not a T3–DeepSeek partnership. A GitHub issue
(#3571) reportedly flags an OpenCode model-ID incompatibility
(`opencode-go/deepseek-v4-pro`), so treat it as conditional. [P for integration / S for the issue caveat]

---

## 1.2 OpenCode v2

**Identity & the naming mess** [P]
- Current canonical repo: **`anomalyco/opencode`**; `sst/opencode` resolves to the *same*
  repository ID — SST is a historical namespace, not a separate project.
- **`opencode-ai/opencode`** is a *different, archived Go project* whose lineage continued as
  Charm's **Crush** (`charmbracelet/crush`). Do not confuse it with OpenCode v2.
- No primary source found proving a formal SST/Charm ownership dispute. [U]

**What "v2" is** [P] — An update channel + branch (`refs/heads/v2`), package
**`@opencode/cli`**, current version **`2.0.16`**. Docs are internally inconsistent: some call
v2 a *beta* and reference `opencode2`; v1 (`v1.18.32`) is still separately published.
Intentional v2 breaking changes: new plugin API, new server API/client contract, TUI config
moved from layered `tui.json(c)` to global `cli.json`.

**Built on** [P] — TypeScript/Bun monorepo; **Effect**-based provider-neutral AI layer
(`@opencode/ai`) with OpenAI/Anthropic/Google/Bedrock/OpenAI-compatible adapters;
**OpenTUI + SolidJS** TUI; Electron desktop + Solid/Vite web; server/client/protocol/SDK
packages; in-process **plugins** (hooks, tools, commands, agents, model transforms).

**Features** [P] — TUI + headless `opencode run`, `opencode serve`, shared background service;
built-in agents (`build`, `plan`, `general`, `explore`) plus custom primary/subagents; shell,
file, web tools; permission rules; `AGENTS.md` + `.opencode/skills`; MCP (local/remote, OAuth);
**ACP** via `opencode acp`; SDK embedding. **Notably: v2 has NO active LSP runtime** — the
`lsp` config is accepted for compatibility but does nothing (v1 had LSP). Session sharing is
accepted but not implemented in v2.

**Provider / BYOK handling** [P] — catalog from **models.dev**; `/connect`, `/models`,
`opencode auth login`. Custom providers support `env`, `package`, `settings.baseURL`,
`headers`, `body`, `models` — so **any OpenAI-compatible endpoint works** via
`settings.baseURL`. `env` lists variable *names*, not inline secrets.

**Harness integration** — Supports **ACP** and **MCP**, but **no evidence it embeds/wraps
Claude Code, Codex CLI, or Gemini CLI** [U]. (Google/Anthropic *model* support ≠ CLI harness
support.)

**DeepSeek** [P] ✅ — DeepSeek publishes an official OpenCode integration: run `opencode` →
`/connect` → `deepseek` → enter DeepSeek API key → pick DeepSeek-V4-Flash; recommends
OpenCode ≥ `v1.18.30`.

---

## 1.3 ZCode — Z.ai's first-party harness

**Identity** [P] ✅ **spot-checked** — `zcode.z.ai`, by **Z.ai / Zhipu AI**. The site tagline is
literally **"Official Harness for GLM-5.3."** It is an **Agentic Development Environment (ADE)**
— a standalone Electron desktop app, *not* a VS Code fork and not a Claude Code wrapper.
Announced ~2026-07-02 (initially around GLM-5.2) [S]; current release **v3.14.3** (2026-09-22).

**Platform** [P] ✅ — macOS (Apple Silicon + Intel `.dmg`), Windows (x64 + ARM64 `.exe`),
Linux (x64 + ARM64 `.deb`/`.rpm`/`.AppImage`, still marked **Beta**). No official standalone
CLI/TUI and no documented Homebrew/winget/npm install.

**Built on** [P] — Electron (installer URLs contain `/zcode/electron/releases/`); bundled
Node `.cjs` agent runtime (`zcode.cjs`). The **ZCode Agent is explicitly "self-developed"** and
integrated with its own workspace, task queue, permissions, terminal, browser, Git state, and
Review panel. It does **not** wrap Claude Code / Codex / OpenCode as its core runtime. [P]

**Features** [P] — first-party agent; four execution modes (**Ask before changes**,
**Edit automatically**, **Plan**, **Full access**); built-in **general-purpose** + read-only
**Explore** subagents; user-defined subagents (Beta) as Markdown in `~/.zcode/agents/<name>.md`;
**MCP over stdio/HTTP/SSE** with remote OAuth and **import of MCP config from Claude Code, Codex
CLI, and OpenCode**; terminal, browser/DevTools, **Goal Mode** (long-running tasks), edit
history, skills, plugins, hooks, background tasks; remote workspaces via **SSH, Docker, WSL**;
bot control from **WeChat / Feishu / Telegram**.

**Provider / BYOK** [P] — GLM Coding Plan (OAuth) or API key. Documented endpoints:

| Path | Base URL |
|---|---|
| Z.ai OpenAI-compatible | `https://api.z.ai/api/coding/paas/v4` |
| Z.ai Anthropic-compatible | `https://api.z.ai/api/anthropic` |
| BigModel OpenAI-compatible | `https://open.bigmodel.cn/api/coding/paas/v4` |
| BigModel Anthropic-compatible | `https://open.bigmodel.cn/api/anthropic` |

BYOK presets include Anthropic, OpenAI, OpenRouter, Moonshot, MiniMax, Xiaomi MiMo, and
**DeepSeek** (`https://api.deepseek.com/anthropic` or `https://api.deepseek.com/v1`). Config at
`~/.zcode/v2/config.json`, provider `options`: `apiKey`, `baseURL`, `apiKeyRequired`, `headers`
(no arbitrary extra body params yet). MCP config: `~/.zcode/cli/config.json` (user),
`<project>/.zcode/config.json` (workspace).

**Disambiguation** [P]

| Candidate | Exists? | What it is |
|---|---|---|
| ZCode by Z.ai | **Yes** | Electron ADE, first-party GLM-5.3 harness |
| Z-CODE (simonyos) | Yes | Unrelated personal Go terminal agent; explicitly not affiliated |
| `kingsword09/zcode-cli` | Yes | **Unofficial** TUI wrapping the desktop runtime |
| `yangmain/zcode-acp`, `supermomonga/zcode-acp` | Yes | **Unofficial** ACP bridges → Zed/JetBrains |
| Z-CodeSnippets | Yes | Unrelated Tauri snippet manager |
| Zed | Yes | Unrelated Rust editor (can host ZCode via ACP) |
| ZCode VS Code/JetBrains extension or VS Code fork | **No** | Not confirmed in official docs |
| Official source repo | **Not found** | Only `github.com/zai-org/feedback` (roadmap) |

**Important:** ZCode's support for an Anthropic-compatible endpoint is **protocol compatibility,
not** evidence it is a Claude Code wrapper. `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` configure
**Claude Code's** own Z.ai integration — they are not ZCode settings. [P]

---

## 1.4 WorkBuddy AI (Windows / macOS)

**Identity** [P] ✅ (DeepSeek page verified verbatim) — **Tencent WorkBuddy**, a Tencent Cloud
"full-scenario" desktop agent for office work with a coding mode. `workbuddy.ai`. Global launch
**2026-05-28**. **CodeBuddy is related but distinct**: Tencent's developer suite (IDE/plugins +
**CodeBuddy Code** CLI). An inspected WorkBuddy build embeds the CodeBuddy CLI, which explains
DeepSeek's combined "WorkBuddy/CodeBuddy" label and the shared `.codebuddy` config dir.

**Built on** [S] — official docs don't disclose the stack; community teardown of WorkBuddy
5.3.8 macOS ARM64 reports **Electron 37** + Node 22.21 + React/Vite renderer, with
Electron main → local daemon → sidecar → bundled `codebuddy --serve` over local ACP/HTTP.
No evidence it wraps Claude Code/Codex/OpenCode — it ships its own CodeBuddy-based harness.

**Features** [P] — auto model routing, built-in models, parallel tasks/agents, authorized-folder
access, artifacts/previews, skills, connectors, automation, expert/agent teams, MCP (+ MCP session
recovery), coding mode with a **Changes** review panel. Remote control via Slack/Telegram/Discord.
CodeBuddy Code (CLI) adds file editing, command exec, Git/test tools, smart commits, MCP,
**sub-agents**, IDE integration, and browser/LAN remote control (beta). Automated PR creation: [U].

**BYOK / providers** [P] — **Settings → Model → Add/Edit Custom Model**: provider presets, API
keys, custom URLs/model names, capability flags, Ollama, and a "Custom Protocol" bypass. Legacy
config at `~/.codebuddy/models.json`. Hosted tiers: Free 100 credits/mo; Pro $10/mo or $96/yr with
2,000 credits/mo; Team $40/seat/mo or $480/seat/yr with a shared 1,000-credit/seat pool. Whether
BYOK calls still consume WorkBuddy credits: [U].

**DeepSeek setup** [P] ✅ — set `DEEPSEEK_API_KEY`, create
`C:\Users\<user>\.codebuddy\models.json` (or `<project>\.codebuddy\models.json`):

```json
{
  "models": [{
    "id": "deepseek-flash",
    "name": "DeepSeek Flash",
    "vendor": "DeepSeek",
    "url": "https://api.deepseek.com/v1/chat/completions",
    "apiKey": "${DEEPSEEK_API_KEY}",
    "maxInputTokens": 128000,
    "maxOutputTokens": 8192,
    "supportsToolCall": true,
    "supportsImages": true
  }],
  "availableModels": ["deepseek-flash"]
}
```

Save **UTF-8 without BOM**, fully quit and reopen, then pick **DeepSeek Flash**. Known traps:
401 = wrong key (don't put the URL in the key field); 404 = id must be exactly `deepseek-flash`;
`${DEEPSEEK_API_KEY}` showing literally = launch from a terminal where the var is set, or paste
the key directly.

**Platform** [P] — Windows 10 1809+/11 (x64, ARM64, `.exe`); macOS 12+ (M1–M4 or Intel, universal
`.dmg`, 4 GB RAM / 500 MB). Standalone CLI is branded **CodeBuddy Code** (`@tencent-ai/codebuddy-code`).
Linux: [U].

---

## 1.5 First-party official apps — provider / BYOK comparison

| App | Maker | Platform | Built on | Custom providers / BYOK? | DeepSeek? |
|---|---|---|---|---|---|
| **Codex** app (`/CLI`/`/ChatGPT desktop`/VS Code ext) | OpenAI | Mac/Win/Linux | open-source CLI + separate desktop surface | **Yes** — `[model_providers.<id>]` `base_url`/`env_key`/`wire_api`; Ollama, LM Studio, Bedrock | **Yes** — same config drives CLI, desktop Codex view, and IDE ext [P] ✅ |
| **Claude Code** | Anthropic | Mac/Win/Linux | terminal CLI + IDE extensions | Custom Anthropic **gateway** base URL; **Claude models only, officially** | Not Anthropic-supported; DeepSeek's `/anthropic` endpoint exists [P] ✅ |
| **Claude Desktop** | Anthropic | Mac/Win/Linux | desktop app (framework [U]) | Consumer BYOK **not found**; enterprise Cowork via Bedrock/Vertex/Azure/Anthropic gateway | Not found |
| **Antigravity** | Google | Mac/Win/Linux | agentic IDE (base [U]) | Curated Google catalog (Gemini + Claude + GPT-OSS); **no general BYOK** | Not found |
| **Gemini CLI** | Google | Mac/Win/Linux | open-source Node.js CLI | Gemini API / Vertex endpoint overrides only (`GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`) | Not found |
| **Cursor** | Cursor | [U in reviewed pages] | desktop IDE | Fixed BYOK: OpenAI/Anthropic/Google/Azure/Bedrock; no arbitrary base URL; routes via Cursor backend | No direct BYOK found |
| **Windsurf** | Windsurf → now served under Cognition/Devin docs | [U] | desktop/CLI | BYOK advertised; exact config [U] | **Yes, in current managed catalog** (not BYOK) |

**Key takeaways** [P]
- **Codex is the only first-party app with first-class non-OpenAI provider support**, and the
  DeepSeek config is shared across all three Codex surfaces (CLI, desktop, IDE extension).
- **Anthropic's stance is explicit**: gateways must not route Claude Code to non-Claude models.
  DeepSeek's Claude Code integration therefore works but is *unsupported by Anthropic*.
- **System prompt/tooling caveat:** switching a harness's model changes the agent, not just the
  brain — the harness prompt, built-in tools, policy layers, skills, and MCP wiring stay native.

---

## 1.6 Open-source app-harness survey

**Important status corrections** (several are dead/archived as of 2026-09):
- **Crystal** — **deprecated Feb 2026**, replaced by Nimbalyst.
- **Vibe Kanban** — **sunsetting** (was ~28.2k stars).
- **Roo Code** — **archived/shut down 2026-05-15**.
- **Continue** — repo **read-only**, no longer actively maintained after 2.0.0.
- **Void** — **archived/deprecated 2026-06-02**.
- **Crush** license is **FSL-1.1-MIT**, not plain MIT (converts to MIT later).
- `conductor.build` exposes **no public repo/license** — not confirmed open source. It's a Mac
  app running Claude Code + Codex + Cursor in isolated workspaces (v0.87.3).

### Group A — multi-agent desktop/control surfaces

| Tool | Repo | License | Platform | Built on | Wraps | BYOK |
|---|---|---|---|---|---|---|
| Conductor | *not found* | [U] | Mac desktop | [U] | Claude Code, Codex, Cursor | [U] |
| Crystal | `stravu/crystal` | MIT | Mac desktop | Electron | Claude Code, Codex | inherited |
| Claudia | `getAsterisk/claudia` | AGPL-3.0 | Win/Mac/Linux | Tauri 2 + Rust + React | Claude Code | Claude auth only |
| Vibe Kanban | `BloopAI/vibe-kanban` | Apache-2.0 | web/npx/desktop | Rust + Node | 10+ agents | inherited |
| Claude Squad | `smtg-ai/claude-squad` | AGPL-3.0 | terminal/tmux | Go/TUI | Claude, Codex, Gemini, Aider, arbitrary CLIs | inherited |
| CCManager | `kbwo/ccmanager` | MIT | terminal | TS/Bun, PTYs | Claude, Gemini, Codex, Cursor, Copilot, Cline, OpenCode, Kimi | inherited |
| opcode | `winfunc/opcode` | AGPL-3.0 | Win/Mac/Linux | Tauri 2 + Rust | Claude Code | Claude auth only |

### Group B — terminal/CLI open-source agents

| Tool | Repo | License | Built on | Providers | BYOK |
|---|---|---|---|---|---|
| Crush | `charmbracelet/crush` | FSL-1.1-MIT | Go/Charm | many | **yes** — custom OpenAI/Anthropic-compatible |
| Goose | `aaif-goose/goose` | Apache-2.0 | Rust | 15+ + ACP | yes (custom format not confirmed) |
| OpenHands | `OpenHands/OpenHands` | MIT | TS/React + Python | own + Claude Code/Codex/Gemini via ACP | yes, "any LLM" |
| Aider | `Aider-AI/aider` | Apache-2.0 | Python | almost any + local | yes |
| SWE-agent | `SWE-agent/SWE-agent` | MIT | Python | model choice | yes |

### Group C — IDE/editor & extensions

| Tool | Repo | License | Built on | Status | BYOK |
|---|---|---|---|---|---|
| Cline | `cline/cline` | Apache-2.0 | TS; Tauri/Bun desktop | very active (~69k★) | **yes**, any OpenAI-compatible |
| Roo Code | `RooCodeInc/Roo-Code` | Apache-2.0 | VS Code ext | **archived 2026-05-15** | n/a |
| Kilo Code | `Kilo-Org/kilocode` | MIT | TS/Bun; CLI forked from OpenCode | very active (~27k★) | provider billing default; BYOK [U] |
| Continue | `continuedev/continue` | Apache-2.0 | TS | **read-only / unmaintained** | n/a |
| Zed agent panel | `zed-industries/zed` | GPL-3.0 (+Apache parts) | Rust | active | API/gateways/local; ACP external agents |
| Void | `voideditor/void` | Apache-2.0 | VS Code fork | **archived 2026-06-02** | direct/local |

**Most notable/active** [P]: OpenHands (~89k★), Cline (~69k★), Goose (~55k★), Crush, Kilo.
**Best direct BYOK stories**: Crush, Cline, Goose, OpenHands.
**Parallel-session orchestration**: Vibe Kanban and Claude Squad are the clearest examples — but
Vibe Kanban is sunsetting. Most manager GUIs **inherit credentials from the CLI they launch**.

---

## 1.7 DeepSeek's own agent ecosystem

DeepSeek's docs sidebar lists exactly: DeepSeek Harness, Claude Code, Codex, OpenCode, OpenClaw,
Hermes, Reasonix, WorkBuddy/CodeBuddy, Qoder. [P] ✅ (verified the sidebar in fetches)

| Agent | Maker | Platform | Built on | Open source? | DeepSeek setup |
|---|---|---|---|---|---|
| **DeepSeek Harness (`dsh`)** | DeepSeek AI | Web/npm; SDK: Linux/macOS/Windows | **Cordis** plugin architecture | **Yes, MIT** | Web **Settings → Models** → key, no restart; custom providers: id + base URL + protocol (`openai-completions`/`openai-responses`/`anthropic-messages`) |
| **OpenClaw** | OpenClaw Foundation (501(c)(3)) | Win/Mac/Linux + iOS/Android, WSL2 | TS/Node monorepo + local **Gateway** | **Yes, MIT** ✅ (~390k★) | `openclaw onboard --install-daemon` → QuickStart → DeepSeek → key → model |
| **Hermes** | **Nous Research** | Linux/macOS/WSL2 (+ repo: Windows, Android/Termux) | Python/Node, no base harness named | Yes, MIT | `hermes setup` → Quick Setup → DeepSeek; base `https://api.deepseek.com`, `deepseek-v4-pro` |
| **Reasonix** | community (`esengine`) | macOS/Linux/Windows; Tauri desktop prerelease | **Go rewrite** (TS line legacy) | Yes, MIT | `npx reasonix code` wizard; `~/.reasonix/config.json`; **DeepSeek-only, multi-provider BYOK is a non-goal** |
| **Qoder** | *maker not established* (site footer: Bright Zenith Pvt Ltd) | macOS 12+/Win 10+/Linux; CLI; JetBrains | [U] | [U] | Built-in models use Qoder Credits; **BYOK (Personal only)**: IDE → Settings → Models → Add → DeepSeek; CLI `/model → Custom` |
| **WorkBuddy/CodeBuddy** | Tencent | Windows + macOS | Electron + CodeBuddy CLI | No | `.codebuddy/models.json` (above) |

**Notes / drift found** [P]
- **OpenClaw is huge and real**: MIT, ~390k★ / 82k forks, Gateway control plane, 20+ chat
  channels, models + **agent harnesses (Claude, Codex, local) as swappable plugins**, state stays
  local. Stewarded by the OpenClaw Foundation (OpenAI is a donor, not an owner). Peter Steinberger
  credited. This is arguably the most important item in this section.
- **Hermes = Nous Research's Hermes Agent**, not a Nous model. Model-agnostic, self-improving,
  persistent memory, subagents, MCP, terminal backends.
- **Reasonix is DeepSeek-only by design** — optimized for prefix caching and Flash-first cost.
- **Model-name drift** across DeepSeek docs: main page says `deepseek-flash`, individual guides
  still say `deepseek-v4-flash`/`deepseek-v4-pro`; `deepseek-v4-flash` is a legacy accepted alias.
- **Qoder is NOT confirmed to be Alibaba** — the footer names Bright Zenith; don't label it so.
- DeepSeek's `awesome-deepseek-agent` list also covers: AstrBot, Cherry Studio, Cline, Crush,
  Deep Code, DeepSeek-TUI, Copilot CLI, Kilo Code, LobeHub, nanobot, OpenCode, Qwen Code, etc.

---

## 1.8 Sources

### T3 Code

1. https://github.com/pingdotgg/t3code
2. https://t3.codes/
3. https://raw.githubusercontent.com/pingdotgg/t3code/main/README.md
4. https://raw.githubusercontent.com/pingdotgg/t3code/main/docs/internals/overview.md
5. https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/builtInDrivers.ts
6. https://github.com/pingdotgg/t3code/issues/3571

### OpenCode v2

7. https://opencode.ai/v2/
8. https://opencode.ai/v2/docs/migrate-v1
9. https://opencode.ai/v2/docs/providers/
10. https://opencode.ai/v2/docs/config/
11. https://opencode.ai/v2/docs/cli/acp
12. https://opencode.ai/v2/docs/lsp
13. https://raw.githubusercontent.com/anomalyco/opencode/v2/package.json
14. https://github.com/charmbracelet/crush

### ZCode
15. https://zcode.z.ai/en
16. https://zcode.z.ai/en/docs/install
17. https://zcode.z.ai/en/docs/configuration
18. https://zcode.z.ai/en/docs/agent-framework
19. https://zcode.z.ai/en/docs/subagents
20. https://zcode.z.ai/en/docs/mcp-services
21. https://zcode.z.ai/en/changelog
22. https://docs.z.ai/devpack/tool/zcode
23. https://docs.z.ai/devpack/tool/claude
24. https://github.com/kingsword09/zcode-cli · https://github.com/yangmain/zcode-acp

### WorkBuddy
25. https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy/
26. https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model
27. https://www.workbuddy.ai/docs/workbuddy/pricing · https://www.workbuddy.ai/docs/workbuddy/credits
28. https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide
29. https://www.workbuddy.ai/docs/cli/overview

### First-party apps
30. https://developers.openai.com/codex/config-advanced · https://openai.com/codex
31. https://docs.anthropic.com/en/docs/claude-code/llm-gateway
32. https://support.claude.com/en/articles/10065433-install-claude-desktop
33. https://antigravity.google/docs/models.md
34. https://geminicli.com/docs/reference/configuration
35. https://cursor.com/docs/settings/api-keys
36. https://docs.windsurf.com/windsurf/models

### Open-source harnesses
37. https://github.com/stravu/crystal · https://github.com/getAsterisk/claudia
38. https://github.com/BloopAI/vibe-kanban · https://github.com/smtg-ai/claude-squad
39. https://github.com/kbwo/ccmanager · https://github.com/winfunc/opcode
40. https://github.com/charmbracelet/crush · https://github.com/aaif-goose/goose
41. https://github.com/OpenHands/OpenHands · https://github.com/Aider-AI/aider
42. https://github.com/cline/cline · https://github.com/Kilo-Org/kilocode
43. https://github.com/continuedev/continue · https://github.com/voideditor/void
44. https://zed.dev/docs/ai/external-agents

### DeepSeek agents
45. https://api-docs.deepseek.com/quick_start/agent_integrations/openclaw
46. https://api-docs.deepseek.com/quick_start/agent_integrations/hermes
47. https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix
48. https://api-docs.deepseek.com/quick_start/agent_integrations/qoder
49. https://github.com/deepseek-ai/deepseek-harness
50. https://github.com/openclaw/openclaw
51. https://github.com/NousResearch/hermes-agent
52. https://github.com/esengine/reasonix

---

<a id="part-2"></a>

# Part 2 — Running other models (DeepSeek / BYOK)

How Claude Code, Codex and other harnesses are pointed at DeepSeek or any custom endpoint, what
breaks, and where the pieces meet.

---

## 2.1 DeepSeek / BYOK wrapping — Claude Code, Codex, and other harnesses

### Claude Code + DeepSeek — **officially documented by DeepSeek** [P] ✅ verified verbatim

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<DeepSeek API key>      # alternative: ANTHROPIC_API_KEY (x-api-key)
export ANTHROPIC_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

- `[1m]` selects 1M-context behavior; keep it. ✅
- **Claude Code Web Search works natively** through DeepSeek (extra token cost for result
  summarization). ✅
- If you *don't* override, DeepSeek maps `claude-opus*` → `deepseek-v4-pro`,
  `claude-sonnet*/haiku*` → `deepseek-flash`. ✅
- **Anthropic-side caveat** [P]: Anthropic's gateway docs explicitly say gateways must **not**
  route Claude Code to non-Claude models and are unsupported/unaudited. You're using
  DeepSeek's endpoint, not an Anthropic-blessed path.
- Same pattern also works for Z.ai (`api.z.ai/api/anthropic`), Kimi/Moonshot, MiniMax.
  Community wrappers: LiteLLM, OpenRouter, claude-code-router, New API, one-api [S].

### OpenAI Codex CLI + DeepSeek — **officially documented** [P] ✅

- Codex talks **Responses API**, which DeepSeek natively supports (no Chat-Completions proxy
  needed).
- DeepSeek ships a one-click setup script that writes `~/.codex/models.json` (model catalog)
  and edits `~/.codex/config.toml`, backing up first.
- Provider block shape: `model_provider = "deepseek"`, `[model_providers.deepseek]` with
  `base_url`, `wire_api = "responses"`, `env_key = "DEEPSEEK_API_KEY"`.
- **Important**: provider/auth settings must live in **user-level `~/.codex/config.toml`** —
  project-local config cannot override `model_provider`/`model_providers`.
  `wire_api = "responses"` is now the only supported value (old `"chat"` guides are obsolete).

### Other harnesses with DeepSeek/BYOK [P]

**First-class DeepSeek:** OpenCode, Aider, Cline, Kilo Code, Goose (`custom_deepseek`), Zed.
*Status caveat (see §1.6):* **Roo Code** was archived 2026-05-15 and **Continue** is read-only/
unmaintained — they still document DeepSeek providers but are no longer actively developed.

**Generic OpenAI-compatible:** Crush (`type: "openai-compat"`), plus the above via base URL.

**Cursor:** official BYOK covers OpenAI/Anthropic/Google/Azure/Bedrock — **not DeepSeek or
arbitrary base URLs**; community overrides exist but are undocumented. [U]

### "DeepSeek Harness" (`dsh`) — it's a real product, not just a phrase [P]

DeepSeek's own open-source developer-preview harness: CLI `dsh`, Cordis plugin architecture,
**Web UI**, live model-route switching without restart, workspace selection + permission
approvals, file edit / command execution / planning / **delegation**, Python SDK,
headless/automation + ACP interfaces, and **custom OpenAI-compatible providers** (so it isn't
DeepSeek-only). "AI harness" separately remains a generic term.

### Compatibility caveats

1. **Protocol is the first wall** — Claude Code = Anthropic Messages, Codex = Responses. A
   Chat-Completions-only endpoint can't be labeled `wire_api = "responses"`.
2. Tool calling works, but adapters are brittle (Codex strict-schema `oneOf` rejections,
   missing `call_id` on function outputs).
3. Reasoning state must be preserved across turns in multi-turn adapters.
4. DeepSeek **ignores `anthropic-beta` / `anthropic-version` headers** — don't assume Anthropic
   prompt caching or beta blocks.
5. Caching is DeepSeek-specific (prefix cache, cache-hit vs miss billing) ≠ Anthropic
   `cache_control`.
6. Tokenization differs — that's why DeepSeek's Claude setup uses `[1m]` + a 786,432
   auto-compact threshold.

### DeepSeek official API [P]

- OpenAI-compatible base: `https://api.deepseek.com`
- Anthropic-compatible: `https://api.deepseek.com/anthropic`
- Endpoints: `/chat/completions`, `/responses`, `/completions` (FIM), `/models`, `/user/balance`.
- Models: **`deepseek-flash`** (V4.1-Flash, vision, 1M ctx, 384K out) and
  **`deepseek-v4-pro`** (no vision). Legacy `deepseek-v4-flash` names are accepted but retired.
- ⚠️ **Documentation conflict**: pricing page says `deepseek-v4-pro` = V4-Pro-0813, but a
  2026-09-10 release note said it would switch to V4.1-Flash on 2026-09-14 pending V4.1-Pro.
  Treat the exact backend behind that slug as **unclear** until `/models` or response metadata
  confirms.

---

## 2.2 How it all fits together

```
Claude Code ──ANTHROPIC_BASE_URL──▶ DeepSeek /anthropic   (official)
Codex CLI   ──Responses wire_api──▶ DeepSeek /responses   (official)
OpenCode v2 ──/connect deepseek───▶ DeepSeek             (official, first-class provider)
T3 Code     ──drives all of the above as subprocesses/SDKs──
              └─ DeepSeek only *indirectly*, via OpenCode's provider config
```

- **OpenCode v2** is a full harness with its own OpenAI-compatible/BYOK provider system and a
  first-class DeepSeek path.
- **T3 Code** is a *control surface* that wraps Claude Code, Codex, OpenCode, Cursor, Grok,
  Antigravity — it has no native DeepSeek/BYOK driver, so you'd run DeepSeek by configuring it
  upstream in one of those harnesses (most naturally OpenCode).
- **DeepSeek** itself now publishes official integration docs for Claude Code, Codex, and
  OpenCode, plus its own `dsh` harness.

---

## 2.3 Sources

1. https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/
2. https://api-docs.deepseek.com/quick_start/agent_integrations/codex
3. https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/
4. https://api-docs.deepseek.com/quick_start/pricing/
5. https://api-docs.deepseek.com/news/news260910
6. https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart
7. https://github.com/deepseek-ai/deepseek-harness
8. https://developers.openai.com/codex/config-reference
9. https://code.claude.com/docs/en/llm-gateway.md
10. https://github.com/musistudio/claude-code-router
11. https://docs.litellm.ai/docs/proxy/client_setup/claude_code
12. https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration

---

<a id="part-3"></a>

# Part 3 — Agent switching & context portability

How harnesses abstract over Codex / Claude / OpenCode / ACP, and whether a conversation survives
switching agents — with a source-level teardown of T3 Code (MIT).

---

## TL;DR

1. A harness that drives many agents keeps **two separate layers**: a **durable canonical thread**
   (its own event log + read model) and a **disposable provider session** (the native agent
   runtime, identified by an opaque `resumeCursor`).
2. Over the wire, every agent's native protocol is normalized at an **adapter boundary** into one
   canonical event vocabulary. Upstream (orchestration/UI) never branches on "is this Claude or
   Codex".
3. **Switching agents mid-conversation is NOT solved anywhere today** — not in T3, not via ACP.
   ACP only lets a *different client* drive the *same* agent's session. T3 explicitly rejects
   changing a thread's driver kind.
4. What *does* port is **instructions** (`AGENTS.md`/`CLAUDE.md`), **tools** (MCP), and
   **importable transcripts** (lossy, text-only, marked). Conversation *context* — reasoning
   blocks, tool-call schemas, approvals, caches, tokenizer state — does not port.
5. The workable design is **"import → validate → new agent session"**, never "reuse a universal
   session ID".

---

## Part A — How T3 Code abstracts over different agents (source-level)

### A1. The mental model

```
Client (web/desktop/mobile)
   │  RPC (packages/contracts/src/rpc.ts)
   ▼
Orchestration  ── commands/events/read model ──►  UI + SQLite
   ▲                                        (never knows the provider)
   │  normalized ProviderRuntimeEvent
Adapter boundary  ◄──────── native protocol ───────  Claude Agent SDK
   │                                                  Codex app-server
   │                                                  ACP (Cursor/Grok/Antigravity)
   │                                                  OpenCode SDK
   ▼
Provider instance (account + process + credentials)
```

> Design rule, verbatim from `docs/internals/providers.md`:
> *"Orchestration records intent and state without knowing which provider runs a thread.
> Provider protocols, account ownership, permissions, and capabilities belong at the adapter
> boundary. Normalize there instead of spreading provider checks through reactors and clients."*

### A2. The canonical type vocabulary

Everything an agent does is folded into one of these. This is the actual "portability" surface.

| Layer | Type | File |
|---|---|---|
| Session | `ProviderSession` (`threadId`, `provider`, `providerInstanceId`, `status`, `runtimeMode`, `cwd`, `model`, `resumeCursor`, `activeTurnId`) | `packages/contracts/src/provider.ts:35-118` |
| Native envelope (intermediate) | `ProviderEvent {id, kind: session\|notification\|request\|error, method, message, turnId, itemId, requestId, textDelta, payload}` | `packages/contracts/src/provider.ts:143-162` |
| **Canonical runtime event** | `ProviderRuntimeEvent` (`eventId`, `provider`, `threadId`, `turnId`, `itemId`, `requestId`, `providerRefs`, `raw`) | `packages/contracts/src/providerRuntime.ts:202-1234` |
| Canonical item types | `CanonicalItemType`: `user_message`, `assistant_message`, `reasoning`, `plan`, `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `collab_agent_tool_call`, `web_search`, `image_view`, review/compaction/error | `providerRuntime.ts:106-135` |
| Canonical request types | `CanonicalRequestType`: `command_execution_approval`, `file_read_approval`, `file_change_approval`, `apply_patch_approval`, `exec_command_approval`, `mcp_elicitation_approval`, `permission_approval`, `tool_user_input`, `dynamic_tool_call`, `auth_tokens_refresh` | `providerRuntime.ts:137-150` |
| Streaming content | `content.delta` + `ContentDeltaPayload.streamKind` = `assistant_text`/`reasoning_text`/`reasoning_summary_text`/`plan_text`/`command_output`/`file_change_output` | `providerRuntime.ts:83-92,451-457` |
| Persisted message | `OrchestrationMessage {role, text, attachments?, context?, turnId, streaming, createdAt}` | `packages/contracts/src/orchestration.ts:563-585` |
| Persisted activity | `OrchestrationThreadActivity {tone: info\|tool\|approval\|error, kind (open string), summary, payload, turnId, sequence?}` | `orchestration.ts:653-671` |
| Permissions | `RuntimeMode` = `approval-required` \| `auto-accept-edits` \| `auto` \| `full-access`; decisions = `accept`/`acceptForSession`/`acceptAlways`/`decline`/`cancel` | `orchestration.ts:46-161` |
| Model selection | `ModelSelection {instanceId, model}` + `ModelCapabilities`, `ProviderOptionDescriptor` | `orchestration.ts:60-126`, `model.ts:7-53` |

Notice what is **deliberately absent**: there is no cross-provider `MessagePart` union. Provider
tool arguments/results stay inside `data`/`raw` rather than being promoted to a second public
tool-call type. That is the key trick — **normalize the shape, don't translate the payload.**

### A3. The adapter contract (what any new agent must implement)

`ProviderAdapterShape` — `apps/server/src/provider/Services/ProviderAdapter.ts:67-158`:

- `startSession`, `sendTurn`, `interruptTurn`, `stopSession`, `stopAll`
- `respondToRequest` (approvals), `respondToUserInput` (questions)
- `listSessions`, `hasSession`, `readThread`, `rollbackThread`
- `streamEvents` (must emit only `ProviderRuntimeEvent`)
- `capabilities` — optional: `compaction`, `uploadFeedback`, `promptlessTurnContinuation`,
  `supportsConversationRollback`, and `sessionModelSwitch: "in-session" | "unsupported"`

Three-level distinction [P]:

| Concept | Meaning | Code |
|---|---|---|
| **Driver** | static integration for a provider kind (`driverKind`, `metadata`, `configSchema`, `defaultConfig`, `create`) | `ProviderDriver.ts:123-174` |
| **Provider instance** | one configured account/config + lifecycle; multiple instances per driver | `ProviderDriver.ts:58-91`, `providerInstance.ts` |
| **Adapter** | per-instance protocol boundary; owns session maps + native process state | `ProviderAdapter.ts` |

Routing key is `ProviderInstanceId`, not the provider kind — so two Codex accounts don't share
session state. Unknown driver kinds stay parseable and are marked unavailable rather than crashing.

### A4. How each native protocol maps to the canonical vocabulary

| Concern | Claude Agent SDK | Codex app-server | ACP (Cursor/Grok/Antigravity) |
|---|---|---|---|
| Text / reasoning | `content_block_delta` (`text_delta`/`thinking_delta`) → `content.delta`; thinking → `reasoning_summary_text` | `item/agentMessage/delta`, `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` → same kinds | `session/update` → `agent_message_chunk`/`agent_thought_chunk` → internal `ContentDelta`/`ThoughtDelta` |
| Tool call | `content_block_start` `tool_use`/`server_tool_use`/`mcp_tool_use` → `item.started`; `input_json_delta` → `item.updated`; `tool_result` → completed | `item/started`/`item/completed` + `item.type` → `toCanonicalItemType` | `session/update` `tool_call`/`tool_call_update` merged into `AcpToolCallState` |
| Approval / question | `canUseTool` → `request.opened`; `AskUserQuestion` → `user-input.requested` | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput` | `session/request_permission`, `session/elicitation` |
| Plan / todos | folded into `turn.plan.updated` | same | same |

Capability negotiation matters: Cursor/Grok/Antigravity advertise
`supportsConversationRollback: false`, so T3 rejects a revert *before* touching the filesystem.

### A5. The orchestration pattern worth stealing

`docs/internals/overview.md` + `Layers/`:

1. **Event log is the source of truth.** The `OrchestrationEngine` serializes commands; events,
   projections, and the accepted-command receipt commit in **one DB transaction** → idempotent
   retries.
2. **Decider is pure.** It turns a command into events and does **no** provider/filesystem I/O.
3. **Reactors do side effects after intent is recorded**, then feed results back as commands.
   So a command ack means *"intent committed"*, not *"the agent finished"*.
4. **Projector never parses native provider events.**
5. **Bound/coalesce noisy streams** before they become durable events (avoid O(N²) event growth).
6. **Persisted events must stay decodable on replay** — schema changes affect old environments at
   startup, not just live traffic.

This is CQRS/event-sourcing applied to agent orchestration, with the provider boundary as the
anti-corruption layer.

---

## Part B — Does context survive an agent switch?

### B1. T3 Code: what's actually implemented

**Persistence model** [P]

| What | Where | Notes |
|---|---|---|
| Canonical event log | SQLite `orchestration_events` | source of truth; append-only, sequencer, causation/correlation ids |
| Read model | `projection_threads`, `projection_thread_messages`, `projection_thread_sessions`, activities/turns/checkpoints/approvals | rebuildable from events |
| Provider binding | SQLite `provider_session_runtime` — one row per `thread_id`: `provider_name`, `provider_instance_id`, `adapter_key`, `runtime_mode`, `status`, `last_seen_at`, **opaque `resume_cursor_json`**, `runtime_payload_json` | `ProviderSessionRuntime.ts:36-53` |
| Native conversation | **stays in the provider's own home** (Claude JSONL, Codex rollouts). T3 does not copy it. | provider-owned |

**Resume lifecycle** [P]
1. User turn → event log records message + turn intent **before** provider I/O.
2. `ProviderCommandReactor.ensureSessionForThread` resolves adapter/instance/cwd/model/runtime mode;
   starts a session if none is live.
3. Adapter opens native session: Claude `resume` by SDK session id; Codex `thread/resume` (or
   `thread/start`); ACP `session/resume`/`session/load`; OpenCode by native `sessionId`.
4. Runtime output is normalized → events → commands; the binding's `resumeCursor` is upserted.
5. On process exit the thread/binding are **not** deleted; `recoverSessionForThread` adopts a live
   session or restarts from the persisted cursor.
6. If native resume fails, Codex falls back to a **fresh** `thread/start` — T3 history survives,
   **native provider context does not**.

**Agent switch — the honest answer** [P]

- **Cross-driver switch is not implemented.** `ensureSessionForThread` *rejects* changing a
  thread's driver kind; the error says the thread is bound to its current driver.
  (`ProviderCommandReactor.ts:680-701`)
- **Same-driver instance switching** works only if the new instance's `continuationKey` is
  compatible with the persisted native resume state (`CODEX_HOME` group for Codex, config-home
  group for Claude).
- **There is no generic history re-projection.** `startSession` receives a native resume cursor,
  **not** the T3 message history. A new provider session is never automatically fed prior messages;
  only the current prompt/attachments are sent.
- **The implemented workaround** is: create a new thread and carry text manually.
  `thread.history.import` is internal and accepts only user/assistant text.

**So: "Claude thread continued by Codex" is explicitly impossible today.** The supported answer is
*new thread + explicit context transfer*.

### B2. Transcript import (the closest thing to a handoff)

`AgentSessionScanner` / `AgentSessionImporter` [P] read native transcripts off disk:

- Claude: `~/.claude/projects/*/*.jsonl`; Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`.
- Deterministic ids: thread `import:<providerInstanceId>:<providerSessionId>`, messages
  `<threadId>:<index>` (recognizable via `isImportedAgentSessionMessageId`).
- The importer installs a **stopped binding** pointing at the native session, so the imported
  thread stays resumable *in its original provider*.
- Source fingerprint stored: path, size, mtime, device, inode, birthtime → re-import skips
  unchanged history.
- **Kept:** visible user/assistant text, timestamps, title/model (best effort), native pointer.
- **Lost:** tool calls/results, reasoning, approvals/questions, attachments/images/files, composer
  context/citations, system/meta/sidechain records, exact turn boundaries, checkpoints.
- Bounded: max **200 visible messages**, plus transcript/record/byte budgets.

### B3. Checkpoints ≠ conversation state

Checkpoints are **hidden Git refs** capturing workspace state (`CheckpointStore`), explicitly
*not* conversation metadata. A revert must coordinate both: T3 preflights
`assertConversationRollbackSupported`, restores the Git workspace, then calls provider-native
rollback (Claude `forkSession`, Codex `thread/revert`, OpenCode `session.fork`). Providers that
can't roll back their conversation are rejected **before** any file changes.

---

## Part C — How the wider ecosystem handles it

### C1. ACP (Agent Client Protocol) — the standard, and its limits [P]

- **v1 session methods:** `session/new`, `session/load`, `session/resume`, `session/list`,
  `session/close`; `session/fork` is an **unstable draft**.
- **v2 draft:** drops `session/load`; `session/resume` with `replayFrom: {"type":"start"}` does
  the old load/replay; omitting `replayFrom` restores without replay.
- **What it enables:** a *different client* drives the *same agent's* session — the client replays
  user/agent/thought content, tool calls/results, plans, file locations/diffs as normalized
  `session/update` notifications.
- **What it does NOT do:** there is **no transfer to a different agent**, no standard import/export,
  no globally portable session id. `session/fork` = another session *in the same agent*.
- **Not portable via ACP:** system prompt, hidden reasoning, tokenizer state, prompt cache,
  filesystem state, native tool ids, credentials, prior permission grants.

### C2. Built-in resume, per agent

| Agent | Resume mechanism | Storage |
|---|---|---|
| Codex | `codex resume [ID]`, `resume --last`, `codex exec resume`, `codex fork` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `state_*.sqlite` |
| Claude Code | `--continue`, `--resume [ID\|NAME\|PATH]`, `--fork-session`, `/branch` | `~/.claude/projects/<project>/<session-id>.jsonl` (internal, versioned) |
| OpenCode | native `sessionId` via SDK/ACP; model change via `session/set_config_option` | OpenCode session storage |
| Crush | `crush run --session` bridged by community `crush-acp` | Crush native session |

Codex note: switching **model within the same provider** reuses thread history; switching
`model_provider` is described by maintainers as **risky**, and the guidance is effectively
*one model per thread* — a new thread is the safe handoff boundary. [S]

### C3. File-based memory is the real portable layer

| File | Carries | Does not carry |
|---|---|---|
| `AGENTS.md` | project instructions, commands, architecture, conventions ("closest file wins") | messages, tool results, model state, approvals, cache |
| `CLAUDE.md` | same + scoped rules + machine-local auto memory; Claude Code can read `AGENTS.md` natively | conversation history |
| `GEMINI.md` | hierarchical + just-in-time loading, `@file` imports; `context.fileName` can select `AGENTS.md` | conversation history |
| `.cursor/rules/*.mdc` | always-on / glob-scoped / model-selected / manual rules | conversation history |

**MCP** carries tools, resources, prompts, and (via memory servers) durable semantic memory —
but it is **stateless per request** and defines no transcript, reasoning, approval, or session
continuation semantics.

### C4. Peer tools: who owns the transcript

| Tool | Transcript owner | Cross-agent switch? | Mechanism |
|---|---|---|---|
| T3 Code | T3 owns thread; provider owns native session | **No** (explicitly rejected) | adapter `resumeCursor` + lossy import |
| OpenCode | OpenCode | No cross-harness handoff; model can change within OpenCode | native sessions via SDK/ACP |
| Zed external agents | External agent owns runtime; Zed owns UI/thread metadata | No same-thread transfer | ACP process boundary; imported threads reopen the original agent's session |
| OpenHands | Canvas orchestrates; ACP agent owns execution | No — setting changes affect **new** conversations | ACP `ACPAgent` |
| Vibe Kanban | Kanban owns attempt metadata; agent owns session history | No live migration | resumes each agent's own session id |
| Claude Squad / CCManager / opcode / Claudia | Underlying CLI owns session | No | launch + inherit creds |
| Crush / Goose | Own native session | No cross-harness | native + ACP adapter |

**Conclusion: nobody has cross-agent context portability.** The state of the art is *parallel
sessions* + *shared files* + *lossy import*.

---

## Part D — Why context isn't portable (the concrete blockers)

1. **No universal transcript schema.** ACP normalizes the *client UI*, not every provider's native
   request/response schema.
2. **Different tool-call protocols.** Anthropic `tool_use`/`tool_result` blocks vs OpenAI
   function/response items vs Gemini function calls vs shell/apply-patch variants — different call
   ids, schemas, and error encodings.
3. **Reasoning is provider-bound.** Opaque/encrypted reasoning items may be unusable elsewhere; a
   `thought_chunk` event cannot recreate hidden provider state.
4. **System prompts + tool definitions differ.** Restoring messages without the original harness
   prompt, built-in tools, policy layers, skills, and MCP wiring yields a *different agent*.
5. **Tokenizers, context windows, and compaction differ.** Content must be re-counted, re-chunked,
   often re-summarized.
6. **Prompt caches don't migrate.** They're model/provider-specific and ephemeral → a handoff pays
   full reprocessing cost.
7. **Approvals can't be transplanted.** Tool names, sandbox policy, allowed paths, credentials,
   and "allow always" scopes differ — old approvals may authorize a *different* action.
8. **Conversation ≠ workspace or side effects.** Rollouts don't capture uncommitted files,
   processes, DBs, or network mutations unless separately checkpointed.
9. **Attachments expire / are unreachable.**
10. **Persistence formats are private and versioned.** Claude explicitly warns its JSONL is
    internal and may change.

---

## Part E — Blueprint: a context-portable harness

If you were to build this (combining T3's structure with the handoff gaps):

1. **Two layers, always.** Durable canonical thread/event log (append-only, versioned, replayable)
   + disposable provider session keyed by opaque cursor. Never conflate them.
2. **Adapter/anti-corruption boundary.** One canonical event vocabulary; provider checks live only
   in adapters. Keep raw native envelopes alongside normalized events for diagnosis.
3. **Stable semantic ids** for messages, tool calls, approvals, plans, artifacts, compaction nodes
   — with **provenance** (source agent/model/provider) on every event.
4. **Model handoff as `import → validate → new agent session`.** Never reuse a "universal" session
   id. Never re-execute side-effecting tool calls during import — carry results + provenance.
5. **Capability matrix + explicit loss report.** Reject/omit unrepresentable reasoning, permission,
   tool, and content fields rather than silently guessing.
6. **Structured handoff checkpoint** before any switch: decisions made, open work, changed files,
   commands run, artifact references, unresolved questions — tokenized to the target's budget.
7. **Reset trust on handoff:** permissions, cwd trust, credentials, sandbox state. Treat prior
   approvals as *evidence, not authority*.
8. **Separate external memory** (MCP memory server or file-based `AGENTS.md`) with scope,
   provenance, TTL, and deletion — and don't mistake retrieval for transcript continuity.
9. **Version persisted schemas; guarantee replay** of old events/downgrades (attachments and
   message shapes are the usual breakage).
10. **Bound everything:** message windows, activity windows, import caps, stream coalescing.

Use **ACP** for normalized agent↔client lifecycle, **MCP** for tools/resources/memory, and
**`AGENTS.md`** for portable instructions — but accept that none of them solves conversation
transfer. That requires a purpose-built canonical-history handoff protocol, which **no shipping
harness currently provides**.

---

## Sources

**T3 Code (local clone, MIT):**
- `docs/internals/providers.md`, `docs/internals/overview.md`, `docs/internals/glossary.md`,
  `docs/internals/model-manifest.md`
- `packages/contracts/src/provider.ts`, `providerRuntime.ts`, `orchestration.ts`, `agentSessions.ts`,
  `providerInstance.ts`, `model.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`, `ProviderAdapterRegistry.ts`
- `apps/server/src/provider/ProviderDriver.ts`, `Layers/ProviderService.ts`,
  `Layers/ProviderCommandReactor.ts`, `Layers/ClaudeAdapter.ts`, `Layers/CodexAdapter.ts`,
  `Layers/CodexSessionRuntime.ts`, `acp/AcpRuntimeModel.ts`, `acp/AcpSessionRuntime.ts`
- `apps/server/src/orchestration/Normalizer.ts`, `decider.ts`, `projector.ts`,
  `Layers/OrchestrationEngine.ts`, `Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/project/AgentSessionScanner.ts`, `AgentSessionImporter.ts`
- `apps/server/src/persistence/ProviderSessionRuntime.ts`,
  `apps/server/src/checkpointing/CheckpointStore.ts`,
  `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- https://github.com/pingdotgg/t3code

**Protocols & agents:**
- https://agentclientprotocol.com/protocol/v1/session-setup · /v2/migration · /rfds/session-fork
- https://developers.openai.com/codex/cli/reference
- https://code.claude.com/docs/en/sessions · /context-window · /memory · /prompt-caching
- https://agents.md/
- https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- https://zed.dev/docs/ai/external-agents
- https://github.com/anomalyco/opencode · https://github.com/charmbracelet/crush
- https://github.com/openai/codex/issues/9054 (cross-provider) · /issues/15494 (provider/session)

---

<a id="appendix"></a>

# Appendix — Reliability & method

- ✅ **Personally re-fetched and confirmed:** the T3 README/repo (harness list, "control
  surface" wording, alpha status), the DeepSeek Claude Code page (exact env vars, web search,
  model mapping), the DeepSeek Codex page (setup script, Responses API), the DeepSeek OpenCode
  page (`/connect` flow, ≥ v1.18.30), and that `opencode.ai/v2/` exists.
- **[U] unverified directly:** exact T3 custom-BYOK schema, T3 plugin/subagent status, the
  SST/Charm dispute (none found), and opencode v2's formal release-vs-beta status.
- Treat version numbers and pricing as time-sensitive; tooling here changes fast.
- The phrase "t3 code deepseek harness Opencode v2" does not correspond to one single named
  product — it maps to three separate things (T3 Code, DeepSeek Harness/`dsh`, OpenCode v2),
  which is how this document is organized.

---

