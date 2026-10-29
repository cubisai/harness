## 7. UI/UX for a Centralized Harness: Provider Registry Surface, Capability-Aware Affordances, Switch Contracts, Reasoning Display, and Cache Observability

**Thesis.** A centralized harness has a UI problem that a single-agent app does not: the interface must stay *one* interface while the thing behind it changes identity — different tool sets, different permission vocabularies, different model-switch semantics, different amounts of context that survive a switch. The current UI handles this by pretending the differences are cosmetic. `App.tsx` renders one agent `<select>` and one model `<select>` (`App.tsx:85-112`) whose `onChange` calls `updateThread` directly; `service.ts:78` then silently nulls `sessionId`, and the only trace is a `notice` row saying "It starts without the earlier messages above." That is a UI that lies by omission. This chapter specifies the surface for Milestone 4, under three rules that follow from the research in Chapters 1–6.

### 7.1 Three rules, derived from what the drivers can actually do

1. **Capability-driven, not agent-driven.** Affordances come from `driver.capabilities` (Ch. 2 §2.4), never from `driver.id === "claude"`. An unknown `agents.json` entry must render a *safe* UI — ask-mode permissions, warn-only guard, no harness tools — rather than half-wired controls.
2. **Never hide a control you cannot honor; disable it and say why.** Hiding creates the impression of parity. The ACP `mcpCapabilities.http` gate, for example, is invisible today: `forAcp` silently drops HTTP MCP servers — the user's own included — when the capability is absent (`src/main/mcp/servers.ts:159-165`, 本仓库源码), and the UI says nothing.
3. **Every state change that loses something names what it lost.** Ch. 3's loss report is not a tooltip; it is a card shown *before* the change, and a persistent marker left *after* it.

### 7.2 Settings → Providers (replaces the API-keys section)

The current section is a fixed list of three rows built from a constant `KEYS` array and a `SecretRow` component (`SettingsSheet.tsx:18-22`, `:125-136`, `:187-245`), with a `setSecret(id, value)` call per row. M4 replaces it with a **provider list + provider editor**:

- **List.** Each provider row: label, wire protocol chip (`anthropic-messages` / `openai-responses` / `openai-chat` / `gemini`), base URL host (never the full URL with credentials), model count, and a state dot — *not configured* · *saved* · *testing* · *ok* · *failed*. The existing `.dot-ok` / `.value` / `.button ghost danger` vocabulary (`SettingsSheet.tsx:230-241`) carries over unchanged.
- **Editor.** Fields in this order, because this is the order the failure modes appear in (Ch. 1 §1.4): protocol → base URL → credential → models. Include a **"Send the URL exactly as typed"** switch (the `pathMode: "raw"` escape hatch) with the help text explaining the 404 it prevents, and a **strip experimental headers** switch for gateways that reject `anthropic-beta`. Both are already-proven needs, not speculation — WorkBuddy ships an equivalent "自定义协议" toggle for exactly this reason.
- **Test connection** returns three lines, not one: *reachable*, *lists models*, *supports tool calling*. The third is the one that matters — an OpenAI-compatible endpoint that answers chat but cannot call tools must be reported as failing, because Ch. 2's parity promise depends on it. Failure text is the triage sentence, not a status code: "401 — the key reached the endpoint but was rejected. Claude uses `X-Api-Key` for `ANTHROPIC_API_KEY` and `Authorization: Bearer` for `ANTHROPIC_AUTH_TOKEN`; check which one your gateway expects."
- **Per-agent credential row.** Above the provider list, one row per *installed agent*: `Claude — [Subscription login | Provider ▾]`, `Codex — [Subscription login | Provider ▾]`, `DeepSeek/OpenCode/Cursor/Antigravity — [Agent's own config | Provider ▾]` (review: an ACP agent with no provider chosen keeps using its own login/config, as today). This is where the "subscription login stays a first-class peer" decision (Ch. 1 §1.2) becomes visible rather than a footnote, and where the warning belongs: choosing a provider for Claude disables Remote Control and MCP tool search on a non-first-party host (Ch. 1 §1.3).
- **Migration UX.** On first launch after upgrade, the three migrated secrets appear as providers named *"Anthropic (from your saved key)"*, *"DeepSeek (from your saved key)"*, *"OpenAI (from your saved key)"* with a one-line banner: "Your saved keys now live in Providers. Nothing was deleted." The `secrets.*` fields survive one release (Ch. 6 §6.4), so this is truthful.
- **Antigravity gate.** A disabled-by-default toggle with an inline acknowledgement — the ToS text quoted in Ch. 6 §6.6 — and, once enabled, a permanent amber chip on the agent row reading *Unsupported · Gemini-compatible endpoints only*. Never list Antigravity in the generic provider picker (Ch. 2 §2.3).

### 7.3 Thread header: the switch contract

The header today holds `LimitMeter`, `UsageMeter`, the agent select, the model select and the permission segmented control (`App.tsx:81-127`). Four changes:

- **Agent switch becomes a dialog, not a select.** Picking another agent opens a **Switch card** built from Ch. 3 §3.4's loss table: *Carries over* (visible messages, decisions, changed files, command results, workspace snapshot) and *Does not carry over* (reasoning, prompt cache, approvals, cwd trust). Two actions: **Hand off** (when a seeding channel exists for the target — `thread/inject_items`, or `noReply` once a native OpenCode driver exists, else the synthetic-first-message path) and **Start fresh**. A third, quiet action: **Switch back to Codex** when a `SessionBinding` still exists for it, because Ch. 3's whole point is that the old cursor is not thrown away.
- **Model switch declares its mode.** `applyModel()` returns `in-place | new-session | unsupported` (Ch. 3 §3.3b). In-place is silent. `new-session` shows the same card in a lighter variant ("This agent changes model by starting a new session; your last N tool results will be re-seeded"). `unsupported` disables the option with the reason in `title`.
- **Permission modes carry their driver's semantics.** The three buttons stay, but each gets a per-driver `title` from the capability descriptor: on Codex after the `untrusted` fix, Ask and Auto-edit both map to `on-request` + `workspace-write` (Ch. 2 §2.2), so the tooltip must say where the difference now lives — the harness asks per command in Ask, auto-approves edits in Auto-edit. And **Full** on a driver whose guard is warn-only gets a small warning glyph, because the guardrail stops being a guardrail there.
- **A third meter: cache.** `UsageMeter` sums `turn-end` events (`App.tsx:205-225`); add a `CacheMeter` reading Ch. 4's usage block — hit rate, cache-write spend, warm/cold with TTL. It follows the existing house style exactly: quiet until it has something to say (the `LimitMeter` hides below 50%), one number, detail in `title`. A miss badge names the likely cause in the same words Claude Code uses ("tool definitions changed") because that is the actionable part.

### 7.4 Conversation rendering

`ThreadView.tsx` switches on event kind (`:63-103`) and renders tool rows that pair a `tool-use` with its `tool-result` by `toolUseId` (`:19-23`, `:106-124`). The vocabulary extension in Ch. 5 adds rows and one structural fix:

- **Reasoning.** The current `<details className="thinking">` (`:79-85`) only ever receives a whole block at end of turn. It becomes a `ReasoningBlock` that streams `reasoning-delta` into a collapsed body, shows a live "reasoning…" state, and — when the stream is opaque (encrypted or signature-carried) — shows a token counter from `thinking-progress` instead of an empty box (Ch. 5 §5.6's mutual-exclusion rule). Default collapsed; auto-expand only while it is the newest thing on screen. A "Show reasoning" preference lives in Settings.
- **Tool output.** `ToolRow` gains an expandable body for `tool-output-delta` — command output streaming under the row it belongs to, capped and scrollable. The file-link behaviour on `Read`/`Edit`/`Write` rows (`:109-120`) stays as-is; it is already the best part of this view.
- **New rows.** `plan` (a checklist that updates in place), `compaction` (a divider: *Context compacted · 12.4k → 4.1k tokens*, because a compaction is the moment the cache restarts and the user should see it), `handoff` (a provenance card: "Seeded from Codex · 14 tool results · reasoning not carried"), and a live `usage-update` ticker replacing the silent token counter.
- **The structural fix.** `store.ts:290-294` clears `liveText` on *any* stored non-`user` event, so today a mid-turn `thinking` or `tool-use` blanks the streaming bubble. Live state becomes per-item-keyed (`live: Record<itemId, string>`) and is cleared only by the matching terminal event. Deltas coalesce on a frame timer in `apply()` (`:297-299`) rather than appending one store write per token, and the streaming tail renders as plain text — markdown re-parses only terminal events (`markdown.tsx:14` currently re-parses the whole string per delta).

### 7.5 Permission card

`PermissionCard.tsx` is 25 lines and already has the right bones: `role="alertdialog"`, Deny / Always Allow / Allow Once, autofocus on the safe-permissive choice. Add three things: **who is asking and how long the grant lasts** (Claude writes a settings rule; OpenCode's `always` is session-scoped; ACP's `allow_always` lives in the agent process — Ch. 2 §2.2, so "Always" must be labelled *for this session* where that is the truth), **a distinct variant for a guardrail block** (not a question — an explanation, with no Allow button, because the harness already decided), and **keyboard shortcuts** (1/2/3) consistent with the palette's arrow-key model.

### 7.6 Library: the capability matrix as a user-facing screen

The Agents tab currently renders installed/not-installed cards with a `skills`/`mcp` string and a copyable install command (`Library.tsx:315-332`). That is the natural home for Ch. 2's matrix, in user language: per agent, chips for *guardrails: block / warn-only*, *MCP over HTTP: yes / no*, *model-invoked skills: plugin / extra folder / project folder*, *fork & rollback: yes / no*, *compaction: yes / no*. Plus an explicit **"What this agent can't do here"** list — the honest inverse, which is the whole reason the matrix exists. The Skills tab already shows per-agent routing (`r.how`, `Library.tsx:484`); extend it to say *why* when the answer is "not reachable".

### 7.7 Command palette

Add: *Switch agent…*, *Switch model…*, *Add provider…*, *Open providers*, *Toggle reasoning*, *Compact now*. The palette already covers agent/model/theme/permission (`README.md`), so these are additive entries, not a new surface.

### 7.8 States and microcopy

Every one of these must have a name, a cause, and a next action — the repo's existing `.notice` / `.error-card` vocabulary is enough for all of them: provider not configured (→ open Providers), agent not installed (→ copy install command), model not offered by this provider, credential rejected 401/404/400 (→ triage sentence), session lost on resume (→ "start fresh or hand off"), guardrail blocked (→ who blocked it), guard degraded to warn-only, cache cold, rate limit reached. Microcopy rule: **never promise continuity the harness cannot deliver**; the current "It starts without the earlier messages above" is replaced by a specific, generated sentence naming what carried over.

### 7.9 Design-system constraints

No component library, system fonts, CSS tokens in `styles/app.css`, light/dark via `data-theme` (`store.ts:92-101`). New components must reuse the existing class vocabulary — `.sheet`, `.segmented`, `.row`/`.label`/`.value`, `.button` (+`ghost`/`primary`/`danger`), `.notice`, `.tool-row`, `.dot`, `.chip` — rather than inventing a parallel one. Accessibility patterns already in the codebase are the standard: `role="dialog"` + `aria-modal` on sheets, `role="alertdialog"` on permission cards, `role="radiogroup"`/`aria-checked` on segmented controls, `role="status"` on notices, `role="listbox"`/`aria-selected` on the skill menu. Keep keyboard-first behaviour and the 3.5 s auto-dismiss `Notice` (`store.ts:120-124`) for transient messages only — anything the user must act on gets a card, not a toast.

### 7.10 File manifest and anti-goals

**New:** `ProviderSheet.tsx` (list + editor + test result), `SwitchDialog.tsx` (agent/model switch contract), `ReasoningBlock.tsx`, `ToolOutput.tsx`, `CacheMeter.tsx`, `HandoffCard.tsx`, `CompactionDivider.tsx`.
**Modified:** `App.tsx` (header, meters, switch dialog), `ThreadView.tsx` (new rows, live state), `SettingsSheet.tsx` (Providers replaces API keys), `PermissionCard.tsx` (scope, guard variant, keys), `Library.tsx` (capability matrix, unreachable reasons), `store.ts` (per-item live state, delta coalescing, provider/switch state), `app.css` (new classes on the existing tokens), `markdown.tsx` (plain-text streaming tail).

**Anti-goals.** No per-agent settings pages — one provider registry, one switch contract. No hiding capability gaps behind a spinner. No fake progress bars for opaque reasoning; show the token count or nothing. No modal chains: the switch contract is one card, and its "what's lost" list is static text, not a second dialog. And no agent branding that implies the four drivers are interchangeable — the whole design earns trust by being specific about where they are not.

### 本章新增来源清单

1. Local repository (verified in-place, 2026-09): `src/renderer/src/App.tsx:81-127,205-258`, `components/ThreadView.tsx:19-23,63-124`, `components/SettingsSheet.tsx:18-22,125-136,187-245`, `components/PermissionCard.tsx`, `components/Library.tsx:250,315-332,484`, `store.ts:92-101,120-124,290-294,297-299`, `markdown.tsx:14`, `src/main/mcp/servers.ts:159-165`, `src/main/service.ts:78`.
2. [Anthropic — Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) — `thinking_delta` / `signature_delta` semantics behind the reasoning block. `[P]`
3. [Claude Agent SDK — Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output) — partial-message deltas; subagent deltas not forwarded. `[P]`
4. [codex app-server protocol v2 schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json) — `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta`, `thread/compacted`, `contextCompaction` item. `[P]`
5. [Agent Client Protocol — Prompt Turn (v1)](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) — `agent_thought_chunk`, `tool_call_update.content`, `usage_update`. `[P]`
6. [OpenCode — Permissions](https://dev.opencode.ai/docs/permissions/) — session-scoped `always`, which the permission card must state. `[P]`
7. [ACP v1 — Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) — `allow_always` lives in the agent process, not the client. `[P]`
8. [Google Antigravity — Terms of Service](https://antigravity.google/terms) — §6, the acknowledgement gate. `[S]`
9. [WorkBuddy — 模型配置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) — the "custom protocol" toggle that motivates the raw-path switch. `[P]`
