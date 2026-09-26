# AI Harness Milestone 4: One Centralized Harness — BYOK Provider Registry, Four-Agent Parity, Context Survival, Cache Discipline, and Streaming Transparency

**Date:** 2026-09-25
**Execution mode:** Complete (deep research per chapter, with an independent review pass)
**Subject:** `aiharness` / "UnSkilled" — Electron 44 + React 19 + TypeScript desktop coding-agent harness (MIT), repo `/Users/phumrin/Documents/ai-agent/aiharness`
**Depth:** Architecture + file-level specification (named files, TypeScript interfaces, protocol fields, env vars, migration steps — not full code bodies)

---

## 目录

- [Introduction](#introduction)
1. [Centralized BYOK Provider Registry: Unified Provider Schema, Secret Storage Migration off `SecretName`/`SECRET_ENV`, and Per-Agent Credential Injection](#1-centralized-byok-provider-registry)
2. [Four-Agent Capability Parity: Tool Calling, Coding, Skills/Plugins, MCP, and Permission-Hook Gap Closure for Claude, Codex, Antigravity, and OpenCode](#2-four-agent-capability-parity)
3. [Context Survival Across Model and Agent Switches: Thread/Session Identity, Handoff Seeding via `thread/inject_items` and `noReply`, and Honest Degradation Contracts](#3-context-survival-across-model-and-agent-switches)
4. [Cache Hit-Rate Engineering: Prefix Stability Discipline, Extending `ThreadEvent` Usage with Cache Dimensions, Per-Vendor TTL/Invalidation Matrix, and Compaction Policy](#4-cache-hit-rate-engineering)
5. [Streaming and Reasoning Transparency: Extending the Canonical ThreadEvent Vocabulary with Incremental Deltas and Per-Driver Event Mapping](#5-streaming-and-reasoning-transparency)
6. [Milestone 4 Roadmap: File-Level Change Manifest, Migration Sequencing, Test and Smoke Plan, and Irreversible Risk Points](#6-milestone-4-roadmap)
7. [UI/UX for a Centralized Harness: Provider Registry Surface, Capability-Aware Affordances, Switch Contracts, Reasoning Display, and Cache Observability](#7-uiux-for-a-centralized-harness)
8. [Interaction Mechanics: Resizable Panels, Collapse, the Built-in Browser and the Agent Driving It, and One Rendering Contract for Four Agents](#8-interaction-mechanics)
9. [Refining the Current UI Toward WorkBuddy and T3 Code: Shell Regions, Thread Lifecycle, an Inbox, Composer Chips, and a Settings IA](#9-refining-the-current-ui)
10. [Context Survival Without Bloat: Memory Scopes, Idempotent Injection, Tool-Call Deduplication, and Token Accounting on Model and Provider Switch](#10-context-survival-without-bloat)
- [Conclusion](#conclusion)
- [References](#references)
- [待完善事项 / Open items](#待完善事项--open-items)

---

<a id="introduction"></a>

## Introduction

UnSkilled is already a *centralized* harness in the only sense that matters structurally: one `AgentDriver` interface, one canonical event vocabulary, one UI — with Claude (Agent SDK), Codex (`codex app-server`), and any ACP-speaking agent (DeepSeek `dsh`, Antigravity via `agy-acp`, OpenCode, Cursor) behind it (`src/main/agents/types.ts`; [HARNESS.md](HARNESS.md)). What it does not yet have is centralized *identity*: credentials are three hardcoded secrets — `anthropic`, `deepseek`, `openai` — mapped by a hand-written `SECRET_ENV` table into process environment variables (`src/main/settings.ts`). That table cannot express a wire protocol, a base URL, a per-provider header, a model capability set, or a retry policy — the exact dimensions on which these four agents disagree. Pointing the harness at a gateway, a self-hosted endpoint, or a DeepSeek-compatible proxy today means editing code, not settings.

The same gap appears at every layer above it. Switching a thread's agent sets `sessionId: null` (`src/main/service.ts:78`), which silently discards the provider cursor and starts a fresh conversation — so "Codex → Claude" loses everything, even though both agents keep their own transcripts on disk. Reasoning is buffered rather than streamed: Claude's `thinking_delta` is filtered out, Codex's `item/reasoning/textDelta` is never handled, and ACP's `agent_thought_chunk` is accumulated until the turn ends. Cache economics are invisible: `turn-end` carries no cache dimensions at all, and Claude's `cache_read_input_tokens` is added *into* `inputTokens` (`src/main/agents/claude.ts:289`) — a double count that makes any hit-rate formula unknowable. And tool-set changes mid-conversation (the browser tools arrive only after the Browser tab opens) force Codex to `thread/unsubscribe` + `thread/resume` and ACP to `session/close` + `session/resume`, rewriting the entire prompt prefix at write prices.

This report is the plan to close all of that, grounded in primary sources — vendor documentation, protocol specifications, the Codex app-server JSON schema, and the installed SDK type definitions — plus a source-level reading of this repository. Ten chapters. The first six are in dependency order: the provider registry (Ch. 1); capability parity and the gaps that are genuinely unfixable (Ch. 2); context survival across model and agent switches, including the native seeding channels that make a real handoff possible (Ch. 3); cache hit-rate engineering, where prefix stability turns out to matter more than any tuning knob (Ch. 4); the event-vocabulary extension that makes streaming and reasoning displayable (Ch. 5); and the file-level roadmap, migration sequencing, test plan and irreversible risk points (Ch. 6). Chapters 7–10 were added later: the UI/UX surface (Ch. 7), interaction mechanics (Ch. 8), a refinement pass over the current UI (Ch. 9), and the token economics of a switch (Ch. 10). The executable breakdown lives in [`spec/`](../../spec/README.md).

One thesis runs through all of them: **the substrate has to be right before the features.** The event vocabulary and the usage fields are what every other change reads and writes. Land them first, and the rest is additive; land them last, and every adapter, loss report, and persisted row has to be migrated twice.

---


<a id="1-centralized-byok-provider-registry"></a>

## 1. Centralized BYOK Provider Registry: Unified Provider Schema, Secret Storage Migration off `SecretName`/`SECRET_ENV`, and Per-Agent Credential Injection

**Argument.** Today's credential surface — `SecretName = "anthropic" | "deepseek" | "openai"` plus a hand-written `SECRET_ENV` map in `src/main/settings.ts` — cannot satisfy the four-driver requirement. It hard-codes three vendors, cannot express a wire protocol, cannot declare model capabilities, and gives no place to hang per-provider headers, query params, retries, or base-URL path handling. Those are exactly the dimensions on which Claude Code, Codex, OpenCode, and Antigravity disagree. The fix is a single `Provider` record in the main process that every `AgentDriver` compiles into its own native config at run time.

### 1.1 The unified `Provider` schema

```ts
export type WireProtocol =
  | "anthropic-messages" | "openai-responses" | "openai-chat" | "gemini";

export interface ModelCapabilities {
  tools: boolean;      // required: gate tool-calling, see below
  vision: boolean; reasoning: boolean; promptCaching?: boolean;
}

export interface ProviderModel {
  id: string;                    // id shown in our picker
  modelID?: string;              // id actually sent on the wire, when it differs
  name?: string;
  capabilities: ModelCapabilities;
  contextWindow: number; maxOutput: number;
  alias?: "opus" | "sonnet" | "haiku";   // pins Claude alias slots
}

export interface ProviderSecret {
  kind: "safeStorage" | "envRef" | "command";
  ciphertext?: string;           // safeStorage blob, opaque
  envVar?: string;               // envRef: read from our own process env
  command?: string[];            // command: token fetcher (Codex-style)
}

export interface Provider {
  id: string;                    // stable slug; must avoid reserved ids (see 1.3)
  label: string;
  wireProtocol: WireProtocol;
  baseURL: string;
  secret: ProviderSecret;         // stored key OR env-var reference
  models: ProviderModel[];
  headers?: Record<string, string>;
  env?: Record<string, string>;   // extra vars injected into the agent process
  queryParams?: Record<string, string>;
  retries?: { request?: number; stream?: number; streamIdleTimeoutMs?: number };
  contextWindowOverride?: number;
  pathMode?: "auto" | "raw";      // escape hatch, see 1.4
  betaHeaders?: "default" | "strip";
}
```

Every field is forced by at least one real harness. Codex's `[model_providers.<id>]` requires `name`, `base_url`, `env_key`, and optionally `wire_api`, `http_headers`, `env_http_headers`, `query_params`, `request_max_retries`, `stream_max_retries`, and `stream_idle_timeout_ms` ([Codex advanced config](https://developers.openai.com/codex/config-advanced) [P]). OpenCode's `providers.<id>` requires `name`, `env` (ordered variable names), `package`, `settings` (including `settings.baseURL`), `headers`, `body`, and `models` — and for an OpenAI-compatible endpoint the model map must be declared explicitly because a custom provider has no Models.dev catalog entries, each entry carrying `capabilities.tools` and `limit.context` / `limit.output` ([OpenCode providers](https://dev.opencode.ai/v2/docs/providers/) [P]). Claude Code needs `baseURL` + a header-semantics choice, because `ANTHROPIC_API_KEY` is sent as `X-Api-Key` while `ANTHROPIC_AUTH_TOKEN` becomes `Authorization: Bearer` — two different headers, not aliases ([Claude Code env vars](https://docs.claude.com/en/docs/claude-code/env-vars) [P]). `wireProtocol` therefore is not cosmetic: it decides which path suffix, which request body, and which capability probes are legal. `alias` exists because Claude resolves `opus`/`sonnet`/`haiku` through `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`, and haiku additionally serves background tasks ([env vars](https://docs.claude.com/en/docs/claude-code/env-vars) [P]) — unpinned aliases drift and trigger premature compaction on unknown ids [S].

### 1.2 Storage and migration

Keep safeStorage. It already works, and moving the **ciphertext** (not the plaintext) between JSON fields is opaque-safe. Migration runs once on load: if `schemaVersion < 2` (an absent field counts as the legacy v1 shape) and any of `secrets.{anthropic,deepseek,openai}` exist, synthesize one `Provider` per stored key (`anthropic-messages`, `openai-chat`, `openai-chat` respectively) whose `secret.kind = "safeStorage"` and `secret.ciphertext` is byte-for-byte the existing blob. **Do not delete `secrets.*`** — leave it read-only for one release so downgrading to an older build still finds keys; write `migratedProviders: string[]` instead. Writes stay atomic: temp file in the same directory → `fsync` → `rename`, then `chmod 0600`. `view()` continues to return only "is it set", never the value.

UI evolution: replace `SettingsView.secretsSet: Record<SecretName, boolean>` with `providers: ProviderView[]` where `ProviderView` structurally omits `secret`; `SecretName` becomes a deprecated alias for `providerId`. `setSecret(name, value)` becomes `setProviderSecret(id, value)`.

**Keep subscription login as a first-class peer, not a replaced path.** The judgment criteria are empirical: (a) `ANTHROPIC_API_KEY` *overrides* a Claude Pro/Max/Team/Enterprise subscription, and setting only `ANTHROPIC_BASE_URL` without a gateway credential still leaves the saved login active ([env vars](https://docs.claude.com/en/docs/claude-code/env-vars) [P]); (b) pointing `ANTHROPIC_BASE_URL` at a non-first-party host disables Remote Control as of v2.1.196 and disables MCP tool search by default ([env vars](https://docs.claude.com/en/docs/claude-code/env-vars) [P]); (c) Anthropic states it "doesn't support routing Claude Code to non-Claude models through any gateway" ([Other LLM gateways](https://code.claude.com/docs/en/llm-gateway) [P]). So the credential union is `{kind:"byok"} | {kind:"subscription", agent:"claude"|"codex"}` — removing subscription login would destroy entitlements and features, which fails the "does removal break a paying user?" test. (Review note: ACP agents also need a non-BYOK default — "the agent's own login/config", e.g. `opencode auth login` or dsh's own key — otherwise an ACP agent with no provider selected has no valid credential state. And the migration must preserve today's effective behaviour: a saved `anthropic` key currently reaches Claude through `process.env`, overriding its subscription, so a user with that key keeps BYOK by default. See spec phase 1, T1.3–T1.4.)

### 1.3 Per-driver credential injection

**Claude** (`src/main/agents/claude.ts`). The Agent SDK's TypeScript `env` **replaces** the subprocess environment rather than merging it; you must spread `process.env` yourself or lose `PATH` and `HOME` ([Agent SDK configuration](https://code.claude.com/docs/en/agent-sdk/configuration) [P]). Set `ANTHROPIC_BASE_URL`, then the correct one of `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the three `ANTHROPIC_DEFAULT_*_MODEL` pins, and `ANTHROPIC_CUSTOM_HEADERS` as newline-separated `Name: Value` (requires Claude Code ≥ 2.1.227 [P]). Put `betaHeaders: "strip"` behind `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` only when the gateway is trusted, since it is off by default because shared-key gateways would otherwise expose every model ([env vars](https://docs.claude.com/en/docs/claude-code/env-vars) [P]). ~~Pass `settingSources: []` so user/project/local files cannot re-inject a stale key.~~ **Correction (review, verified against installed `sdk.d.ts:2176-2185`):** `settingSources: []` is "SDK isolation mode" — it disables *all* filesystem settings, and the option "must include `'project'` to load CLAUDE.md files". Today the driver omits it, which loads every source like the CLI. Passing `[]` would silently stop CLAUDE.md, the user's hooks, permissions and plugins from loading — a regression that also breaks Ch. 10 §10.2's premise that Claude loads its own conventions. Keep the default sources; detect a stale key instead (the SDK's `resolveSettings()` — `@alpha`, `sdk.d.ts:3114-3164` — returns each source's raw `settings`, including `env`) and surface a notice when a settings file sets `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` that would override the injected provider.

**Codex**. `--profile <id>` loads `~/.codex/config.toml` then overlays `~/.codex/<id>.config.toml`; as of **0.134.0** the `[profiles.*]` table and the top-level `profile =` selector are no longer read ([Codex config-advanced](https://developers.openai.com/codex/config-advanced) [P]). So: **back up the user's existing `config.toml` first**, then write one `<id>.config.toml` per provider containing `[model_providers.<id>]` with `base_url`, `env_key` (or `.auth` command — never both, they are mutually exclusive [P]), `wire_api = "responses"` (the only value currently documented [P]), plus headers/retries. Project-local `.codex/config.toml` silently ignores `model_provider` / `model_providers`, so everything must live at user level ([Codex config reference](https://developers.openai.com/codex/config-reference) [P]). Emit `model_catalog_json` pointing at a generated catalog file — it is a **path to a JSON file**, and a profile file can override it ([config reference](https://developers.openai.com/codex/config-reference) [P]). Alternative: isolate a private `CODEX_HOME` per session (default `~/.codex` [P]); prefer profile files, since `CODEX_HOME` cloning also forks auth state.

**OpenCode**. Because ACP has no credential channel for the agent itself (see below), inject `OPENCODE_API_KEY` in the spawn env — exactly how the documented Neovim integrations pass it ([OpenCode ACP](https://opencode.ai/docs/acp/) [P]) — and materialize `providers.<id>` with `package: "@opencode-ai/ai/providers/openai-compatible"` (or `aisdk:@ai-sdk/openai-compatible`), `settings.baseURL`, and explicit `models` ([OpenCode providers](https://dev.opencode.ai/v2/docs/providers/) [P]). **Version caveat (review):** that is the **v2** schema (`@opencode/cli` 2.x). The repo's preset installs `opencode-ai` (`registry.ts:38`), which the research survey identifies as the separately published **v1** line, whose config uses a different shape (`provider.<id>` with `npm` + `options.baseURL`). The injector must detect the installed major version and emit the matching schema — and whether `OPENCODE_API_KEY` is read, and whether a harness-owned config path (rather than a write to `~/.config/opencode/opencode.json`) is supported, are open until spiked (spec `open-questions.md` S8).

**Antigravity** is the constrained case: `modelProvider: "gemini"` is the only accepted value, `GEMINI_API_KEY` is the only credential read (`.env` and `GOOGLE_API_KEY` are ignored), startup only checks that the key is non-empty, and `GOOGLE_GEMINI_BASE_URL` works only against a **Gemini-compatible** endpoint ([Antigravity CLI install & auth](https://antigravity.google/docs/cli/install) [P]). There is no OpenAI/Anthropic-protocol BYOK. Degraded path: expose only `gemini` wire protocol, surface the endpoint-compatibility constraint in the UI, and require explicit acknowledgement of the third-party-access ToS risk flagged by community wrappers [S].

**Generic ACP** (`src/main/agents/registry.ts`). ACP's `initialize` negotiates `protocolVersion`, `clientCapabilities`, `clientInfo` and returns `authMethods` — there is **no** field for handing provider credentials to the agent ([ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization) [P]); `session/new` has `cwd` and `mcpServers`, and its only `env` lives *inside* a stdio MCP server entry, i.e. it configures the MCP subprocess, not the agent ([ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup) [P]). Therefore the harness-side `AcpAgentConfig.env` field is the injection point: expand it from the selected `Provider` (baseURL + key + `env` map) before spawning the preset.

### 1.4 Test-connection and failure triage

"Test connection" must be three probes per protocol, not one ping: (1) list models — meaningful for Claude only with gateway discovery enabled [P]; (2) one minimal generation (`max_tokens: 1` for Messages/Chat, `max_output_tokens: 1` for Responses); (3) a **tools probe** — send one trivial function/tool and require a tool-call block back, because OpenAI-compatible endpoints frequently accept chat traffic but cannot do tool calling, which is why OpenCode makes `capabilities.tools` explicit ([OpenCode providers](https://dev.opencode.ai/v2/docs/providers/) [P]). Triage: **401** → wrong header semantics (`X-Api-Key` vs `Authorization: Bearer`) or the key never reached the child process (the TS `env`-replaces pitfall) [P]. **404** → duplicated `/v1` or chat-vs-responses path mismatch → flip `pathMode: "raw"`. **400** → strict schema or a rejected `anthropic-beta` header → `betaHeaders: "strip"` [P]; Responses-only fields silently ignored on Chat Completions [S]. The `pathMode: "raw"` switch is not optional: WorkBuddy ships an equivalent "custom protocol" toggle precisely because automatic path validation and completion breaks gateway deployments — off means "use `/chat/completions` and auto-complete", on means "use the URL as typed" ([WorkBuddy 模型配置](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) [P]).

### 1.5 One catalog, four `models()`

Each driver compiles `Provider.models` into its native form: Claude → `models()` plus optional `refreshModels()` (gateway `/v1/models` only when discovery is on) and `ANTHROPIC_DEFAULT_*_MODEL` pinning; Codex → the generated `model_catalog_json` file; OpenCode → explicit `models` with `capabilities` and `limit`; ACP → `configOptions` entries of category `model` ([ACP v1 session config options](https://agentclientprotocol.com/protocol/v1/session-config-options) [S]).

**Summary.** A provider registry is the only structure that lets one UI satisfy four incompatible credential contracts. Its cost is concentrated in Codex (a user file we must not clobber) and Antigravity (protocol-bound, no generic BYOK); both need explicit degraded paths rather than best-effort emulation.

### 本章新增来源清单

1. [Claude Code — Other LLM gateways](https://code.claude.com/docs/en/llm-gateway) — [P] Anthropic: "doesn't support routing Claude Code to non-Claude models through any gateway"; gateway credential vs subscription semantics.
2. [Claude Code — Gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol) — [S] request headers to forward, API formats, "disable pre-release capabilities" (maps to `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`).
3. [Claude Code — Model configuration](https://code.claude.com/docs/en/model-config) — [S] `ANTHROPIC_DEFAULT_*_MODEL` alias pinning and pinned-model display/capabilities fields.
4. [OpenCode — Models (v2 docs)](https://dev.opencode.ai/v2/docs/models) — [S] model selection, capabilities, limits, variants referenced by the providers page.
5. [Models.dev](https://models.dev) — [S] upstream source OpenCode builds its provider/model catalog from.

---


<a id="2-four-agent-capability-parity"></a>

## 2. Four-Agent Capability Parity: Tool Calling, Coding, Skills/Plugins, MCP, and Permission-Hook Gap Closure for Claude, Codex, Antigravity, and OpenCode

**Thesis.** The harness is centralized: one `AgentDriver` interface, four very different backends behind it. Today parity is *cosmetic* — every agent can run a turn — but the guarantees that make the product safe and predictable (guardrails before shell execution, model-invoked skills, MCP delivery, allow-always semantics, in-place model switching) are implemented **once, for Claude only**. `src/main/agents/claude.ts` installs a `PreToolUse` hook with `matcher: "Bash"` that runs `git-guardrails`; no other driver has an equivalent (本仓库源码, [P]). This chapter produces the capability matrix, names the exact landing point for every gap, and proposes a `capabilities` descriptor so the UI degrades by *capability* instead of by `driver.id`.

### 2.1 Capability matrix

Legend: **Native** = the agent/protocol supports it directly; **Partial** = supported with loss of fidelity or fidelity depends on configuration; **None**; **Unverified** = not confirmed by a primary source or by this repo's code (as of 2026-09).

| Capability | Claude (Agent SDK) | Codex (app-server) | Antigravity (`agy-acp`) | OpenCode (`opencode acp`) | Generic ACP |
|---|---|---|---|---|---|
| Shell execution | Native (`Bash`) [P] | Native (`sandbox` policy) [P] | Native (PTY session) [S] | Native (`bash` permission key) [P] | Native (`kind: "execute"`) [P] |
| File create/edit/delete | Native [P] | Native (`workspace-write`) [P] | Native [S] | Native (`edit` key covers write/patch) [P] | Native (`kind: edit/delete/move`) [P] |
| Search (grep/glob) | Native [P] | Native [P] | Native [S] | Native (`grep`/`glob`) [P] | Native (`kind: "search"`) [P] |
| Sub-agent / delegation | Native (`agents` option, `AgentDefinition`) [S] | Unverified [U] | Unverified [U] | Native (`task` permission key = subagents) [P] | None (not in v1) [P] |
| MCP stdio | Native (`mcpServers`) [P] | Native (`mcp_servers` in `config`) [P] | Unverified [U] | Unverified [U] | Native (stdio: command/args/env) [P] |
| MCP http | Native [P] | Native [P] | Unverified [U] | Unverified [U] | **Partial** — only if `agentCapabilities.mcpCapabilities.http` (本仓库源码 gates on it) [P] |
| Model-invoked skills | Native (plugins + `skillCallPrefix`) [P] | Native (`skills/extraRoots/set`) [P] | **Partial** — project `.agents/skills` only [P] | **Partial** — `.opencode/skills`, `.claude/skills`, `.agents/skills` (本仓库源码) [P] | **Partial** — `skillsDirEnv` (e.g. `DSH_BUNDLED_SKILL_DIR`) (本仓库源码) [P] |
| User-invoked skills (`/` menu) | Native — harness composes text before the driver (本仓库源码 `composePrompt`) [P] | Native (same) [P] | Native (same) [P] | Native (same) [P] | Native (same) [P] |
| Permission granularity | Native (`canUseTool`, `allowedTools`, `disallowedTools` scoped `Bash(rm *)`) [P] | Partial (`approvalPolicy` + `sandbox`, no per-command rules) [P] | Partial (mode-level) [S] | Native (per-tool + glob object syntax) [P] | Native (`kind`-based + option list) [P] |
| Pre-tool hook / veto | Native (`PreToolUse` → `permissionDecision: "deny"`) [P] | **Partial** — real veto via `item/commandExecution/requestApproval`; warn-only under `full` (本仓库源码 `codex.ts:211`) [P] | **None** [S] | Native (`tool.execute.before` can `throw`) [P] | **Partial** — veto only via `session/request_permission` deny [P] |
| Session resume | Native (`resume: sessionId`) [P] | Native (`thread/resume`) [P] | Native (per-session PTY) [S] | Native [P] | Native (`session/resume`/`session/load`) [P] |
| Fork / rollback | Native (`rewindFiles`, `forkSession`) [S] | Native (`thread/fork`) [P] | None [S] | Native (`session.revert`/`unrevert`) [P] | Unverified — `session/fork` still an RFD draft [P] |
| Compaction | Native (auto + `PreCompact`) [P] | Native (`thread/compact/start`) [P] | Unverified [U] | Native (`session.summarize`, `experimental.session.compacting`) [P] | Unverified [U] |
| Web search | Native (`WebSearch`/`WebFetch`) [P] | Partial — depends on provider `supports_standalone_web_search` [P] | Unverified [U] | Native (`websearch`/`webfetch` permission keys) [P] | `kind: "fetch"` only [P] |
| Image / vision | Native [P] | Native — `model/list` exposes `inputModalities` [P] | Unverified [U] | Unverified [U] | Partial — gated by prompt capabilities [P] |
| Plan mode | Native [S] | None [P] | Unverified [U] | Native (`plan` agent, permissions can `deny` edit) [P] | Partial via `category: "mode"` config option [P] |
| Per-message model switch | Partial (`Query.setModel()` mid-stream) [S] | **Partial** — `thread/resume` with `model` emits a warning and applies a one-time switch instruction [P] | Native (`--model` / `model` config option) [S] | Native (`body.model: {providerID, modelID}` per prompt) [P] | Native (`session/set_config_option`) [P] |
| Interrupt | Native (`interrupt()` / `abortController`) [P]/[S] | Native (`turn/interrupt`) [P] | Unverified [U] | Native (`session.abort`) [P] | Native (`session/cancel`) [P] |

### 2.2 Closing each inconsistency

**Guardrails.** `git-guardrails` is a shell-command judge; it needs a pre-execution veto. Three non-Claude paths exist: (a) **OpenCode** gets a true equivalent — a plugin in `.opencode/plugins/` implementing `tool.execute.before` and `throw`ing on a rejected `bash` command; the docs' own `.env`-protection example is exactly this shape ([P](https://dev.opencode.ai/docs/plugins/)); (b) **ACP** — the client already owns `session/request_permission`; add a judge *before* `pickPermission()` in `src/main/agents/acp/driver.ts`, and when `toolCall.kind === "execute"` and the guard rejects, answer with a `reject_always` option or `{outcome:"cancelled"}` plus a `notice` event ([P](https://agentclientprotocol.com/protocol/v1/tool-calls)); (c) **Codex** has no hook surface — the lever is the existing approval callback: keep `approvalPolicy` at `on-request` and run the same command judge inside the `onRequest` branch that already handles `item/commandExecution/requestApproval` (`src/main/agents/codex.ts:211`), returning `{ decision: "decline" }` when the guard rejects — the same shape as an existing user refusal, so no new protocol surface is needed. `mcpServer/elicitation/request` → `onElicitation` (`codex.ts:228-230`) bails out unless `_meta.codex_approval_kind === "mcp_tool_call"`, so it only ever carries MCP tool calls and must not be used for command guarding. Under `ask`/`auto-edit` that is a **real pre-execution veto**: Codex asks before the command runs and the client's answer decides, so it is genuinely equivalent to Claude's `PreToolUse` deny for shell commands. Only under `full` — `codexPolicy("full")` → `approvalPolicy: "never"`, `sandbox: "danger-full-access"`, so no callback fires at all — is it warn-only. For `full`, the honest degradation is: tighten `sandbox` away from `danger-full-access`, and surface a post-hoc `notice` event ("guardrail: this command would have been blocked"). Mark clearly which agents are "blockable" vs "warn-only" in the capabilities descriptor.

**Blocking bug found in the same area:** `codexPolicy()` maps `ask` → `approvalPolicy: "untrusted"` (本仓库源码 [P]), but the Codex docs state `approval_policy = "untrusted"` is **no longer supported** ([P](https://developers.openai.com/codex/config-advanced)). Migrate `ask` → `on-request` (optionally the `granular` form) and verify whether the `sandbox` param wants the documented `"workspaceWrite"` (docs example) or the hyphenated `"workspace-write"` the repo sends.

**Skills routing.** One canonical model-invoked skills directory, four delivery mechanisms: Claude → local plugin dir (`plugins: [{type:"local", path}]`, prefix `${PLUGIN_NAME}:`); Codex → `skills/extraRoots/set` with `{extraRoots:[dir]}` ([P](https://developers.openai.com/codex/app-server/)); DeepSeek → `skillsDirEnv` env var (`DSH_BUNDLED_SKILL_DIR`); Antigravity/OpenCode/Cursor → write `.agents/skills` into the project (`install.py --model-only`). `skillCallPrefix` should evolve from a string into `{ mode: "plugin" | "extraRoots" | "envDir" | "projectWrite" | "none", prefix?: string }` — a *delivery strategy*, not a name-mangling hint. User-invoked skills need no such work: `composePrompt()` expands the slash command into the prompt text before the driver sees it (本仓库源码 [P]), so `/foo` is identical on all four by construction.

**MCP.** Three wire formats, one source list: Codex takes `config: { mcp_servers: {...} }` — snake_case, mirroring `config.toml` (`codex -c mcp_servers.context7.enabled=false`) ([P](https://developers.openai.com/codex/config-advanced)); camelCase `mcpServers` is silently ignored. ACP takes `mcpServers` in `session/new`/`session/resume` and only emits http entries when `agentCapabilities.mcpCapabilities.http` is true — meaning **stdio-only ACP agents silently receive no harness tools at all** (本仓库源码, `mcpServersFor`). Note the same gate also silently drops the **user's own `http`-type servers**: `forAcp` (`src/main/mcp/servers.ts:159-165`) returns `[]` for an `http` spec whenever the agent's capability is false, so the loss is not limited to the browser tools. And per the ACP initialization spec, `mcpCapabilities.http` is a `boolean` defaulting to `false`, and "Clients and Agents MUST treat all capabilities omitted … as UNSUPPORTED" ([ACP v1 initialization](https://agentclientprotocol.com/protocol/v1/initialization)) — so this is the protocol default, not a quirk of one agent. Claude takes an object with an in-process server. Critically, an MCP-config change forces session surgery: Codex `thread/unsubscribe` + `thread/resume`, ACP `session/close` + `session/resume` (本仓库源码 [P]). That is both a capability cliff and a cache-hit cliff — flagged here, costed in Chapter 4.

**Permissions.** `ask / auto-edit / full` → Claude `default / acceptEdits / bypassPermissions` (本仓库源码 [P]); Codex `on-request+workspace-write / on-request+workspace-write / never+danger-full-access`; ACP via `pickPermission()` on tool `kind` (note `delete` is correctly excluded from `AUTO_EDIT_KINDS`); OpenCode via the `permission` map (`"*": "ask"`, `edit: allow`, or `--auto`). "Allow always" scopes differ fundamentally: Claude writes a settings permission rule; OpenCode's `always` is **for the rest of the current session only**, using patterns the *tool* proposes ([P](https://dev.opencode.ai/docs/permissions/)); ACP's `allow_always` means "remember the choice" — but the memory lives in the **agent process**, not the client ([P](https://agentclientprotocol.com/protocol/v1/tool-calls)). So allow-always cannot be inherited across agents: rule syntax, tool names, sandbox paths, and process lifetimes are all different. Store approvals in the harness keyed by `(agentId, toolName, canonicalPattern)` and re-ask on first use after a switch. One consequence of the `ask → on-request` migration above: on Codex, `ask` and `auto-edit` both become `on-request` + `workspace-write`, so the three-mode model collapses to two for that driver. The distinction must then be carried by the harness — in Ask mode the `item/commandExecution/requestApproval` judge asks the user for every command, in Auto-edit it auto-approves the same shapes Claude's `acceptEdits` auto-approves.

**Model switching.** `applyModel()` belongs in the Service layer, applied at the top of `runTurn` *before* `session/prompt`, with a driver-supplied `setModel?(live, model)` hook: Claude `Query.setModel()` ([S](https://agentwikis.com/wiki/claude-code/wiki/entities/agent-sdk-typescript.md) — note the official TS reference documents only `options.model`/`fallbackModel`, so pin and test), Codex `thread/resume {model}` (accept the documented warning + one-time switch instruction, and surface it as a `notice`), OpenCode per-message `body.model`, ACP `session/set_config_option` on the `category: "model"` option ([P](https://agentclientprotocol.com/protocol/v1/session-config-options)), agy-acp `model` → `--model`. When in-place switching is unsupported, the fallback is explicit: fork/resume a new session at the new model, replay a `summarize()` summary, and label the turn boundary in the UI.

### 2.3 Antigravity, honestly

`agy-acp` is a third-party adapter whose README states that Google's FAQ treats third-party access as a Terms-of-Service violation that may lead to account action ([P](https://github.com/shindgew/agy-acp)); Google's own docs only describe first-party CLI auth and a Gemini-API-key mode ([P](https://antigravity.google/docs/cli/install)) — and `~/.gemini/antigravity-cli/settings.json` accepts `modelProvider: "gemini"` only [U — reported by the community adapter's documentation; Google's own CLI page documents no provider-override field]. (Note: this `modelProvider` is a **different** field from Codex's `modelProvider` parameter in Ch.3's `ThreadResumeParams`.) There is no OpenAI/Anthropic BYOK path. Three options: (1) ship default-off behind an explicit ToS disclosure toggle; (2) ship enabled but labelled "unsupported / use at your own risk"; (3) remove. **Recommendation: (1).** A MIT-licensed desktop app cannot indemnify users against account loss, and a silent ban is a data-loss event the harness cannot detect or explain; but (3) discards real Gemini-only users. Make it opt-in, persist the acknowledgment, and treat it as a Gemini-compatible endpoint only — never advertise it in the BYOK model picker.

### 2.4 Capability negotiation, not `driver.id`

Add `capabilities` to `AgentDriver`: booleans (`mcpStdio`, `mcpHttp`, `preToolGuard`, `resume`, `fork`, `revert`, `compaction`, `perMessageModel`, `vision`, `webSearch`, `planMode`, `interrupt`) plus enums (`skillsDelivery`, `permissionGranularity: "perTool"|"perCommand"|"modeOnly"`, `guardEnforcement: "block"|"warnOnly"`, `sandbox: "none"|"workspace"|"full"`). It is populated once by `ACP_PRESETS` metadata, by `initialize` agent capabilities for ACP, and by constants for Claude/Codex. UI and Service then branch on `driver.capabilities.preToolGuard` rather than `driver.id === "claude"`, and an unknown `agents.json` entry degrades to a declared-safe default (ask-mode permissions, warn-only guard, no harness MCP tools) instead of being half-wired.

**小结.** Parity is achievable for shell/file/search/resume/interrupt and for user-invoked skills; it is *lossy* for MCP-http and model-invoked skills on the ACP presets, and absent for pre-tool veto on Codex only in `full` mode. Two concrete defects fell out of the matrix: the retired `untrusted` approval policy, and http-gated MCP starving stdio-only ACP agents of harness tools. The `capabilities` descriptor converts all of this from scattered `if (id === …)` special cases into a declarative contract that new agents can join safely.

### Key findings

- Pre-tool guardrails are native for Claude; OpenCode can match via `tool.execute.before`, ACP can veto via `session/request_permission`, and Codex gets a real pre-execution veto under `ask`/`auto-edit` via `item/commandExecution/requestApproval` — but under `full` (`approvalPolicy: "never"`) it can only warn ([P](https://dev.opencode.ai/docs/plugins/), [P](https://agentclientprotocol.com/protocol/v1/tool-calls), 本仓库源码 `codex.ts:211`).
- `codexPolicy("ask")` emits the retired `untrusted` approval policy ([P](https://developers.openai.com/codex/config-advanced), 本仓库源码).
- MCP-config mutation forces `thread/unsubscribe`+resume (Codex) and `session/close`+resume (ACP) — a cache-cost event, not just a capability event (本仓库源码).
- `allow_always` is agent-owned in ACP and session-scoped in OpenCode; allow-always cannot cross agent boundaries ([P](https://dev.opencode.ai/docs/permissions/)).

### 本章新增来源清单

1. [OpenCode — Plugins](https://dev.opencode.ai/docs/plugins/) — [P] `tool.execute.before` can `throw` to block a tool; plugin load dirs `.opencode/plugins/`, `~/.config/opencode/plugins/`; `permission.asked/replied`; custom tools; `experimental.session.compacting`.
2. [OpenCode — Permissions](https://dev.opencode.ai/docs/permissions/) — [P] `allow|ask|deny`, granular glob object syntax (last match wins), `always` = rest of session, `doom_loop`, per-agent overrides, `external_directory`.
3. [OpenCode — SDK](https://opencode.ai/docs/sdk/) — [P] `session.abort`, `session.revert/unrevert`, `session.summarize`, per-message `body.model: {providerID, modelID}`, `noReply`, permission-response API, `auth.set`.
4. [ACP v1 — Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) — [P] tool `kind` enumeration; `session/request_permission` shape; `PermissionOptionKind` = `allow_once/allow_always/reject_once/reject_always`; `cancelled` outcome.
5. [ACP v1 — Session Config Options](https://agentclientprotocol.com/protocol/v1/session-config-options) — [P] categories `mode/model/model_config/thought_level`; `session/set_config_option` returns complete config state; agents may push `config_option_update`.
6. [Codex — Advanced config](https://developers.openai.com/codex/config-advanced) — [P] `approval_policy` values incl. `"untrusted"` retired; `sandbox_mode` values; `mcp_servers.<id>.enabled` dot-notation; `model_reasoning_effort`/`model_verbosity`/`model_context_window`.
7. [Codex — app-server](https://developers.openai.com/codex/app-server/) — [P] `thread/resume` model override + warning/one-time switch; `thread/fork`; `turn/interrupt`; `model/list` with `inputModalities`; `skills/extraRoots/set`.
8. [Agent SDK TypeScript (Agent Wikis)](https://agentwikis.com/wiki/claude-code/wiki/entities/agent-sdk-typescript.md) — [S] `Query.setModel()/interrupt()/setPermissionMode()/setMcpServers()/rewindFiles()`; `env` replaces rather than merges; `settingSources`.
9. [shindgew/agy-acp](https://github.com/shindgew/agy-acp) — [P] third-party Antigravity access violates Google ToS per Google FAQ; per-session PTY; config options → `--mode/--model/--effort`.
10. [Antigravity CLI — Installation & Auth](https://antigravity.google/docs/cli/install) — [P] Gemini API key mode; first-party auth only.
11. [Zed — External Agents](https://zed.dev/docs/ai/external-agents) — [P] (reused) model/provider config, auth, and native MCP config are owned by the agent, not the client.

---


<a id="3-context-survival-across-model-and-agent-switches"></a>

## 3. Context Survival Across Model and Agent Switches: Thread/Session Identity, Handoff Seeding via `thread/inject_items` and `noReply`, and Honest Degradation Contracts

**Thesis.** Context cannot be made portable — it can only be *re-seeded*. The harness's job is therefore not to promise continuity, but to (1) own a durable, replayable transcript, (2) keep every provider's session cursor alive in parallel, (3) seed a new session through the best available native channel, and (4) tell the user precisely what did not make it across.

### 3.1 Two layers: canonical thread vs. disposable provider session

There are two distinct identities in play today, and the code conflates them. The durable layer is the canonical `threads` / `events` pair in `src/main/db.ts` (SQLite via `node:sqlite`), append-only and fully owned by us. The disposable layer is the opaque provider cursor, which `src/shared/types.ts` models as a single `sessionId: string | null` on `Thread`. That single field is the root defect: a thread can remember **one** provider's cursor at a time. `updateThread()` in `src/main/service.ts` nulls `sessionId` when the agent changes, and `send()` re-emits the same notice when `sessionId === null`. Switch Codex → Claude → Codex and the original Codex cursor is discarded even though the rollout still exists on disk under `~/.codex/sessions/**` ([Codex app-server](https://developers.openai.com/codex/app-server/)) `[P]`.

The fix is to replace `sessionId` with a bindings map on `Thread`:

```ts
type ProviderKey = string; // `${agent}:${instanceId}` — two OpenCode servers, two Codex workspaces
interface SessionBinding {
  provider: "claude" | "codex" | "acp";
  instanceId: string;              // ACP agent id, OpenCode baseUrl, Codex serviceName
  resumeCursor: string | null;     // opaque: session id / threadId / acp sessionId
  status: "active" | "stale" | "lost" | "rolled-back";
  cwd: string; configDir?: string; // cursor scope
  lastSeenAt: number; lastSeq: number;
  runtime?: unknown;               // provider-private payload (model, effort, mcp roots)
}
```

Migration: add a `bindings` JSON column to `threads`; keep `sessionId` as a read-only projection of `bindings[currentKey]` for one release, then drop it. `cwd`/`configDir` must be recorded because Claude's cursor is filesystem-scoped — transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` ([Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)) `[P]` — and Codex rollouts live under `~/.codex/sessions/**` `[P]`.

### 3.2 Fix the event log before seeding anything

Replay is impossible if the log only contains summaries. Today `tool-use` stores `{toolUseId, name, summary}` and `tool-result` stores `{toolUseId, isError, summary}` — the arguments and outputs are thrown away. Extend `ThreadEvent`:

- `payload` — full tool input / tool result; `summary` retained as a UI-only projection.
- Stable semantic ids: `messageId`, `turnId`, `itemId`, `parentId`, alongside the existing `seq`.
- `provenance: { agent, model, provider, instanceId }` on **every** event.

Provenance is not bookkeeping — it is load-bearing. Anthropic drops thinking blocks the receiving model cannot read and enforces a prefix check against the block's `signature`; whether a block survives a switch depends entirely on which model produced it ([Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)) `[P]`. Without per-event provenance the seeder cannot decide what to replay.

Storage caps: inline `payload` up to a threshold (e.g. 64 KB); above it write to a blob file (`blobs/<sha256>`) and store `{blobRef, bytes, truncated: true, preview}` in new `payload_ref` / `payload_bytes` columns. Events stay append-only; blobs are content-addressed and deduplicated.

### 3.3 The three switch cases

**(a) Same agent, same model — native resume.** Claude `resume` / `continue: true`; Codex `thread/resume` (schema: `threadId` required, everything else optional) ([protocol schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) `[P]`; ACP `session/resume`, optionally with `replayFrom: {type:"start"}` for full history replay ([ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup.md)) `[P]`. Cursors survive process exit because they are files. Two caveats: ACP agents "are not required to persist every inserted user message," so replay may be partial — the canonical log, not ACP replay, remains the source of truth `[P]`; and a stale cursor must mark the binding `lost`, emit an `error`/`notice`, and fall through to case (c).

**(b) Same agent, different model.**

| Driver | Mechanism | Grade |
|---|---|---|
| Codex | `thread/resume` with `model` (+`modelProvider`); if it differs from the rollout, Codex emits a warning and applies a one-time model-switch instruction | `[P]` |
| OpenCode | per-message `model: {providerID, modelID}` on `session.prompt` — no new session | `[P]` |
| ACP | `session/set_config_option` with the `model` `configId` (category `model`) — in place, no new session | `[P]` |
| Claude | `setModel()` mid-session — but the installed SDK documents it as "only available in streaming input mode" (`sdk.d.ts:2750-2755`), and this repo's driver runs one `query()` per turn with a string prompt, so it is unreachable without a driver refactor; the per-turn path is `{resume, model}`, whose combination is **undocumented** | `[U]` |
| agy-acp | `--model` at spawn → new session + seeding | `[S]` |

A single `applyModel(target)` returns `{mode: "in-place" | "new-session" | "unsupported", reason}`; `new-session` and `unsupported` both route to (c). For Claude `[U]`, the verification harness is cheap: start a session on model A, capture `session_id`, resume with `model: B`, assert no error and read the effective model from the init `SystemMessage` / `SDKResultMessage`.

**(c) Cross-agent — export, checkpoint, seed.** Pipeline: export canonical events → build a structured handoff checkpoint → seed the new session.

Checkpoint contents: goal and decisions made; files touched (path + diffstat); commands run with exit codes and truncated outputs; open questions; artifact blob refs; workspace git state (`HEAD` sha, branch, dirty file list); provenance header. Budget: target `min(25% of destination window, ~8k tokens)`, measured with the destination tokenizer — tokens never transfer across tokenizers. (Ch. 10 §10.6–10.7 tightens this, with sources, to a 2,000–4,000-token target and a ~4k hard cap; that later figure governs.) Degrade in tiers: full checkpoint → tool-result payloads collapsed to `summary` → decisions + git state only.

Seeding channels, best first:

- **Codex — `thread/inject_items`** with `{threadId, items}`, where `items` is "raw Responses API items to append to the thread's model-visible history" and the call does **not** start a user turn ([schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json), [docs](https://developers.openai.com/codex/app-server/)) `[P]`. This is the closest thing to lossless: we emit real `function_call` / `function_call_output`-shaped items instead of prose, so tool history keeps its native shape. What we must *not* fabricate is reasoning items we never possessed.
- **OpenCode — `session.prompt({ noReply: true })`**, which returns a `UserMessage` and injects context "without triggering AI response"; the same call accepts per-message `model` ([OpenCode SDK](https://opencode.ai/docs/sdk/)) `[P]`. **Reachability caveat:** this repo drives OpenCode as a built-in **ACP** agent (`src/main/agents/registry.ts:34-40` — `opencode acp`), and the HTTP SDK is *not* the ACP wire format. The channel therefore requires a native OpenCode driver that does not exist today; **as shipped, OpenCode takes the ACP synthetic-first-message path below.** Treat `noReply` as a future upgrade, not an available mechanism.
- **Claude — no injection API exists.** Fall back to a synthetic first user message carrying the checkpoint; `systemPrompt: {type:"preset", preset:"claude_code", append: …}` may carry at most a short provenance header on the *new* session's first request — never the checkpoint a second time (that double-bills it and breaks the budget), and never on a resume (Ch. 4 §4.3c). Three hard constraints: a custom string *replaces* the default entirely and loses default tools, safety and environment context, so always use preset + `append` ([modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)) `[P]`; the system prompt is recorded on a session's first request and reused until compaction, so a later `append` is invisible on resume unless `snapshot: false`, which in turn forbids cache reuse for that request `[P]`; and because `append` lands in the system block, it sits ahead of messages in the `tools → system → messages` invalidation hierarchy ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) `[P]` — use `excludeDynamicSections: true` to keep it cacheable. See Chapter 4.
- **ACP — no client→agent injection at all.** `session/resume` and `session/load` replay *from* the agent to the client, and neither `session/new` nor `session/resume` accepts a model `[P]`. The only channel is a synthetic first `session/prompt`.

Under every channel: **never re-execute side-effecting tools.** Carry the recorded result with provenance ("produced by Codex, not re-run here").

### 3.4 Honest degradation contract

| Survives | Does not survive |
|---|---|
| Visible user/assistant text | Hidden/encrypted reasoning — unreadable thinking blocks are dropped, not rejected, and are lost for good only if the harness itself strips them ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)) `[P]` |
| Decisions, file diffs, command results | Prompt cache — isolated per organization and per workspace ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) `[P]` |
| Blob artifacts, git snapshot | Approvals / allow-always / cwd trust / credentials |
| Provenance metadata | Tokenizer state, native tool ids, system prompt and built-in tool set |

UI: before switching, show a confirm card generated from that table ("Codex → Claude: your last 14 tool outputs carry over; reasoning, cache and approvals do not"). After switching, persist a `notice` event carrying provenance plus the loss report — replacing today's single hard-coded line in `updateThread()`/`send()`. This is consistent with the market: no shipping product performs live cross-agent context migration; Zed's imported threads are archive entries reopened by their own agent ([Zed external agents](https://zed.dev/docs/ai/external-agents)) `[S]`, Vibe Kanban's follow-up only works within one executor ([Vibe Kanban](https://deepwiki.com/BloopAI/vibe-kanban/3.1-executor-architecture-and-configuration)) `[S]`, and Codex's own `externalAgentConfig/import` moves configuration and session *artifacts*, not a live handoff channel `[P]`.

### 3.5 Trust reset and rollback

On any agent switch, reset permission mode, allow-always rules, additional workspace roots and credentials; re-declare `cwd` explicitly on resume `[P]`. Prior approvals are retained as *evidence*, never as authorization. Before the switch, drop a git checkpoint (`harness-handoff/<seq>`); refuse to proceed on a dirty worktree unless the user commits or stashes.

Rollback must coordinate both layers. Workspace: `git checkout` the checkpoint. Provider session: Claude `forkSession` with `resume` produces a new id while the original stays untouched — it branches history, not the filesystem `[P]`; Codex `thread/fork` supports `lastTurnId`, `ephemeral`, `excludeTurns` and a `model` override `[P]`; ACP `session/fork` is still an RFD proposal rather than a stable method ([ACP RFD](https://agentclientprotocol.com/rfds/session-fork.md)) `[P]`, so when it is unavailable the driver must return an explicit `unsupported` error and offer "new session + seeding" rather than silently succeeding. Record `rolledBackFrom` on the binding for audit.

**Summary.** Canonical log in SQLite is the only truly portable asset; provider cursors are parallel, per-instance, and must all be retained; seeding is per-provider and degrades — Codex `thread/inject_items` ≈ lossless, OpenCode `noReply` ≈ clean *only if* a native driver is added (through ACP today it takes the prose path), Claude/ACP ≈ prose-in-a-first-message with real cache costs. Ship the loss report in the UI and in the thread, not in a footnote.

### 本章新增来源清单

1. [Codex App Server — Threads / resume / inject_items / fork](https://developers.openai.com/codex/app-server/) — `thread/resume` 接受与 `thread/start` 相同的配置覆盖（含 model）；`thread/inject_items` 追加原始 Responses items 且不启动 user turn；`thread/fork` 支持 `lastTurnId`/`ephemeral`/`excludeTurns`。`[P]`
2. [Codex app-server protocol v2 JSON schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json) — `ThreadInjectItemsParams = {threadId, items}`；`ThreadResumeParams`/`ThreadForkParams` 含 `model` + `modelProvider`；`ExternalAgentConfigMigrationItemType` 枚举含 `SESSIONS`。`[P]`
3. [OpenCode SDK — Sessions](https://opencode.ai/docs/sdk/) — `session.prompt` body 支持 per-message `model: {providerID, modelID}` 与 `noReply: true`（返回 UserMessage，仅注入上下文）。`[P]`
4. [Claude Agent SDK — Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions) — `resume` / `continue` / `forkSession`；session id 与 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 存储路径；未说明 resume 时能否改模型 `[U]`。`[P]`
5. [Claude Agent SDK — Configuration](https://code.claude.com/docs/en/agent-sdk/configuration) — `model`、`fallbackModel`、`setModel()`、`permissionMode`/`allowedTools`、`cwd` 无 setter。`[P]`
6. [Claude Agent SDK — Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) — preset+`append`（加性）vs 自定义字符串（整体替换）；系统提示词在会话首个请求被录制、`snapshot:false` 的代价、`excludeDynamicSections`、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`。`[P]`
7. [ACP v2 — Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup.md) — `session/resume` + `replayFrom:{type:"start"}` 为 agent→client 回放；`session/new`/`session/resume` 不接受 model；agent 不保证保留所有 user message。`[P]`
8. [ACP v2 — Session Config Options](https://agentclientprotocol.com/protocol/v2/session-config-options) — `session/set_config_option` 可就地改 model（`category:"model"`），无需新会话。`[P]`
9. [ACP RFD — Forking of existing sessions](https://agentclientprotocol.com/rfds/session-fork.md) — `session/fork` 仍为提案，agent 可对不支持的 fork 返回错误。`[P]`
10. [Anthropic — Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) — thinking block 靠 `signature` 回放；跨模型不可读则被丢弃而非报错；"推理永久丢失仅当 harness 自己剥离了这些 block"。`[P]`
11. [Anthropic — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — 缓存按组织/工作区隔离，从不跨组织共享；失效层级 `tools → system → messages`；dropped thinking block 导致该位置之后的缓存前缀改变。`[P]`
12. [Vibe Kanban — Executor architecture](https://deepwiki.com/BloopAI/vibe-kanban/3.1-executor-architecture-and-configuration) — follow-up 仅对同一 executor 生效，不支持跨 executor 交接。`[S]`

---


<a id="4-cache-hit-rate-engineering"></a>

## 4. Cache Hit-Rate Engineering: Prefix Stability Discipline, Extending `ThreadEvent` Usage with Cache Dimensions, Per-Vendor TTL/Invalidation Matrix, and Compaction Policy

**Thesis.** Cache hit rate is not a tuning knob on the model call — it is an emergent property of how stable the harness keeps the prompt prefix across turns. Today the repo cannot even see it: `ThreadEvent`'s `turn-end` carries only `{costUsd, inputTokens, outputTokens, durationMs}` (`src/shared/types.ts:187`), and `src/main/agents/claude.ts:289` computes `inputTokens = message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0)`. That line is **wrong on two counts**: Anthropic documents `input_tokens` as *only the tokens after the last cache breakpoint*, while `cache_read_input_tokens` and `cache_creation_input_tokens` are the cached portion ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]); folding reads into `input` makes the denominator of any hit-rate formula unknowable, and `cache_creation_input_tokens` is discarded entirely. Codex is no better — `src/main/agents/codex.ts:152` reads `tokenUsage.last` into a `TokenBreakdown` that *has* `cachedInputTokens` (`:35`), but `:368-369` only forwards `inputTokens`/`outputTokens`. So the first engineering step is instrumentation, and the second is discipline.

### 4.1 Extend the usage event; define one canonical hit rate

Extend `turn-end` with a nested `usage` (kept additive so `StoredEvent` rows already on disk stay valid), and add a live `usage` event for streaming:

```ts
| { kind: "turn-end"; costUsd: number | null; inputTokens: number; outputTokens: number;
    durationMs: number;
    usage: {
      inputTokens: number;        // UNCACHED (net-new) tokens only
      outputTokens: number;
      reasoningTokens: number | null;
      cacheReadTokens: number | null;   // null == "not reported by this agent"
      cacheWriteTokens: number | null;
      cacheTtl: "5m" | "1h" | "30m" | "unknown" | null;
      hitRate: number | null;           // see formula
      miss: boolean;                    // see threshold
      missCause?: "tool-definitions" | "system-prompt" | "model" | "compaction"
               | "ttl-expiry" | "session-rebuild" | "unknown";
      provenance: "reported" | "estimated" | "unavailable";
    } }
```

Field sources: **Claude** → `cache_read_input_tokens` / `cache_creation_input_tokens` (with `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` when a 1-hour TTL is in play) ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]). **Codex** → `cachedInputTokens`, `cacheWriteInputTokens`, `inputTokens`, `reasoningOutputTokens`, plus `netNewInputTokens` from the grouped breakdown; all verified present in the v2 app-server schema ([codex_app_server_protocol.v2.schemas.json](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json), [P]). **OpenAI Responses** (direct/BYOK) → `usage.input_tokens_details.cached_tokens` and `.cache_write_tokens` — *not* `prompt_tokens_details` ([OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching), [P]). **DeepSeek** → `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` ([DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/), [P]). **ACP** → the RFD strawman does define `cachedReadTokens`/`cachedWriteTokens`, but the document states plainly it "is not ready for Preview" and is kept in Draft ([ACP RFD](https://agentclientprotocol.com/rfds/end-turn-token-usage.md), [P]); `usage_update` in v1 carries only `used`/`size` and optional `cost` ([ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md), mirrored at `src/main/agents/acp/driver.ts:39`). So for OpenCode/Cursor/Antigravity over ACP, emit `cacheReadTokens: null, provenance: "unavailable"` — and optionally an **estimator** from context size deltas (`netNew ≈ size_t − size_{t−1} − outputTokens_t`, `cacheRead ≈ size_{t−1}`), always tagged `provenance: "estimated"` so the UI never presents it as fact.

**Canonical formula.** Vendors disagree on the denominator: OpenAI defines hit rate as `cached_tokens / input_tokens` where `input_tokens` *includes* cached tokens ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching), [P]), while Anthropic's `input_tokens` *excludes* them. Normalize inside the harness to **true processed input**:

```
hitRate = cacheRead / (cacheRead + cacheWrite + netNew)
```

**Miss threshold.** Adopt Claude Code's definition verbatim — a request is a miss when it "re-processed more than 5% and at least 2,000 tokens of what it could have read from cache" ([Claude Code costs](https://code.claude.com/docs/en/costs), [P]). Concretely: compare this turn's `cacheWrite` against the previous turn's processed prefix; flag if `cacheWrite >= 2000 && cacheWrite > 0.05 * prevPrefix`. Claude Code further separates **expected rebuilds** — compaction and clearing old tool results — from true misses; the harness must do the same or its own alerting will be noise ([Claude Code costs](https://code.claude.com/docs/en/costs), [P]).

### 4.2 Prefix stability discipline (the enforceable checklist)

Anthropic caches the prompt in the fixed order `tools → system → messages`, and a change at any level invalidates that level **and everything after it** ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]). OpenAI requires "the entire rendered prefix to match" ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching), [P]). DeepSeek is strictest still: a hit requires **complete** match of a *cache prefix unit*, byte-for-byte — `A+B` cached then `A+C` misses, though the system will then persist `A` for the next round ([DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/), [P]). The harness should therefore enforce:

1. **Static/dynamic system-prompt split.** Use the SDK's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` array form so the static block gets its own breakpoint and per-request context sits behind it; consider `excludeDynamicSections: true` so identical configs share a cache entry across machines ([Agent SDK: modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts), [P]). **Never** run with `snapshot: false` in production — it disables prompt recording and explicitly prevents that request from reusing the session cache (same source, [P]).
2. **Tools are frozen and sorted.** Anthropic: modifying tool definitions invalidates the *entire* cache; OpenAI: tool **ordering** matters ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); [OpenAI](https://platform.openai.com/docs/guides/prompt-caching), [P]). Sort MCP servers by name, sort tools deterministically, and never mutate the set mid-thread. Also serialize `tool_use` argument JSON with stable key order.
3. **Fix the browser-tool timing.** `README.md:93` advertises that the seven `browser_*` tools "aren't sent at all" until the Browser tab is opened — i.e. a deliberate mid-conversation tool injection, the single most expensive thing you can do to a prefix. Recommendation: **pin the full tool set at `thread/start` / `session/new`** and gate behaviour at runtime (the tool returns "Browser pane not open" until it is). Cost: a permanently larger prefix; benefit: no invalidation and, critically, no session rebuild. If the product insists on zero-context-when-unused, then at minimum make it one-way (never un-mount) and classify the resulting rebuild as an expected rebuild in telemetry.
4. **Skills stay out of the prefix.** Inject skills as a *tool* the model calls (Claude's `skillCallPrefix` already does this), so skill text lands in messages rather than in `system`.
5. **History is append-only.** No rewriting, trimming, or reordering of earlier turns; volatile state (timestamps, git HEAD, nonce, file mtimes) goes in the trailing user message, after the last breakpoint.
6. **No mid-thread config changes.** Changing `model`, `reasoning.effort`, `text.verbosity`, `text.format`, or `parallel_tool_calls` breaks the OpenAI prefix ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching), [P]); on Anthropic, changing thinking config always invalidates message blocks and, on some models, tools/system too ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]). Where supported, change reasoning effort by appending a `configuration_update` item instead of mutating the top-level field ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching), [P]).
7. **Place breakpoints deliberately.** Anthropic allows 4 (automatic caching consumes one, and 4 explicit + automatic returns 400) and reads look back at most 20 block positions, so a long thread needs a second breakpoint placed early ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]).
8. **One turn per thread at a time.** No prefix forking for parallel sub-agents; give them separate sessions.

### 4.3 Eliminate mid-session rebuilds

`src/main/agents/codex.ts:314-318` issues `thread/unsubscribe` + `thread/resume`, and `src/main/agents/acp/driver.ts:265-266` issues `session/close` + `session/resume`, whenever the MCP signature changes (`driver.ts:260`). Every one of those rewrites the whole prefix at write prices instead of read prices. (Review note: both already run at the *start* of `runTurn`, i.e. at a turn boundary, not mid-turn — so "queue to a turn boundary" alone saves nothing. What actually removes the cost is removing the trigger: the browser tools, the only automatic trigger, stop changing once §4.2(3) pins them. A genuine user edit to their MCP servers still needs one reload to take effect; the harness can only batch several edits into one reload and say so.) Worse, `src/main/service.ts:78` sets `sessionId: null` on agent switch — a total loss of a warm prefix. Countermeasures: (a) pin the tool set at thread creation and **batch** user MCP config changes into one reload at the next turn boundary, surfacing a `notice` event to the user; (b) retain the previous provider's `SessionBinding` from Ch3 so switching back inside the TTL reuses a still-warm cache; (c) put handoff seed content at the **end of messages**, not in the system prompt — Claude's `systemPrompt.append` lands *inside* the prefix and is, per the SDK docs, recorded on the first request and replayed until compaction, so appending post-resume is either ignored or (with `snapshot:false`) cache-fatal ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts), [P]).

### 4.4 TTL / invalidation matrix (as of 2026-09)

| Change | Anthropic | OpenAI Responses | DeepSeek | ACP |
|---|---|---|---|---|
| Model | invalidates (min length & behaviour vary) | invalidates ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | prefix no longer matches → miss | unobservable |
| Tool definitions | **invalidates entire cache** ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | invalidates ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | miss (byte-identical prefix only) | unobservable |
| Tool order | invalidates | **invalidates** ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | miss | unobservable |
| `tool_choice` | messages only ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | no effect (use `tool_choice:"none"`/`allowed_tools`) | n/a | unobservable |
| System prompt | invalidates system+messages | invalidates | miss | unobservable |
| Reasoning effort | messages always; tools/system model-specific ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | invalidates top-level; safe via `configuration_update` ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | unknown `[U]` | unobservable |
| Verbosity / `text.format` | n/a | invalidates ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | unknown `[U]` | unobservable |
| `parallel_tool_calls` | n/a | invalidates ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | unknown `[U]` | unobservable |
| Images added/removed | messages only ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | prefix change ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | miss | unobservable |
| Thinking blocks | preserved on Opus 4.5+/Sonnet 4.6+; stripped on earlier Opus/Sonnet and all Haiku → invalidated ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | n/a | n/a | unobservable |
| Compaction / `context_management` | expected rebuild ([Claude Code costs](https://code.claude.com/docs/en/costs)) | invalidates from first changed token ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | miss | unobservable |
| **TTL** | 5m default; `ttl:"1h"` available ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | `prompt_cache_options.ttl` = `30m` (only value) ([OpenAI](https://platform.openai.com/docs/guides/prompt-caching)) | best-effort; cleared after hours to days ([DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)) | n/a |
| **Write cost** | 5m = 1.25× base input; 1h = 2×; read = 0.1× ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) | not priced here | priced by hit/miss split ([DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)) | n/a |

Note the Claude Code overlay: cache lifetime is 1 hour on a subscription but drops to 5 minutes on usage credits or an API key, and `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts only `5m` or `1h` ([Claude Code costs](https://code.claude.com/docs/en/costs); [Claude Code env vars](https://docs.claude.com/en/docs/claude-code/env-vars), [P]).

### 4.5 Compaction policy

Trigger on **remaining window**, not a fixed token count. On the Claude side set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to a plain integer in 100000–1000000 (it overrides `/autocompact`, `--autocompact`, and the `autoCompactWindow` setting) and use `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100) to compact earlier ([Claude Code env vars](https://docs.claude.com/en/docs/claude-code/env-vars), [P]). On Codex use `model_auto_compact_token_limit` together with `model_auto_compact_token_limit_scope` — default `total`; switching to `body_after_prefix` measures only growth beyond the carried compaction-window prefix, which is exactly the number that matters for cache economics ([Codex config reference](https://developers.openai.com/codex/config-reference), [P]). Rules: (1) compact only at a **turn boundary** after a tool result, never mid-tool-call; (2) never compact immediately before or after an agent/model switch, since compaction is a guaranteed expected rebuild and stacking it on a switch pays the write twice; (3) after compaction, **re-pin the prefix** — identical system prompt and tool order — so the next write establishes a new entry rather than thrashing; (4) choose TTL by idle profile: 1h writes cost 2× versus 1.25× for 5m, so the 1-hour TTL only pays off when the user genuinely pauses more than five minutes between turns; a continuous coding loop is cheaper on 5m, which also refreshes at no extra cost on each read ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [P]).

### 4.6 Observability without extra requests

The UI should show, per turn: hit-rate %, cumulative session hit rate, cache-write spend in USD, a miss badge naming the likely cause (mirroring Claude Code's `likely cause: tool definitions changed`), and a warm/cold indicator with TTL and last activity ([Claude Code costs](https://code.claude.com/docs/en/costs), [P]). All of it comes **in-band** — Claude's `result`/streaming usage, Codex's `thread/tokenUsage/updated`, ACP's `usage_update` plus the optional RFD `usage` object if an agent starts sending it. No polling endpoint, no extra request, consistent with the repo's existing refusal to poll rate limits out of band.

**Summary.** Measure before optimizing: fix the `inputTokens` bug, ship the six-field `usage` block, and normalize hit rate to `cacheRead / (cacheRead + cacheWrite + netNew)`. Then make the prefix boring — frozen sorted tools pinned at thread creation, static/dynamic system-prompt split, append-only history, no mid-thread config churn, and no `unsubscribe`/`close` rebuilds. Everything else (TTL choice, compaction window) is second-order by comparison.

### 本章新增来源清单

1. [Anthropic — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) `[P]` — 4 breakpoints (auto caching consumes 1; 400 if full), `tools→system→messages` order, 5m/1h TTL, write 1.25×/2×, read 0.1×, 512–4096 token minimums, invalidation table, 20-block lookback, `input_tokens` = post-breakpoint only.
2. [OpenAI — Prompt caching guide](https://platform.openai.com/docs/guides/prompt-caching) `[P]` — 1024 visible-token minimum (GPT-5.6+), `input_tokens_details.cached_tokens` / `.cache_write_tokens`, `prompt_cache_options.ttl` = `30m` only, `prompt_cache_key` ~15 rpm sharding, 4 writes/request, invalidation list incl. `configuration_update` escape hatch, hit-rate formula.
3. [Claude Code — Manage costs](https://code.claude.com/docs/en/costs) `[P]` — miss threshold (">5% and at least 2,000 tokens"), expected rebuilds (compaction / tool-result clearing), 1h subscription vs 5m credits/API-key lifetime.
4. [Claude Code — Environment variables](https://docs.claude.com/en/docs/claude-code/env-vars) `[P]` — `CLAUDE_CODE_PROMPT_CACHE_TTL` (5m|1h), `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000–1000000, plain int), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100).
5. [Claude Agent SDK — Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) `[P]` — prompt recorded on first request and replayed until compaction; `snapshot:false` forbids cache reuse; `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; `excludeDynamicSections`.
6. [Codex — Config reference](https://developers.openai.com/codex/config-reference) `[P]` — `model_auto_compact_token_limit` and `model_auto_compact_token_limit_scope` (`total` default vs `body_after_prefix`).
7. [Codex app-server protocol schema (v2 JSON)](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json) `[P]` — verified `cachedInputTokens`, `cacheWriteInputTokens`, `netNewInputTokens`, `inputTokens`, `reasoningOutputTokens`, `TokenUsageBreakdown`, `TokenUsageUpdatedNotification`.
8. [DeepSeek — 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/) `[P]` — default-on; cache prefix unit requires complete match; three write timings; `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; best-effort, cleared after hours to days.
9. [ACP RFD — End-turn token usage](https://agentclientprotocol.com/rfds/end-turn-token-usage.md) `[P]` — strawman `usage.{totalTokens,inputTokens,outputTokens,thoughtTokens,cachedReadTokens,cachedWriteTokens}`; explicitly "not ready for Preview", kept in Draft.
10. [ACP v1 — Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) `[P]` — `usage_update` limited to `used`/`size` + optional `cost`; no cache dimension in v1.
11. Repo source (verified in-place, 2026-09) `[P]` — `src/shared/types.ts:187`, `src/main/agents/claude.ts:289`, `src/main/agents/codex.ts:35,152,314-318,368-369`, `src/main/agents/acp/driver.ts:39,180-184,260-266`, `src/main/service.ts:78`, `README.md:93`.

---


<a id="5-streaming-and-reasoning-transparency"></a>

## 5. Streaming and Reasoning Transparency: Extending the Canonical ThreadEvent Vocabulary with Incremental Deltas and Per-Driver Event Mapping

**Thesis.** Milestone 4's "responses must stream, and reasoning must be shown when the model produces it" is not a UI feature — it is an event-model feature. `src/shared/types.ts:181-189` defines a vocabulary of eight terminal `ThreadEvent` kinds, and the *only* incremental channel is `TurnInput.onTextDelta(text)` (`src/main/agents/types.ts:36`), broadcast as `LiveUpdate { type: "text-delta" }` (`src/main/service.ts:128`, `src/shared/types.ts:248`). Reasoning has no incremental path at all: Claude emits whole `thinking` blocks at `claude.ts:256-257`, Codex emits `summary.join("\n\n")` only at `item/completed` (`codex.ts:187-192`), and ACP accumulates `agent_thought_chunk` into `t.thought` until `flushText()` (`acp/driver.ts:154-156`, `:136-141`). One live scalar cannot express four concurrent streams, and a vocabulary without deltas cannot express reasoning.

### 5.1 Why a dual channel, not one

Deltas and terminal values answer different questions. A delta is *how the output arrived*; a terminal event is *what the output was*. Persisting only deltas is a trap: reconnect, renderer reload, and the Ch3 cross-agent handoff all need a replayable ground truth, and if each persisted delta carries a fresh snapshot of the accumulated text, one paragraph costs O(N²) bytes — and even snapshot-free deltas multiply row count by the number of chunks, so replay (including Ch3's cross-agent handoff) becomes linear in deltas rather than in items. Persisting only terminal values satisfies neither streaming nor "show reasoning as it happens". So the rule is: **deltas are live-only and never stored; terminal events are stored once per item and carry the full accumulated text plus Ch3's `payload`/`provenance`.** The existing comment at `src/shared/types.ts:179` ("`text-delta` is live-only and never stored") is already this rule — it simply needs to be generalised from one kind to a class of kinds. This also fixes a real bug at `src/renderer/src/store.ts:293`: `clearLive` wipes `liveText` on *any* stored non-`user` event, so today every Codex `thinking` and every Claude `tool-use` mid-turn blanks the streaming bubble. Live state must become per-item-keyed (`live: Record<itemId, string>`) and be cleared only by the matching terminal event.

### 5.2 Proposed vocabulary

| Canonical | Channel | Persisted? | Carries |
|---|---|---|---|
| `turn-start` | both | yes (marker) | `turnId`, `agent`, `model` |
| `text-delta` | live only | **no** | `itemId`, `text` |
| `assistant-text` | terminal | yes | full text, `payload`, `provenance` |
| `reasoning-delta` | live only | **no** | `itemId`, `text`, `opaque: boolean` |
| `reasoning-summary` | live only | **no** | `itemId`, `index`, `text` |
| `thinking` | terminal | yes | full text **or** `signature` (see 5.5), `opaque` |
| `tool-output-delta` | live only | **no** | `toolUseId`, `text` |
| `plan-delta` / `plan` | live / terminal | delta no, `plan` yes | entries |
| `usage-update` | live only | **no** | `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `costUsd`, `contextUsed/Size` |
| `thinking-progress` | live only | **no** | `estimatedTokens` (opaque-reasoning spinner) |
| `compaction` | terminal | yes (marker) | `trigger`, `preTokens`, `postTokens` |
| `turn-end` | terminal | yes | definitive totals incl. cache dims |

`usage-update` deliberately reuses Ch4's cache dimensions rather than inventing new ones, and `compaction` is recorded because compaction is precisely where the Anthropic prefix — and therefore the cache — restarts.

### 5.3 Per-driver mapping (core artifact)

Everything below is taken from the protocol sources, not from documentation memory; "as of 2026-09".

| Canonical | Claude (Agent SDK, `includePartialMessages: true`) | Codex (app-server v2) | ACP v1 |
|---|---|---|---|
| `turn-start` | `SDKPartialAssistantMessage.event.type === "message_start"` ([P](https://code.claude.com/docs/en/agent-sdk/streaming-output)) | `turn/started` → `params.turn.id` ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | No turn-start notification in v1; synthesize on `session/prompt` ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `text-delta` | `content_block_delta` + `delta.type === "text_delta"` → `delta.text` ([P](https://platform.claude.com/docs/en/build-with-claude/streaming)) | `item/agentMessage/delta` → `params.delta` ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | `agent_message_chunk` → `update.content.text` ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `reasoning-delta` | `delta.type === "thinking_delta"` → `delta.thinking` ([P](https://platform.claude.com/docs/en/build-with-claude/streaming)) | `item/reasoning/textDelta` → `params.delta` (+`contentIndex`) ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | `agent_thought_chunk` → `update.content.text` ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `reasoning-summary` | — (no summary channel) | `item/reasoning/summaryTextDelta` → `params.delta` (+`summaryIndex`; new index opened by `item/reasoning/summaryPartAdded`) ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | *unverified* whether any v1 agent emits summaries |
| reasoning signature | `delta.type === "signature_delta"` → `delta.signature` ([P](https://platform.claude.com/docs/en/build-with-claude/streaming)) | n/a | n/a |
| `tool-output-delta` | `input_json_delta` → `delta.partial_json` is **tool input**, not output: Claude has no tool-output stream | `item/commandExecution/outputDelta` → `params.delta`. `item/fileChange/outputDelta` is **deprecated — "the server no longer emits this notification"** ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | `tool_call_update.content[]` → `c.content.text` ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `plan-delta` | — | `item/plan/delta`, flagged **EXPERIMENTAL - proposed plan streaming deltas for plan items**: "clients should not assume concatenated deltas match the completed plan item content". Prefer the stable whole-plan channel `turn/plan/updated` → `TurnPlanUpdatedNotification.params.{threadId, turnId, plan: TurnPlanStep[]{step,status}, explanation?}` for the terminal `plan` event ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | `plan` is a whole-plan replacement, not chunked ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `usage-update` | `message_delta` → `data.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`, **cumulative** ([P](https://platform.claude.com/docs/en/build-with-claude/streaming)) | `thread/tokenUsage/updated` → `tokenUsage.last.{inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | `usage_update` → `used`, `size`, `cost.{amount,currency}` — **no cache dimension** ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `thinking-progress` | `SDKThinkingTokensMessage`: `type:"system"`, `subtype:"thinking_tokens"`, `estimated_tokens`, `estimated_tokens_delta` — "digested from `thinking_delta.estimated_tokens` during the redacted-thinking phase (where the API otherwise streams only pings)" (installed `@anthropic-ai/claude-agent-sdk` 0.3.281 `sdk.d.ts:5878-5889`) [P] | n/a | n/a |
| `compaction` | `SDKCompactBoundaryMessage`: `type:"system"`, `subtype:"compact_boundary"`, `compact_metadata.{trigger:"manual"\|"auto", pre_tokens, post_tokens?}` (`sdk.d.ts:3589-3597`) [P] | `thread/compacted` → `params.{threadId, turnId}` — **deprecated**, schema description: "Deprecated: Use `ContextCompaction` item type instead."; replacement path is `item/started` / `item/completed` with `ThreadItem.type === "contextCompaction"` (`ContextCompactionThreadItem`, `{ id, type: "contextCompaction" }`) ([P](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) | **absent** — v1 defines no compaction update; the prompt-turn page enumerates the complete `SessionUpdate` set (`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`) with no compaction variant ([P](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)) |
| `turn-end` | `type:"result"` (`claude.ts:285-297`) | `turn/completed` → `status ∈ completed\|interrupted\|failed\|inProgress` | `session/prompt` response `stopReason ∈ end_turn\|max_tokens\|max_turn_requests\|refusal\|cancelled` |

### 5.4 File-level changes

- **`claude.ts:242-247`** — the `stream_event` branch must stop being a `text_delta` filter. Switch on `ev.delta.type` and add `thinking_delta` → `reasoning-delta`, `signature_delta` → attach to the pending `thinking` terminal event, `input_json_delta` → `tool-input-delta`. Note the guard at `:243` (`if (message.parent_tool_use_id) return;`) is dead weight for stream events: the SDK docs state `parent_tool_use_id` is always `null` on `SDKPartialAssistantMessage`, and that "stream events are emitted for the main session only; token-level deltas from subagents aren't forwarded" — subagent attribution must keep coming from complete messages via `parent_tool_use_id`, not from deltas. Keep the guard (harmless) but do **not** extend subagent filtering to reasoning, or you will drop nothing and gain nothing. [P]
- **`codex.ts:135`** — the `params` cast lacks `contentIndex` / `summaryIndex`. Add cases to the switch at `:138-172` for `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/commandExecution/outputDelta`, and (behind a capability flag) `item/plan/delta`; accumulate into the existing `t.deltas` map keyed by `itemId`. Do **not** build on `item/fileChange/outputDelta`. Also add the compaction signal that 5.3 confirms exists: handle `thread/compacted` (deprecated but still in the schema) and, as the forward-looking path, `item/started` / `item/completed` with `item.type === "contextCompaction"`; both emit the persisted `compaction` marker.
- **`acp/driver.ts:154-156`** — replace `t.thought += …` with an immediate `onReasoningDelta` (ACP v1 does not *require* agents to emit thought chunks in real time, so a driver capability flag must state whether this agent streams thoughts; if not, the terminal `thinking` at `flushText()` is the only thing users see). `:157-179` must also surface intermediate `tool_call_update.content` instead of discarding everything until `status === "completed" | "failed"`. `:180-187` should emit `usage-update` rather than only mutating local state. [P] The ACP column above is not hypothetical: OpenCode is registered here as a built-in ACP agent (`src/main/agents/registry.ts:34-39` — `id:"opencode"`, `command:"opencode"`, `args:["acp"]`, homepage `https://opencode.ai/docs/acp/`), so it is one of the real v1 servers the driver must interop with; its *separate* HTTP SDK (`session.prompt` with `body.noReply`, `session.abort`, `session.summarize`, `session.revert`/`unrevert`, `event.subscribe()`) documents the same session-level capabilities from the non-ACP side and is a useful cross-check on what the agent actually implements — but it is **not** the ACP wire format, so do not map events from it. [S]

### 5.5 What "show reasoning" actually means

Show reasoning **only when a reasoning stream exists** — no placeholder row, no spinner-for-spinner's-sake. Default the block **collapsed**, auto-expanding only while it is the newest thing on screen, with a "reasoning…" state driven by `thinking-progress` (Claude's `estimated_tokens`) when the stream is opaque. Distinguish two very different contents: Codex's `summaryTextDelta` is a curated **summary**, `textDelta` is **verbatim**; OpenAI-family reasoning items may be encrypted/redacted so only the summary is reachable. And critically: **opaque reasoning is not text.** Anthropic's preserved-thinking model binds each `thinking` block's `signature` to both the model and the exact preceding prefix; on Claude Fable 5.1 the `thinking` field is empty and the `signature` *carries* the reasoning, so a serializer that drops "empty" blocks silently destroys replayability, and a tampered signature always 400s. Prefix edits that invalidate thinking are exactly the edits that restart the prompt cache — the same discipline Ch3 (`provenance`) and Ch4 (prefix stability) already impose. So never round-trip opaque reasoning as editable text; store it as an opaque `payload` with its signature. [P]

### 5.6 Engineering constraints

**Flood.** Coalesce deltas per `itemId` on a frame/16 ms timer, cap per-item accumulated size (e.g. truncate the live buffer, keep the tail), and hard-cap persisted terminal text — the delta stream is the volume, the terminal event is the ceiling. **Ordering.** `StoredEvent.seq` keeps terminal order; live deltas need their own per-item monotonic index, and the renderer must drop deltas whose terminal event already landed. **Interruption.** On abort, flush accumulated buffers as terminal events before emitting the existing `notice`: `codex.ts:363` already special-cases `turn.status === "interrupted"`, and ACP maps `stopReason === "cancelled"` at `acp/driver.ts:382`; unflushed deltas must not vanish. **Renderer.** `ThreadView.tsx:47` renders `<Markdown text={live} streaming />`, and `markdown.tsx:14` (`const blocks = parseBlocks(text)`, inside `export function Markdown` at `:13`) re-parses the whole string on every delta — O(N) per token. Fix by coalescing in the store (5.1) and by rendering the streaming tail as plain text, parsing markdown only for terminal events. **Mutual exclusion.** `thinking-progress` (the opaque-reasoning `estimatedTokens` spinner) and visible `reasoning-delta` must never drive the *same* UI element: they are alternative renderings of one state, not two signals to merge. On models where reasoning lives entirely in the `signature` and the `thinking` field is empty (5.5), a jointly-driven element renders a permanently blank reasoning block — the spinner fills the slot, the text never arrives, and the user sees a reasoning pane that is open and empty for the whole turn. Rule: pick the channel by `opaque` — opaque reasoning renders `thinking-progress` only (a token counter, never a text box), transparent reasoning renders `reasoning-delta` only; a turn that starts opaque and later produces text must tear down the spinner element before mounting the text block, not grow into it.

### 5.7 Why this is the first thing to get right

The same terminal events that make the UI replayable are what Ch3 replays across an agent switch, and the same `usage-update` that shows a token ticker is what Ch4 measures cache hit rate with. Get the vocabulary wrong and every later chapter re-encodes it.

### 本章新增来源清单

1. [P] [Anthropic — Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) — exact event types; `text_delta`/`thinking`/`input_json_delta`/`signature_delta` fields; `message_delta.usage` cumulative with `cache_read_input_tokens` / `cache_creation_input_tokens`.
2. [P] [Anthropic — Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) — `signature` binds model + prefix; Fable 5.1 reasoning lives in the signature; prefix stability = cache stability.
3. [P] [Anthropic — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — cache usage field names; 5-minute default TTL, 1h option; 4 breakpoints.
4. [P] [Claude Agent SDK — Streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output) — `includePartialMessages`; raw non-accumulated events; subagent deltas not forwarded; `parent_tool_use_id` null on stream events.
5. [P] Installed `@anthropic-ai/claude-agent-sdk@0.3.281`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `SDKPartialAssistantMessage` (l.5282), `SDKCompactBoundaryMessage` (l.3589), `SDKThinkingTokensMessage` (l.5878); `@anthropic-ai/sdk` `BetaSignatureDelta`.
6. [P] [codex app-server protocol v2 schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json) — verified notification names and params; `item/fileChange/outputDelta` deprecated ("server no longer emits"); `item/plan/delta` experimental; `TokenUsageBreakdown` fields; `thread/compacted` (deprecated) → `ContextCompactedNotification.{threadId,turnId}` and `ThreadItem` variant `type:"contextCompaction"`; `turn/plan/updated` → `TurnPlanUpdatedNotification.{plan,explanation}`; `item/started`/`item/completed` carry a full `ThreadItem`.
7. [P] [ACP v1 — Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) — full `sessionUpdate` variant set; `agent_thought_chunk`, `tool_call_update.content`, `usage_update` (`used`/`size`/`cost`), stop reasons incl. `cancelled`.
8. [P] [OpenCode SDK](https://opencode.ai/docs/sdk/) — `session.prompt` with `body.noReply`, `session.abort`, `session.summarize`, `session.revert`/`unrevert`, `event.subscribe()`. Used in 5.4 only as a capability cross-check for OpenCode, which this repo registers as a built-in **ACP** agent (`opencode acp`, homepage `https://opencode.ai/docs/acp/`); this HTTP SDK is *not* the ACP wire format.
9. [S] Local repo — `src/shared/types.ts`, `src/main/agents/{types,claude,codex,registry}.ts`, `src/main/agents/acp/driver.ts`, `src/renderer/src/{store.ts,components/ThreadView.tsx,markdown.tsx}`.

**Notes:** (a) 9 sources, 4 types (vendor API docs, vendor SDK docs, protocol schema/spec, local source). (b) Codex **does** have a compaction signal — `thread/compacted` (deprecated, "Use `ContextCompaction` item type instead") plus the `ThreadItem` variant `type:"contextCompaction"` delivered over `item/started`/`item/completed` — see 5.3; ACP v1 has none, and the prompt-turn page enumerates the complete `SessionUpdate` set, so that absence is verified rather than assumed. Both columns were re-checked against the v2 schema and the ACP v1 pages; do not fill either in from memory. Remaining *unverified* item: ACP reasoning summaries. (c) One cross-chapter action item for Ch4: `claude.ts:289` adds `cache_read_input_tokens` into `inputTokens` but ignores `cache_creation_input_tokens`; the new `usage-update` shape fixes this at the source.

---


<a id="6-milestone-4-roadmap"></a>

## 6. Milestone 4 Roadmap: File-Level Change Manifest, Migration Sequencing, Test and Smoke Plan, and Irreversible Risk Points

Tags below: **[S]** = sourced fact (link attached), **[P]** = engineering judgment, **[U]** = unverified, needs spiking.

### 6.1 The sequencing argument: substrate first

M4 is not one release; it is a dependency graph, and the cheapest ordering is to land the **widest-blast-radius, purely additive** layers first. That means the canonical event vocabulary (Ch5) and the usage fields (Ch4) ship before any provider or handoff work.

The reason is arithmetic, not aesthetics. Anthropic's usage model separates three disjoint quantities: `cache_read_input_tokens` (tokens before the breakpoint already cached), `cache_creation_input_tokens` (being written now), and `input_tokens` (**"tokens after your last breakpoint (not eligible for cache)"**), with `total_input_tokens = cache_read + cache_creation + input` ([Anthropic prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)) **[S]**. The current harness folding `cache_read_input_tokens` into `inputTokens` is therefore a double-count, not an approximation. If we fix it *after* providers, injection and handoff land, then every driver adapter, every handoff loss report, and every already-persisted `events` row carries the wrong shape — and re-deriving history requires a second migration. Likewise, the event vocabulary is the type that `db.ts`, `shared/types.ts`, the renderer store, and all four drivers read; changing it late means touching all of them twice. **[P]**

### 6.2 Milestone slices (each independently shippable)

| Slice | Goal | Main files | Exit criterion | Why it can ship alone |
|---|---|---|---|---|
| **M4.0** | Event + usage substrate | `shared/types.ts`, `db.ts`, `agents/*.ts` | `pnpm typecheck` green; unit test asserts hit-rate formula | Purely additive; UI unaffected; old fields retained |
| **M4.0a** | CI workflow (new; see §6.5) | `.github/workflows/ci.yml` (new), `vitest.config.ts` | Real `codex app-server` e2e runs on a Linux-only job; fixtures + unit tests green on Linux/macOS/Windows; no Antigravity/Gemini job exists | No product code changes; can land before or after M4.0 **[P]** |
| **M4.1** | BYOK provider registry | `providers.ts` (new), `settings.ts` | Snapshot tests for config generation + backup/restore | BYOK works while other drivers still use legacy paths |
| **M4.2** | Injection adapters | `providers/inject-{claude,codex,opencode,acp}.ts` (new) | All four drivers complete one turn against a fake endpoint | Per-provider feature flag; opt-in |
| **M4.3** | Capability parity + two defect fixes | `agents/types.ts`, `registry.ts`, `claude.ts`, `codex.ts`, `acp/driver.ts`, `guard.ts`, `mcp/servers.ts`, `mcp-http.ts` | `capabilities` drives UI branching; no `driver.id` switch left in `service.ts` | Behaviour-preserving for the drivers already working |
| **M4.4** | Cross-agent handoff | `handoff.ts` (new), `db.ts` | Handoff invariant suite passes | Gated behind the confirmation card |
| **M4.5** | Cache discipline + streaming polish | `cache-policy.ts` (new), `agents/rpc.ts`, renderer `store.ts` | Prefix-stability assertions; delta ordering tests | Observability/perf only, no schema change |
| **M4.6** | Antigravity (opt-in) | `providers/inject-acp.ts`, `SettingsSheet.tsx` | ToS acknowledgement gate in UI | Default-off, legally gated |

### 6.3 File-level change manifest

| File | Change | Key points | Blast radius |
|---|---|---|---|
| `src/shared/types.ts` | Modify | Extend `ThreadEvent`/`LiveUpdate`; `UnskilledApi` gains provider+handoff methods; keep `sessionId` one version as read-only projection | **IPC contract** — main + preload + renderer must move in lockstep |
| `src/preload/index.ts` | Modify | Mirror `window.unskilled` surface | IPC |
| `src/main/db.ts` | Modify | `threads` + `bindings` column; `events` + `provenance`/semantic ids/`payload_ref`/`payload_bytes` (tool I/O stays in the existing event-JSON `payload` column); new `blobs` table for large tool I/O | **Persistence** (additive `ALTER TABLE ADD COLUMN`) |
| `src/main/settings.ts` | Modify | **Introduce** `schemaVersion` (the file has none today — §6.4, not a bump) and forward-migrate into `providers`; `secrets.*` kept for one version; safeStorage retained, but its `available` flag re-sourced from `getSelectedStorageBackend()` | Persistence |
| `src/main/providers.ts` | **New (proposed)** | `Provider` registry, encryption, model lists, retries | — |
| `src/main/providers/inject-claude.ts` | **New (proposed)** | Must spread `process.env`; Agent SDK `Options.env` **"replaces the subprocess environment instead of merging with `process.env`"** ([Claude Agent SDK, TS](https://code.claude.com/docs/en/agent-sdk/typescript)) **[S]** | Restart agent |
| `src/main/providers/inject-codex.ts` | **New (proposed)** | Write `$CODEX_HOME/<id>.config.toml` + `--profile`; provider keys are **user-level only** and ignored project-local ([Codex config reference](https://developers.openai.com/codex/config-reference)) **[S]** | Restart agent; **writes user files** |
| `src/main/providers/inject-opencode.ts` | **New (proposed)** | Spawn env `OPENCODE_API_KEY`; guardrails via plugin `tool.execute.before`, which can `throw` to block ([OpenCode plugins](https://opencode.ai/docs/plugins/)) **[S]** | Restart agent |
| `src/main/providers/inject-acp.ts` | **New (proposed)** | Env only — ACP has `authenticate` but no credential-passing channel ([ACP overview](https://agentclientprotocol.com/protocol/v1/overview)) **[S]** | Restart agent |
| `src/main/handoff.ts` | **New (proposed)** | Export → checkpoint w/ token budget → seed; git checkpoint | — |
| `src/main/cache-policy.ts` | **New (proposed)** | Prefix-stability rules, TTL matrix, no-compaction windows | — |
| `src/main/agents/{types,registry,claude,codex,acp/driver,rpc,limits}.ts` | Modify | `capabilities` descriptor; fix the `untrusted` approval policy (Codex docs: **"no longer supported"** → `on-request`) **[S]** — mind the two spellings: the repo sends camelCase **`approvalPolicy`** over JSON-RPC (`src/main/agents/codex.ts:64`, `codexPolicy()`), while TOML/doc text uses snake_case **`approval_policy`**, so fix both call sites and the docs in the same change **[P]**; surface ACP's `agentCapabilities.mcpCapabilities.http` as a declared capability instead of an ad-hoc read (it is already consumed at `src/main/agents/acp/driver.ts:248` as `Boolean(...)`, so an absent field means `false`, matching the spec default ([ACP Initialization](https://agentclientprotocol.com/protocol/v1/initialization)) **[S]**); notification mapping | Restart agent |
| `src/main/guard.ts`, `src/main/mcp/{servers,external}.ts`, `src/main/mcp-http.ts` | Modify | Branch on capability, not `driver.id`; queue MCP changes to turn boundaries | Cache |
| `src/renderer/src/{store.ts,components/*}` | Modify | Settings, handoff card, folding reasoning display | — |
| `scripts/smoke.mjs`, `test/*` | Modify | Extend `--smoke` with provider + handoff checks | — |

### 6.4 Persistence and IPC contract migration

**DB: append to the migration array that already exists.** `src/main/db.ts` ships the machinery: a `schema_version` table (`db.ts:35`) and an additive `steps: string[]` loop (`migrate()`, `:48-62`) that runs each step once, bumps `version`, and skips step 0 on a fresh DB that already has the column (`:59`). Today `steps` holds exactly one entry — `ALTER TABLE threads ADD COLUMN agent` (`:51`). M4's new columns (`threads`/`bindings`, `events`/`provenance`/semantic ids/`payload_ref`/`payload_bytes`, plus the new `blobs` and `injection_ledger` tables) are appended as entries 2..n; SQLite still needs no table rewrite because every step stays an `ALTER TABLE ADD COLUMN` / `CREATE TABLE IF NOT EXISTS`. **[P]** One caveat: the fresh-DB guard inspects only `PRAGMA table_info(threads)` (`:57`), so a step targeting `events` or a new table needs its own existence guard (or a `try/catch`) — otherwise re-running an `ADD COLUMN` that a newer `CREATE TABLE` already emitted throws. **[P]** And `events` already has a column named `payload` (the whole event JSON, `db.ts:36-42`), so the new tool-I/O field cannot be an `ADD COLUMN payload`: keep full tool input/output inside the event JSON and add only `provenance`, the semantic-id columns, and `payload_ref`/`payload_bytes` for blob offload. **[P]**

**`settings.json`: this is an introduction, not a bump.** The file has no version field at all today: `SettingsStore` persists `FileShape = { settings?, secrets? }` (`src/main/settings.ts:21-24`) and `schemaVersion` appears nowhere in `src/`. So M4.1 **adds** `schemaVersion`, treating a missing field as the legacy v1 shape and writing `2` (matching Ch. 1 §1.2's `schemaVersion < 2` test), and migrates forward into `providers`; `secrets.*` stays for one release so a downgrade still decrypts. **[P]** Trap to handle: `read()` already resets a corrupt file to `{}` (`settings.ts:41-47`), so the migration must tolerate an empty `FileShape`, not just an old one. **[P]**

Critically, `Thread.sessionId` must survive as a **read-only projection** of `bindings[activeProviderKey]` for one version — otherwise a rollback from M4.4 loses session continuity irrecoverably, since `sessionId`→`bindings` is a one-way transform (you can synthesise the old field from the new map, but not vice versa). **[P]**

**safeStorage: fix the detection source, not just the wording.** On Linux, safeStorage-protected content **may be unprotected where no secret store is available**: *"If no secret store is available, items stored in using the `safeStorage` API will be unprotected as they are encrypted via hardcoded plaintext password. You can detect when this happens when `safeStorage.getSelectedStorageBackend()` returns `basic_text`"* ([Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)) **[S]**. The app currently derives `SecretBox.available` from `safeStorage.isEncryptionAvailable()` (`src/main/index.ts:133`), which Electron documents only as *"On Linux, returns true if the app has emitted the `ready` event and the secret key is available"* **[S]** — it can be `true` under the `basic_text` backend, so it cannot detect this case. Switch the flag's source to `safeStorage.getSelectedStorageBackend() !== "basic_text"` on Linux (the method is Linux-only) — that value is what `settings.ts:66` publishes as `secretsEncrypted` and what `SettingsSheet.tsx:128` renders as *"Stored encrypted with your system keychain…"*, so today the UI can overstate the protection. **[P]** Plaintext fallback must therefore be an explicit, surfaced state, not a silent one.

### 6.5 Test and smoke plan

**Fixtures: three new, plus two existing ones reused/extended.** Two of the five building blocks already exist in the suite (`vitest.config.ts` collects `test/**/*.test.ts`), so M4 adds three and re-wires two.

**(1) Fake ACP agent — reuse `test/fixtures/mock-acp-agent.mjs`; no new file.** It exists today (header: *"A tiny ACP agent over stdio for tests"*) and is already driven by `test/acp.test.ts:11` (`const MOCK = join(__dirname, "fixtures", "mock-acp-agent.mjs")`, spawned with `command: process.execPath`). It implements `initialize` (advertising `agentCapabilities.mcpCapabilities.http: true`, `:51`) and `session/new|resume|close|cancel|set_config_option`, plus scripted `session/prompt` scenarios — `tool` (permission round-trip via `session/request_permission`), `slow` (streams until `session/cancel`), `mcp` (echoes back the servers it was handed), and a default text answer — emitting `session/update` notifications for `agent_thought_chunk` (`:78`), `agent_message_chunk`, `tool_call`/`tool_call_update` and `usage_update`. Thought chunks are therefore **already covered**; no new scenario or file is needed to start, and extension happens in place only if M4.3 adds notification kinds it lacks. ACP is **JSON-RPC 2.0** with two message types — *"Notifications: One-way messages that don't expect a response"*, and *"Notifications never receive responses (success or error)"* ([ACP overview](https://agentclientprotocol.com/protocol/v1/overview); [JSON-RPC 2.0 spec](https://www.jsonrpc.org/specification)) **[S]** — which is exactly why a scripted fixture, not a real agent, is the deterministic way to cover this path. **[P]**

**(2) Fake OpenAI-compatible endpoint — extract, then extend.** One already exists as a **private in-file function**: `fakeModel()` at `test/codex-e2e.test.ts:23`, a local Responses API server (SSE `response.created` → `response.output_item.done` → `response.completed`, plus the `x-codex-*` rate-limit headers) that the real-`codex app-server` e2e runs against. Being file-private, unit-level tests cannot import it. M4.1/M4.2 extract it into `test/fixtures/fake-openai.mjs` (new file) and add the **401/404/400 states** and a **tool-call probe branch**, so `wireProtocol` can be triaged without a real provider. `fakeAnthropic()` at `test/claude-e2e.test.ts:19` (fake Messages API) gets the same treatment if M4.1's snapshot tests need it. Codex-compatible providers are wired via `model_providers.<id>.base_url` ([Codex config reference](https://developers.openai.com/codex/config-reference)) **[S]**, so this doubles as a probe fixture. **[P]**

**(3) [new] Config-generation snapshot tests** — especially Codex `config.toml` emission plus backup/restore round-trip (Vitest `toMatchSnapshot` ([docs](https://vitest.dev/guide/snapshot.html)) **[S]**). **(4) [new] Handoff invariants** — no side-effecting tool is replayed after a switch, `provenance` is complete, no `bindings` entry is dropped. **(5) [new] Cache-field and delta-ordering assertions** — hit-rate formula; coalescing/throttle preserves order.

**CI split — the premise is wrong twice, so the plan changes [P].**

- **(a) Today's gating is binary presence, not platform.** `test/codex-e2e.test.ts:20` sets `const codex = process.env.UNSKILLED_CODEX_BIN ?? (onPath("codex") ? "codex" : null)` and `:66` wraps the suite in `describe.skipIf(!codex)`; the file contains **no** `process.platform` check, so the suite runs on whatever OS has a `codex` binary. `test/claude-e2e.test.ts:74` has no gate at all (a plain `describe(...)`). "Linux-only" is therefore not the status quo — it is a property we have to introduce.
- **(b) There is no CI in this repo.** No `.github/`, no `.gitlab-ci.yml`, no `.circleci/`; the only YAML is `electron-builder.yml` (packaging). `package.json` exposes `test` (`vitest run`) and `smoke` (`electron . --smoke`), but nothing invokes them automatically.

So M4.0 — or the separate slice **M4.0a** (§6.2) — must **create** the workflow, and the split belongs in the workflow, not in the test bodies:

1. Fixtures (1)–(5) and all unit tests: full OS matrix (Linux + macOS + Windows), on every push.
2. Real `codex app-server` e2e: Linux-only — as a separate single-OS job (kept outside the matrix) that installs `codex` and exports `UNSKILLED_CODEX_BIN`. The *test* stays gated on binary presence (`describe.skipIf(!codex)`), never on `runner.os`; the workflow decides where the binary exists. The in-test escape hatch stays, so a pinned binary can still run that suite locally on any OS.
3. Bundled Claude Code binary e2e: everywhere.
4. **Antigravity/Gemini must never run in CI**, enforced at the workflow layer, not by good intentions: (i) no Antigravity/Gemini credential is ever registered as a CI secret, and the job exports an explicit env allowlist (only `UNSKILLED_CODEX_BIN` and fake-endpoint variables); (ii) any spec that would drive them stays outside the `test/**/*.test.ts` include glob in `vitest.config.ts` (e.g. under a `manual/` path), so even a stray developer key cannot trigger it; (iii) the ToS acknowledgement gate (§6.6) stays default-off. **[P]**

### 6.6 Irreversible risk points and mitigations

| Risk | Mitigation |
|---|---|
| Overwriting user's `~/.codex/config.toml` | Back up with timestamp before any write; ship rollback; prefer a separate profile file over editing the main config **[P]** |
| `ANTHROPIC_*` env shadowing an active subscription login | Explicit "subscription login wins" switch + visible UI warning **[P]** |
| `Options.env` wiping `PATH`/`HOME` | Always `{ ...process.env, ... }` **[S]**; smoke-test asserts `PATH` non-empty in child |
| Antigravity account suspension | Antigravity ToS §6: *"Using third party software, tools, or services to access the Service … is a breach of this Agreement. Such actions may be grounds for suspension or termination"* ([ToS](https://antigravity.google/terms)) **[S]** → default-off + explicit acknowledgement |
| ACP has no credential channel → key lives in child env | Document exposure surface; prefer short-lived child processes; never log env **[P]** |
| MCP change mid-session destroys cache | Anthropic: *"Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache"* ([prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)) **[S]** → queue MCP mutations to turn boundaries |
| Full-payload event logging grows disk | Blob table + size caps + retention policy **[P]** |
| `sessionId`→`bindings` one-way | Export/import thread JSON before migration; keep read-only projection one version **[P]** |

### 6.7 Release strategy

Ship per-provider behind feature flags, Codex and Claude first (highest user overlap), Antigravity last and opt-in. Telemetry stays **zero** — consistent with the repo's existing stance that rate-limit handling never issues extra requests. **[P]** Roll back to Milestone 3 behaviour if: any provider silently downgrades a subscription login; config-file backup/restore fails on any platform; or the post-M4.5 cache-hit regression crosses a pinned threshold — **(a)** cache read hit-rate, defined as `cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens + input_tokens)` (the M4.0 definition, Ch4/§6.1), aggregated over the first 7 days after the M4.5 release, falls **more than 5 percentage points** below the M3 baseline captured over the 7 days before it (assertion form: `expect(hitRate(m4_5) - hitRate(m3)).toBeGreaterThan(-0.05)`); or **(b)** the M4.5 prefix-stability assertions fail on **more than 1%** of turns. Because telemetry is zero, both figures are computed locally from the persisted `turn-end` usage fields and never leave the machine. **[P]**

### 小结

The ordering is the deliverable: **event model → usage → registry → injection → parity → handoff → cache/streaming polish**. Every later slice writes into the substrate M4.0 defines, so reversing the order multiplies migration cost; and the only genuinely irreversible operations are the user-file writes and the `sessionId`→`bindings` transform — both of which are cheap to make reversible *before* release and expensive after. **[P]**

### 本章新增来源清单

1. [Anthropic — Prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) — *vendor docs*: usage field semantics (`input_tokens` = post-breakpoint only; total formula), 5-minute TTL, tools→system→messages invalidation hierarchy, tool-definition changes invalidate everything.
2. [Claude Agent SDK reference — TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) — *vendor docs*: `Options.env` replaces (not merges) the subprocess environment; `hooks` option shape.
3. [Codex Configuration Reference (OpenAI Developers)](https://developers.openai.com/codex/config-reference) — *vendor docs*: `~/.codex/config.toml`, `$CODEX_HOME/<name>.config.toml` + `--profile`, `model_providers.<id>.base_url`, `approval_policy:"untrusted"` no longer supported, project-local ignored keys.
4. [Agent Client Protocol — Overview](https://agentclientprotocol.com/protocol/v1/overview) — *protocol spec*: JSON-RPC 2.0, `initialize`/`authenticate`/`session/new`/`session/prompt`/`session/update`, client method `session/request_permission`; no credential channel.
5. [Agent Client Protocol — Initialization](https://agentclientprotocol.com/protocol/v1/initialization) — *protocol spec*: `agentCapabilities.mcpCapabilities.http` (default `false`) — the root cause of stdio-only ACP agents not receiving harness tools.
6. [OpenCode — Plugins](https://opencode.ai/docs/plugins/) — *vendor docs*: `tool.execute.before` hook can `throw` to block a tool call; plugin load order and directories.
7. [Google Antigravity — Terms of Service](https://antigravity.google/terms) — *legal/ToS*: §6 third-party access is a breach and "may be grounds for suspension or termination".
8. [Electron — safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) — *framework docs*: on Linux with no secret store, content is "encrypted via hardcoded plaintext password", detectable via `getSelectedStorageBackend() === 'basic_text'`; `isEncryptionAvailable()` on Linux only reports whether the secret key is available.
9. [Vitest — Snapshot testing](https://vitest.dev/guide/snapshot.html) — *framework docs*: `toMatchSnapshot`/`--update` workflow used for config-generation snapshot tests.
10. [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification) — *standards*: request/response vs notification semantics underpinning the fake-ACP-agent fixture.

<a id="7-uiux-for-a-centralized-harness"></a>

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

<a id="8-interaction-mechanics"></a>

## 8. Interaction Mechanics: Resizable Panels, Collapse, the Built-in Browser and the Agent Driving It, and One Rendering Contract for Four Agents

**Thesis.** Chapter 7 specified *what* the UI must say; this chapter specifies *how it must behave* — and the two hard requirements here are structural. First, the layout is currently frozen: `.app` is a CSS grid whose columns come from two constants, `--sidebar-w: 256px` and `--inspector-w: 460px` (`styles/app.css:40-41`, `:110`, `:114`). There is no drag handle, no minimum, no maximum, no persistence, no keyboard path, and no way to collapse the sidebar at all — `Sidebar.tsx`'s `collapsed` state collapses *project groups*, not the rail. Second, the four agents already share one browser pane and one transcript, but nothing in the UI tells the user that the agent is driving, and the rendering path has no cross-driver normalisation: `prettyTool` strips the `mcp__unskilled__` prefix that only Claude and Codex produce (`ThreadView.tsx:132-136`), and `markdown.tsx:14` re-parses the entire message on every delta. "It should work the same for text answers from any agent" is therefore not a styling task — it is a contract that has to be enforced in three places: the event vocabulary (Ch. 5), the driver adapters, and one renderer.

### 8.1 Resizable panels: the splitter contract

The accessibility baseline is the WAI-ARIA APG **Window Splitter** pattern: the divider is focusable, carries `role="separator"`, `aria-orientation`, `aria-valuenow`/`aria-valuemin`/`aria-valuemax` and `aria-controls` pointing at the primary pane, and responds to Left/Right (vertical splitter) or Up/Down (horizontal), with **Enter collapsing the pane or restoring its previous size**, and optional Home/End for min/max ([W3C APG](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)). MDN notes a *focusable* separator is treated as a widget, not a static rule ([MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/separator_role)).

The mechanics that make a splitter feel right, from the two libraries that ship this for real:

| Concern | Correct behaviour | Source |
|---|---|---|
| Hit target | 1px visual line inside a ≥27px invisible drag target (Apple HIG); Allotment uses a 20px feedback area | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels), [Allotment](https://github.com/johnwalley/allotment) |
| Clamping | explicit per-pane min/max; snap-to-zero below a threshold — Allotment calls it `snap`, react-resizable-panels `collapsedThreshold` | same |
| Reset | double-click the divider returns to the default size | same |
| Cursor | `col-resize` on hover, `grabbing` while dragging | desktop convention — the APG pattern does not specify cursor styling |
| Persistence | write on `pointerup`, **never** on every move — react-resizable-panels deliberately fires `onLayoutChanged` only on release | react-resizable-panels |
| Animation | **none during drag** (1:1 pointer tracking); animate only programmatic snap/collapse | [Chrome — animate to `height:auto`](https://developer.chrome.com/docs/css-ui/animate-to-height-auto) / desktop convention |

For this app the cheapest correct implementation keeps the existing CSS: leave `.app` as a grid and make the divider a sibling that writes `--sidebar-w` / `--inspector-w` on the root element. That preserves `app.css:108-114` untouched, keeps the inspector's `slide-in 220ms` (`app.css:524`) for open/close only, and avoids adopting a layout library into a repo that deliberately has no component library. Proposed bounds: sidebar 180–360 (rail 48), inspector 320–720, main pane never below 420. On window shrink the `1fr` main pane absorbs the change; when it would fall below its minimum, **auto-collapse the inspector** rather than overflowing — and restore it when the window grows back. That restore-on-grow rule is a design choice here, not a documented standard; Zed's panel system is the closest prior art ([Zed](https://zed.dev/blog/new-panel-system)).

### 8.2 Collapse and expand

Use the platform before inventing: native `<details>`/`<summary>` gives the twisty, keyboard activation and screen-reader open/closed announcements for free, and its `name` attribute groups several `<details>` into an accordion where only one is open ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details)). The reasoning block and each tool output are disclosures and should be `<details>` — they already are for reasoning (`ThreadView.tsx:79-85`) — but they must **not** be grouped with `name`, since a user can reasonably want two tool outputs open at once.

Controlled regions (the sidebar rail, the inspector) need an explicit toggle button with `aria-expanded` plus `aria-controls`; `aria-expanded` belongs on the focusable control, never on the region ([MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded)). Two details the docs are explicit about: `<details>` has **no built-in way to animate** open/closed, and the modern way to animate to intrinsic height is `interpolate-size: allow-keywords` (currently experimental; `calc-size()` where arithmetic is needed) rather than `max-height` hacks ([MDN `details`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details), [MDN `interpolate-size`](https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size), [Chrome](https://developer.chrome.com/docs/css-ui/animate-to-height-auto)). Add `content-visibility` so a collapsed 2000-line tool output costs nothing to keep in the DOM.

State policy: **panel geometry is a setting, disclosure state is view state.** Sidebar rail and inspector width persist in `settings.json` next to `theme`/`editor`; per-thread reasoning/tool disclosure stays in the renderer, keyed by thread id, and is not written to the database. `prefers-reduced-motion` disables all of it.

### 8.3 The built-in browser pane

The pane is a `<webview partition="persist:unskilled-browser">` (`BrowserPanel.tsx:117`) driven through the Chrome DevTools Protocol, with a toolbar of back/forward/reload/address/pick (`:82-116`). Two things to keep and four to add.

**Keep:** the sandbox posture. Electron's guidance for remote content is explicit — disable `nodeIntegration`, enable `contextIsolation`, keep the sandbox, strip preload in `will-attach-webview`, and set a permission handler ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)); `BrowserView` is deprecated in favour of `WebContentsView` ([Electron migration](https://www.electronjs.org/blog/migrate-to-webcontentsview)). The repo's existing choice — no Node access, no preload, http(s)/file/data only (`README.md`) — is the right one and should be asserted in the smoke test, not just documented.

**Add:**
1. **Device emulation.** `Emulation.setDeviceMetricsOverride` is the CDP domain for viewport/device emulation ([CDP](https://chromedevtools.github.io/devtools-protocol/)). Presets (mobile 390 / tablet 768 / desktop) matter more in this app than in a normal browser: an agent verifying responsive UI in a 460px column is verifying nothing. Both the user *and* the agent should be able to request a preset, which means it belongs in the tool surface too.
2. **A way to widen the pane.** "Move to main area" — the browser takes the full width beside the sidebar, and the conversation collapses to a rail. This is the single highest-value layout feature for a coding harness, because it is the only way to see a real desktop-width page while still watching the agent work.
3. **Console and network.** The controller already collects console errors, exceptions and failed requests for `browser_logs`; the pane should show the same data as a tab (fed by CDP `Log` and `Network`), so the user does not have to ask the agent what the console said.
4. **Screenshot strip.** `browser_screenshot` saves a file (`browser/tools.ts:78-89`); show thumbnails in the pane so the user sees the evidence the agent collected, and can open it at full size.

### 8.4 The agent driving the same page: a take-over model

Today the only signal is that opening the pane happens when the agent calls `browser_open` (`store.ts:316-318`). There is no indication that the page is *under agent control*, no way to pause, and no arbitration when the human clicks something mid-run. This is genuinely unsolved across the industry — the closest documented product model is Browserbase's Session Live View, an embeddable interactive window with explicit **read-only vs read-write** modes for "human in the loop — instantly take control or provide input" ([Browserbase](https://docs.browserbase.com/platform/browser/observability/session-live-view)); `chrome-devtools-mcp` shows the other half, letting an agent "control and inspect a live Chrome browser" while warning that it exposes the browser's content to the client ([chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp/)). Playwright's UI Mode and Trace Viewer are excellent human debugging surfaces but are not shared-control models ([Playwright UI Mode](https://playwright.dev/docs/test-ui-mode)). There is **no convention for who owns the pointer** `[U]`.

The specification, then: one tab state machine — `idle` · `agent-driving` · `human-driving` — with an **exclusive lock**.

- **`agent-driving`:** a persistent banner (not a toast) naming the agent, a step counter, a **Stop** button wired to the turn's abort, and an animated outline on the viewport. The address bar shows a lock; typing a URL or pressing Escape pauses the agent rather than fighting it.
- **Human input wins.** Any click or keypress inside the pane transitions to `human-driving` and *pauses* the agent, surfacing "You took over — the agent is paused · Resume". Two drivers on one pointer is a bug, not a feature.
- **Two-way highlight.** Every agent action already appears in the transcript as a tool row; add a brief ring on the element it acted on, so the pane and the transcript stay in sync.
- **Read-only watch mode** for people who want to see without risking a stray click.
- **One banner component, two modes.** The element picker (`picking`, `startPick`, `BrowserPanel.tsx:108-115`) is already a mode; it should reuse the same banner with a different label rather than inventing a second visual language.

### 8.5 One rendering contract for four agents

This is the "text answers should render the same regardless of the agent" requirement, and it is a contract with three parts.

**1. Pin the dialect.** One parser, one highlighter theme, for every driver. The reference is CommonMark 0.31.2 ([spec](https://spec.commonmark.org/0.31.2/)) plus GFM, "a strict superset of CommonMark" adding four documented extensions — tables (§4.10), task list items (§5.3), strikethrough (§6.5), autolinks (§6.9) — after which GitHub applies its own post-processing and sanitisation ([GFM](https://github.github.com/gfm/)). All four agents emit roughly GFM; if the harness parses them through different paths, they will visibly diverge.

**2. Normalise before rendering, in the adapters.** The canonical event vocabulary (Ch. 5) makes this possible; the work is choosing one representation per concept. Tool names: one mapping table, with `prettyTool`'s prefix-stripping moved into the driver adapters so a Codex `commandExecution`, an ACP `execute`, and Claude's `Bash` all render as the same *Run* row. File paths: one parser (the existing `fileref.ts` is already shared — keep it that way). Diffs: one renderer for `file_change`, `apply_patch` and ACP `tool_call_update` content. Results: one truncation rule, so a 10k-line command output looks the same whether it came from Codex or Claude.

**3. Stream without re-parsing.** Keep completed blocks frozen — memoised by content hash — and render only the **tail** as plain text until its block closes; that is precisely the problem purpose-built streaming renderers solve, handling "incomplete or unterminated Markdown blocks" ([Streamdown](https://github.com/vercel/streamdown)). This fixes partial code fences and partial tables, and it fixes the cost problem at `markdown.tsx:14`, where the whole string is re-parsed per delta. Safety: React's `dangerouslySetInnerHTML` performs **no** sanitisation, and model output is untrusted input, so every rendered node goes through a sanitiser ([DOMPurify](https://github.com/cure53/DOMPurify), or `rehype-harden` as Streamdown uses).

**The test that makes it real:** build one canonical event set, run it through all four driver adapters, snapshot the rendered DOM, and assert the four snapshots are identical. Anything that differs is a normalisation bug, and it is caught in CI rather than by a user noticing that OpenCode's output looks different from Claude's.

### 8.6 File manifest and acceptance tests

**New (proposed):** `Splitter.tsx` (APG-conformant divider writing the layout custom properties), `PaneRail.tsx` (collapsed sidebar), `TakeOverBanner.tsx` (driving / picking / paused), `BrowserToolbar.tsx` (zoom, device presets, console tab), `ScreenshotStrip.tsx`, `usePaneLayout.ts` (persist + clamp + window-shrink policy).
**Modified:** `styles/app.css` (separator, rail, banner, device frame), `App.tsx` (layout composition, keyboard), `Inspector.tsx` (`role="tabpanel"` + `aria-controls`, widen-to-main), `Sidebar.tsx` (rail), `BrowserPanel.tsx` (toolbar, banner, strip), `ThreadView.tsx` (disclosure state per thread), `markdown.tsx` (frozen blocks + plain-text tail), `store.ts` (pane layout, take-over state), `SettingsSheet.tsx` (pane geometry).

**Acceptance tests:** divider keyboard + `aria-value*` assertions; clamping when the window shrinks below the sum of minimums (inspector auto-collapses, then restores); double-click reset; persisted geometry survives restart; collapsed tool output is not rendered (`content-visibility`); the four-driver render-snapshot equality test above; partial-fence streaming renders without a flash of broken markdown; and take-over lock transitions — agent action → `agent-driving`, human click → paused → resume.

### 本章新增来源清单

1. [W3C APG — Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/) `[P]` — `separator` role, `aria-value*`, arrow/Enter/Home/End keys.
2. [MDN — `separator` role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/separator_role) `[P]` — focusable separator is a widget.
3. [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) `[P]` — `collapsedThreshold`, 27px/37px hit target citing Apple HIG, persistence on release only.
4. [Allotment](https://github.com/johnwalley/allotment) `[P]` — VS Code-derived sash, `snap`, `minSize`/`maxSize`, 20px feedback area.
5. [Zed — new panel system](https://zed.dev/blog/new-panel-system) `[P]` — unified panel model in a shipping editor.
6. [MDN — `aria-expanded`](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded) `[P]` — belongs on the controlling element, with `aria-controls`.
7. [MDN — `<details>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/details) `[P]` — native disclosure, `name` accordion, no built-in animation.
8. [MDN — `interpolate-size`](https://developer.mozilla.org/en-US/docs/Web/CSS/interpolate-size) · [Chrome — animate to `height:auto`](https://developer.chrome.com/docs/css-ui/animate-to-height-auto) `[P]` — animating to intrinsic height without `max-height` hacks.
9. [Electron — Security](https://www.electronjs.org/docs/latest/tutorial/security) `[P]` — `webview`/`WebContentsView` hardening for remote content.
10. [Electron — migrate to `WebContentsView`](https://www.electronjs.org/blog/migrate-to-webcontentsview) `[P]` — `BrowserView` deprecated since Electron 30.
11. [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) `[P]` — `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot`, `Log`, `Network`.
12. [Browserbase — Session Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view) `[P]` — watch/control a live session; read-only vs read-write; human-in-the-loop.
13. [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp/) `[P]` — agent controls a live Chrome; exposes browser content to the client.
14. [Playwright — UI Mode](https://playwright.dev/docs/test-ui-mode) `[P]` — time-travel debugging; a human tool, not a shared-control model.
15. [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) · [GFM spec](https://github.github.com/gfm/) `[P]` — the pinned dialect and its four extensions.
16. [Vercel Streamdown](https://github.com/vercel/streamdown) `[P]` — unterminated-block handling, memoisation, `rehype-harden`.
17. [DOMPurify](https://github.com/cure53/DOMPurify) `[P]` — sanitisation; React's `dangerouslySetInnerHTML` does none.
18. Local repository (verified in-place, 2026-09): `styles/app.css:40-41,108-114,524`, `components/BrowserPanel.tsx:82-117`, `components/Inspector.tsx:20-62`, `components/Sidebar.tsx:14`, `components/ThreadView.tsx:79-85,132-136`, `markdown.tsx:14`, `store.ts:316-318`, `src/main/browser/tools.ts:78-89`.

<a id="9-refining-the-current-ui"></a>

## 9. Refining the Current UI Toward WorkBuddy and T3 Code: Shell Regions, Thread Lifecycle, an Inbox, Composer Chips, and a Settings IA

**Thesis.** Chapters 7 and 8 specified surfaces that do not exist yet. This chapter is the opposite: a refinement pass over the UI as it stands, benchmarked against the two harnesses the user named. The important conclusion up front is that the *visual* language is not the gap. `styles/app.css` already opens with "calm, native-feeling, one accent" and delivers it — SF Pro / Segoe UI Variable stack, a single `#0a84ff` accent, three radii (6/10/16), hairline borders at 8% alpha, a translucent `--bg-sidebar` for vibrancy, separate light/dark token sets, and a 52px titlebar (`app.css:1-60`). That is a more disciplined system than either benchmark documents publicly. What the current UI lacks is **structure and lifecycle**: T3 Code's three collapsible regions and thread-state model, and WorkBuddy's right-panel tab set and message inbox. So the plan is: keep the paint, replace the carpentry.

### 9.1 What the two benchmarks actually specify

Both were researched from primary sources, and it is worth separating what is documented from what is marketing.

**T3 Code** (github.com/pingdotgg/t3code, MIT) documents its own UI in `docs/user/*.md`, which makes it unusually checkable. The window is **three collapsible regions — a main sidebar, a right panel, and a terminal drawer** ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)). The sidebar is the thread list; the right panel is **tabbed** and hosts device, browser, and diff/PR review — the terminal is a separate drawer, not one of its tabs ([source-control](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md), [devices](https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md)). The domain model is Environment → Project → Thread → Turn, and **the thread is the primary object** ([thread-sidebar](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md)). Threads live in lifecycle **sections — Pinned, Active, Snoozed, Settled** — rather than carrying a status column, with auto-settle after roughly three days idle or a merged PR (same source). The composer takes `/` commands, `$` skills, `#` PR browsing and **inline context chips** at the cursor, and a message sent mid-turn becomes a **dashed "queued" bubble** with queue-versus-steer behaviour ([composer](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md)). Permission modes are **chosen in the composer**, per thread: Supervised / Auto-accept edits / Auto / Full access ([permission-modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)). Appearance exposes a **panel-animation slider, 0–400 ms, defaulting to 0 (instant)**, honouring reduced-motion, and thread switches "snap to the panel state" instead of replaying transitions ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)).

**WorkBuddy** (Tencent) documents a **three-zone shell**: a sidebar holding the task list grouped by workspace with search and the user avatar at the bottom, a centre conversation with a title bar / message list / input, and a right **Results Panel** toggled from the title bar ([Quickstart](https://www.workbuddy.ai/docs/workbuddy/Quickstart)). The richer Chinese docs describe that right panel as four sibling tabs — **产物 Artifacts / 工作空间文件 Workspace Files / 变更 Changes / 浏览器 Browser** ([Right-Sidebar](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar)) — and the same page documents the single most transferable idea in either product: a **消息中心 Message Center**, opened from a bell at the sidebar bottom, that lists *"task needs your confirmation"* and *"task completed"* rows, each jumping to its task. Settings are a **left-nav plus right-content** layout (General / Features / Data & Security), applying instantly ([Setting](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)). Coding mode adds a **Worktree** feature that runs two tasks on separate branches and **labels the branch in the task list** ([WB-09](https://github.com/KimYx0207/AI-Coding-Guide-Zh/blob/main/docs/workbuddy/WB-09-WorkBuddy-Coding-Mode%E7%BC%96%E7%A8%8B%E6%A8%A1%E5%BC%8F%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97.md) `[S]`).

Two caveats that shape the plan. T3 Code is `0.0.x` ([releases](https://github.com/pingdotgg/t3code/releases)) and its README states it is "very very early… expect bugs" ([README](https://github.com/pingdotgg/t3code)) — the *patterns* are mature, the product is not. And WorkBuddy is an office-work agent with a coding mode, so its scenario tabs and credit framing do not transfer ([Coding Mode](https://www.tencentcloud.com/techpedia/144314)).

### 9.2 Shell: adopt the three-region model, and move the terminal to a drawer

Today the app is a grid of sidebar / main / inspector, and the inspector holds **Changes, Browser and Terminal as sibling tabs** (`Inspector.tsx:20-62`). Both benchmarks argue for a different split: T3 separates a **terminal drawer** from the tabbed right panel; WorkBuddy keeps the right panel for *results* (artifacts, files, changes, browser). The refinement:

- **Right panel tabs → Changes · Browser · Files.** Terminal leaves the tab set. A terminal is a persistent tool, not a result; burying it in a tab means it competes with the diff for the same 460px. Files (a workspace tree) is the WorkBuddy tab the current UI lacks entirely, and it is the natural companion to file links in the transcript.
- **Terminal becomes a bottom drawer** spanning the main column, toggled with the existing ⌃` shortcut (`App.tsx:55-57`), height-draggable with the Ch. 8 splitter contract, and remembering its height. `TerminalPanel` already stays mounted per project (`store.ts:279`) so this is a layout move, not a rewrite.
- **All three regions collapse.** T3's regions are collapsible; today the sidebar cannot collapse at all (`Sidebar.tsx:14` only collapses project *groups*). Ch. 8 §8.2 specifies the rail; this chapter makes it a shell requirement: sidebar rail at 48px, right panel closable, drawer closable — all three keyboard-reachable and persisted.

### 9.3 Navigation and thread lifecycle

The sidebar today is a flat, recency-sorted list of threads under each project (`store.ts:83-86`). T3 replaces "a list with a status" with **sections** — Pinned, Active, Snoozed, Settled — and WorkBuddy labels each task with its branch. Both are cheap and high-value:

- **Sections.** Pinned / Active / Settled, with Snoozed as a later addition. `Thread` already has `updatedAt`; auto-settle (T3 uses ~3 days idle or a merged PR) is a query, not a migration. This solves a real problem the flat list has: yesterday's finished work and today's live work look identical.
- **Branch and agent labels on the row.** WorkBuddy labels the worktree branch; T3 gives each thread its own worktree. The current row shows only a title and a spinner (`Sidebar.tsx:44-57`). Add a quiet second line or trailing chip: agent label, and branch when the thread is on one. This also makes the parallel-work story legible before any worktree support exists.
- **Keyboard parity.** Adopt the parts that fit: ⌘1–9 to jump to the first nine threads, and ⌘[ / ⌘] as back/forward across recently viewed views ([keybindings](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md)). The palette already exists; T3's refinement is that a query starting with `>` shows **actions only** — a two-line change in `palette.ts` that makes the palette a real command surface rather than a search box.
- **Thread search.** WorkBuddy's sidebar has search; ours does not. The palette covers it, so this is optional — but it should search thread titles across *all* projects rather than the selected one; `palette.ts` already has a Threads section (`palette.ts:4,27`), so the gap is scope, not capability.

### 9.4 The Message Center: the one pattern worth copying wholesale

WorkBuddy's inbox is the answer to a question this harness will face as soon as it can run more than one thing at a time: *what happened while I was away?* The current UI answers it with nothing — a running thread shows a spinner in the sidebar (`Sidebar.tsx:55`) and a permission request only appears inside the thread that raised it (`ThreadView.tsx:51-53`), so a request on a background thread is invisible until you open it.

The refinement is a **bell in the sidebar footer** opening a full-page overlay with two groups:

1. **Needs you** — pending permission requests (from `store.permissions`, which is already a cross-thread array), handoff confirmations (Ch. 7 §7.3), and agent switches that would lose context.
2. **Finished** — turns that completed while the thread was not selected, with the thread title, agent, duration and outcome.

Each row jumps to the thread. This is also where Ch. 7's "states and microcopy" inventory gets its home: anything that needs an action gets an inbox row, and transient confirmations stay as the 3.5-second `Notice` (`store.ts:120-124`). One new store slice and one new component; no schema change.

### 9.5 Composer: chips, queueing, and modes where the message is

The composer already does `/` skills with a keyboard-driven menu and supports inserting a picked browser element (`Composer.tsx:21-35`, `:57-62`). Three additions, all from T3:

- **Context chips at the cursor.** A picked element today is appended to the end of the textarea (`Composer.tsx:59`). T3 inserts chips at the caret and renders them as discrete tokens. Adopt the chip *rendering* (reuse the existing `.skill-chip`), keep insertion simple — this makes a message with three attached things readable instead of a wall of pasted text.
- **A queued-message bubble.** Sending while a turn runs is currently blocked outright (`Composer.tsx:79`). T3 accepts the message, renders it as a **dashed bubble**, and offers queue-versus-steer. For a harness whose whole point is long agent turns, "you can type ahead" is a significant quality-of-life change. It needs one new event kind and an explicit rule for when a queued message is delivered (start of next turn).
- **Modes in the composer, not only in the header.** The permission segmented control sits in the header (`App.tsx:113-127`) and is disabled while running. T3 puts the mode choice next to the send button, per thread. Moving (or duplicating) it there puts the decision where the user is looking, and makes the Ch. 7 per-driver mode semantics visible at the moment of sending.

### 9.6 Settings: from one long sheet to a left-nav IA

Settings today is a single scrolling sheet with six sections (`SettingsSheet.tsx:52-182`). WorkBuddy uses **left-nav + right-content** with instant apply ([Setting](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)), which is the right shape once Ch. 1 adds a provider registry — a list of providers plus an editor does not belong in a scrolling sheet. Proposed groups: **Appearance · Threads · Agents & Providers · Skills & MCP · Data & Security · Updates**, with the existing `.sheet` chrome and `Esc`/backdrop-dismiss behaviour kept (`SettingsSheet.tsx:35-53`).

### 9.7 Visual language: keep it, add the two knobs T3 got right

Do not repaint. The current tokens are coherent and the benchmarks publish no visual spec worth copying — WorkBuddy's radii, spacing and colour values are undocumented `[U]`, and T3 documents tokens and a motion slider but not density or typography ([appearance](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md)). Two adoptions are worth it:

- **Motion as a setting, defaulting to instant.** T3's 0–400 ms panel-animation slider with a default of 0 is a genuinely better default than the current unconditional `slide-in 220ms` (`app.css:524`). Add a motion preference (Instant / Subtle / Full), keep `prefers-reduced-motion` authoritative, and make thread switches snap panel state rather than replay it.
- **A density preference** (Comfortable / Compact) affecting the `.thread-row`, `.tool-row` and `.turn-meta` line heights. Long agent transcripts are the dominant content; density is the knob users actually reach for.

Optional and explicitly not core: T3 imports VS Code themes. It is a nice differentiator and a large surface area; the plan should note it and defer it.

### 9.8 Adopt / adapt / avoid

| Pattern | Verdict | Why |
|---|---|---|
| Three collapsible regions; terminal as a drawer | **Adopt** | Separates a persistent tool from tabbed results; both benchmarks agree |
| Tabbed right panel (Changes / Browser / Files) | **Adopt** | WorkBuddy's tab set maps onto the existing inspector |
| Thread lifecycle sections (Pinned / Active / Settled) | **Adopt** | Replaces an indistinguishable flat list; no migration |
| Message Center inbox | **Adopt** | Nothing else answers "what happened while I was away" |
| Composer chips, queued bubble, mode in composer | **Adopt** | All three make long turns tolerable |
| Settings left-nav IA | **Adopt** | Required once providers exist |
| Motion slider (default instant) + density | **Adopt** | Better defaults than the current hard-coded animation |
| `>` action mode in the palette, ⌘1–9, ⌘[ / ⌘] | **Adopt** | Small, cheap, keyboard-first |
| Worktree-per-thread, background start, fan-out by shift-clicking models | **Adapt later** | Right idea; depends on the Ch. 3 `bindings` work and git plumbing |
| Branch label on a thread row | **Adapt now** | Useful immediately, worktree support or not |
| WorkBuddy scenario tabs (office / code / design), credits, expert teams | **Avoid** | Office-work mental model; wrong for a code-first harness |
| T3's default of **Full access** permissions | **Avoid** | Our default is Ask for good reason; keep it |
| T3's release posture (`0.0.x`, "expect bugs", "(mostly) not accepting contributions yet") | **Avoid** | Patterns, not process |
| VS Code theme import | **Defer** | Large surface, low core value |

### 9.9 Phased refinement

- **Pass 1 — no new data, one or two files each.** Section the thread list; add the branch/agent label; palette `>` mode and ⌘1–9; motion preference defaulting to instant; terminal drawer; sidebar rail. All of these touch `Sidebar.tsx`, `App.tsx`, `Inspector.tsx`, `store.ts`, `app.css`.
- **Pass 2 — new state, no schema change.** Message Center (bell + overlay + `store.inbox`); Files tab in the right panel; composer chips and the queued-message bubble; Settings left-nav regrouping.
- **Pass 3 — depends on earlier chapters.** Worktree-per-thread and background start (after Ch. 3's `bindings`), density preference, and the four-agent rendering-parity snapshot test from Ch. 8 §8.5.

### 本章新增来源清单

1. [T3 Code — `docs/user/appearance.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/appearance.md) `[P]` — sidebar / right panel / terminal drawer as three collapsible regions; theme tokens; 0–400 ms motion slider defaulting to instant; snap-to-panel-state on thread switch.
2. [T3 Code — `docs/user/thread-sidebar.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) `[P]` — thread as primary object; Pinned/Active/Snoozed/Settled sections; worktrees; background start; Agents view.
3. [T3 Code — `docs/user/composer.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md) `[P]` — `/`, `$`, `#` triggers; inline context chips; dashed queued bubble; queue vs steer.
4. [T3 Code — `docs/user/permission-modes.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md) `[P]` — four modes chosen in the composer, per thread.
5. [T3 Code — `docs/user/keybindings.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/keybindings.md) `[P]` — ⌘K palette, `>` action filter, ⌘1–9, ⌘[ / ⌘].
6. [T3 Code — `docs/user/source-control.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/source-control.md) · [`devices.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/devices.md) `[P]` — tabbed right panel contents.
7. [T3 Code — README](https://github.com/pingdotgg/t3code) `[P]` — alpha status and contribution policy, i.e. what not to copy.
8. [WorkBuddy — Quickstart](https://www.workbuddy.ai/docs/workbuddy/Quickstart) `[P]` — three-zone shell; Results Panel toggled from the title bar.
9. [WorkBuddy — Right-Sidebar (右侧边栏)](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar) `[P]` — Artifacts / Workspace Files / Changes / Browser tabs; Message Center.
10. [WorkBuddy — Setting (系统设置)](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting) `[P]` — left-nav Settings IA, instant apply.
11. [WorkBuddy — Model](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) `[P]` — provider list with presets, dialog-based custom models, capability flags, Ollama, custom protocol.
12. [WorkBuddy Coding Mode (Tencent Cloud)](https://www.tencentcloud.com/techpedia/144314) `[P]` — coding mode surfaces diffs; four results-panel tabs.
13. [WB-09 Coding Mode guide](https://github.com/KimYx0207/AI-Coding-Guide-Zh/blob/main/docs/workbuddy/WB-09-WorkBuddy-Coding-Mode%E7%BC%96%E7%A8%8B%E6%A8%A1%E5%BC%8F%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97.md) `[S]` — Worktree with branch labels in the task list.
14. Local repository (verified in-place, 2026-09): `styles/app.css:1-60,524`, `App.tsx:55-57,113-127`, `components/Sidebar.tsx:14,44-57`, `components/Inspector.tsx:20-62`, `components/Composer.tsx:21-35,57-62,79`, `components/SettingsSheet.tsx:35-53,52-182`, `components/ThreadView.tsx:51-53`, `store.ts:83-86,120-124,279`, `palette.ts`.

<a id="10-context-survival-without-bloat"></a>

## 10. Context Survival Without Bloat: Memory Scopes, Idempotent Injection, Tool-Call Deduplication, and Token Accounting on Model and Provider Switch

**Thesis.** Chapter 3 specified *how* context crosses a switch. This chapter specifies what it must cost — and the answer starts with a distinction the current code does not make anywhere: **replaying history to the client is free; only what enters the model's input array is billed.** ACP states this outright — `session/resume` with `replayFrom` replays retained history as `session/update` notifications, and "Replaying a command reports its message; it does not execute the command again" ([ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)). Re-rendering the canonical event log is therefore not a cost concern at all. Every real question is about what re-enters context, and there are exactly five mechanisms to price.

### 10.1 What a switch costs, by mechanism

| Mechanism | Re-processed by the model | Cache | Free |
|---|---|---|---|
| **(a) Native resume** (Claude `resume`, Codex `thread/resume`) | The whole transcript is re-sent as input | **Yes** — the unchanged prefix bills at cache-read rate while inside the TTL | UI render, cursor bookkeeping |
| **(b) In-place model change** (Claude `setModel`, ACP `session/set_config_option`, OpenCode per-message `model`) | Whole history re-processed | **No** — "each model has its own cache" | — |
| **(c) New session + seeded checkpoint** | Only the checkpoint text | Cold prefix | Export and selection |
| **(d) Native compaction** (`thread/compact/start`, `/compact`) | The full conversation, once, to the summariser | Only with cache-safe forking (below) | Retention logic |
| **(e) `thread/inject_items`** | The injected items' tokens on **every** subsequent turn | Earlier prefix still cacheable | Building the items |

The load-bearing row is (a). Claude Code's own documentation says that resuming "sends the whole conversation again, and the request reads from the cache whatever part of its prefix is unchanged and still within the cache lifetime" ([Claude Code — prompt caching](https://code.claude.com/docs/en/prompt-caching)). So a same-provider resume is cheap *by construction* — 0.1× on the unchanged prefix — while a cross-provider switch is expensive *by construction*, because caches are per-model and per-provider and the target starts cold. **This is the single most important design consequence in the chapter: within a provider, always prefer resume over re-seed; only switch providers when the user actually wants a different agent.**

### 10.2 Memory scopes, and the duplication trap

All four agents have their own memory systems, and they overlap in ways that turn a handoff checkpoint into triple-loaded tokens.

- **Claude Code** loads a four-tier `CLAUDE.md` hierarchy at session start — managed policy, user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), and local (`./CLAUDE.local.md`) — discovered from the working directory *and every parent*, concatenated root-down; `@import` expands recursively to a maximum of four hops; project-root `CLAUDE.md` is **re-injected after `/compact`** ([memory docs](https://code.claude.com/docs/en/memory)). Separately, **auto memory** writes to `~/.claude/projects/<project>/memory/MEMORY.md`, of which only the first **200 lines or 25 KB** load every conversation — and it explicitly skips anything `CLAUDE.md` already says ([memory docs](https://code.claude.com/docs/en/memory)).
- **Codex** reads `AGENTS.md` once per run: global (`~/.codex/AGENTS.override.md` else `AGENTS.md`), then root→cwd with **at most one file per directory**, concatenated so nearer files override, stopping at `project_doc_max_bytes` (**32 KiB** default) ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). The format is shared across roughly 60,000 projects ([agents.md](https://agents.md)).
- **OpenCode** reads `AGENTS.md` (traversing up) plus `~/.config/opencode/AGENTS.md`, an `instructions` config array that accepts globs and remote URLs, and — for Claude Code migrants — **falls back to `CLAUDE.md` and `~/.claude/skills/`** unless `OPENCODE_DISABLE_CLAUDE_CODE` is set ([rules docs](https://opencode.ai/docs/rules/)).
- **ACP defines no memory, instructions or system-prompt channel at all** — context is `cwd`, `additionalDirectories`, `mcpServers` and embedded `ContentBlock`s ([ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)). Memory is entirely the agent's own configuration.

The collisions are concrete and worth naming: a project with **both `CLAUDE.md` and `AGENTS.md`** loads the same conventions twice on Claude, and OpenCode reads `CLAUDE.md` as well; Claude's auto-memory then refuses to record what `CLAUDE.md` already says; and a checkpoint that restates project conventions or a skill's body duplicates content the agent already auto-loads or can load on demand through the Skill tool.

**The rule this yields:** the handoff checkpoint carries **thread state only** — decisions taken, task status, files touched, commands run and their outcomes, open questions, cursor. Never project conventions (the agent already has them), never skill bodies (they load lazily), never reasoning (the target may not be able to read it — Ch. 3 §3.4).

| Where | What belongs | Failure mode if you get it wrong |
|---|---|---|
| Canonical transcript (SQLite) | Full ordered event log with payload + provenance | Unbounded growth — prune by policy, never by deleting provenance |
| Harness memory file (project-scoped, cross-agent) | Only deliberately-shared, thread-independent facts | **Duplication** with `CLAUDE.md`/`AGENTS.md`; cross-agent leakage |
| Agent's own memory (`CLAUDE.md`, `AGENTS.md`, auto memory) | Provider-specific nuance | **Staleness** — project-root `CLAUDE.md` is read once; edits need `/clear` or `/compact` |
| MCP memory server | Large, retrievable knowledge, read on demand | Unbounded growth; never mirror it into the transcript |

### 10.3 Prefer the vendors' pruning primitives to hand-rolled heuristics

The strongest lever is Anthropic's **context editing** (beta header `context-management-2025-06-27`): `clear_tool_uses_20250919` clears old tool results with parameters `trigger` (default **100,000 input tokens**), `keep` (default **3** recent tool-use/result pairs), `clear_at_least`, `exclude_tools`, and `clear_tool_inputs` (default `false`); `clear_thinking_20251015` does the same for thinking blocks. It is **server-side** — the API removes the oldest tool interactions first and replaces each cleared result with placeholder text — and reports what it did in `context_management.applied_edits`, with `cleared_tool_uses`, `cleared_thinking_turns` and `cleared_input_tokens`, surfaced in streaming on `message_delta` ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). A sibling strategy, **`compact_20260112`** (beta `compact-2026-01-12`), summarises at a trigger of at least 50,000 input tokens (default 150,000) and returns a `compaction` block, with `pause_after_compaction` and custom `instructions` ([compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)).

Two cautions that belong in `cache-policy.ts` (Ch. 4). First, clearing invalidates the cached prefix **at the clear point**, so `clear_at_least` exists to make the invalidation worth paying for — and placing a `cache_control` breakpoint after the static system prompt keeps that prefix from being re-billed when a later layer is cleared or compacted ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Second, compaction done naively is *worse* than not compacting: a summariser call with its own system prompt and no tools "diverges at the very first token and none of the cache applies". Anthropic's fix, **cache-safe forking**, reuses the parent's system prompt and tools and appends the compaction prompt ([Lessons from building Claude Code](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)).

Elsewhere: Codex's `thread/compact/start` returns `{}` immediately and streams a `contextCompaction` item lifecycle ([app-server](https://developers.openai.com/codex/app-server/)), with `model_auto_compact_token_limit` and `model_auto_compact_token_limit_scope` — `total` (default) or `body_after_prefix` — documented as growth "after the carried compaction-window prefix", and read by a source-level analysis as subtracting the cached prefill so cached tokens do not inflate the trigger ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference); the prefill reading is `[S]` — [analysis](https://60ke.github.io/posts/openai-codex-context-compaction/)) — plus `compact_prompt` for custom instructions. OpenCode exposes `session.summarize`, `session.revert`/`unrevert`, and an `experimental.session.compacting` plugin hook that fires *before* the summary and can append to or replace the continuation prompt ([plugins](https://opencode.ai/docs/plugins/), [SDK](https://opencode.ai/docs/sdk)). **ACP exposes nothing** — compaction there is entirely the agent's internal behaviour, which is why an ACP agent's context growth is unobservable and must be inferred from `usage_update`'s `used`/`size` ([prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)).

Anthropic's own framing is worth adopting as the default posture: clearing tool calls and results is "one of the safest lightest touch forms of compaction" once a call is deep in the history, with the counterweight that "overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later" ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### 10.4 Idempotent injection: the "no duplicated tool calls" requirement

There are two distinct duplication risks. Re-*executing* a side-effecting tool is the first — already forbidden in Ch. 3, and ACP's replay semantics make the safe path explicit. Re-*sending* is the second, and it is worse than it looks, because **`thread/inject_items` is not idempotent.** The official documentation describes it only as appending "raw Responses API items to a loaded thread's model-visible history" and never mentions deduplication ([app-server](https://developers.openai.com/codex/app-server/)). A reproducible spike against `codex-cli 0.144.5` found that injecting the same item twice returns `{}` both times and writes **two identical rollout records** — no dedup, no error, and the server neither assigns nor rewrites item ids. The injected items are attached to a synthetic `turn_id` and are **not readable back through the API**; the only read-back is the rollout JSONL on disk ([spike](https://github.com/chenxiangning/codemoss/blob/main/docs/research/spikes/2026-07-27-s1-codex-thread-inject-items.md) `[S]`). Idempotency is entirely the caller's problem.

The identity primitives exist, but they are per-protocol: Anthropic `tool_use.id` (`toolu_…`), ACP `toolCallId` (documented as "a unique identifier for this tool call within the session") plus an opaque per-message `messageId` ([ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) for `toolCallId`; the replay `messageId` is defined in [ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)), and Codex's `call_id` on Responses `function_call`/`function_call_output` items. Note the scope: ACP's `tool_call_update` is an upsert keyed by `toolCallId`, so it is idempotent **within** a session — but a fresh session has no memory of it, which is exactly the switch case.

So the harness owns a **durable injection ledger**, a new table alongside the event log:

```
injection_ledger(
  thread_id, target_provider, target_session_id,
  checkpoint_id,            -- one handoff
  item_fingerprint,         -- sha256 of the canonical item + protocol id
  state,                    -- 'intent' | 'injected' | 'failed'
  injected_at
)
```

The protocol: write an `intent` row per item *before* injecting; inject; mark `injected`. On a resumed or retried switch, **verify-then-inject** — skip every fingerprint already recorded `injected` for that target session, and roll a half-finished checkpoint forward from `intent` rows rather than re-injecting blindly. Because Codex cannot read injected items back, **the ledger — not the target — is the source of truth.** The same ledger covers OpenCode's `session.prompt({noReply: true})` — if and when a native driver makes that channel reachable (Ch. 3 §3.3c) — and the synthetic first message used for Claude and ACP, where no server-side dedup exists at all.

### 10.5 Token accounting, and the bloat signal

You cannot compare raw counts across providers. Anthropic states that Claude 4.7+/Fable/Mythos use a newer tokenizer producing **approximately 30 percent more tokens** than earlier models, and instructs callers to recount against the target model ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)); OpenAI rounds `cached_tokens` down to a multiple of 128 (pre-5.6) and requires a 1,024-token minimum cacheable prefix ([prompt caching](https://platform.openai.com/docs/guides/prompt-caching)). **Rule: keep the canonical artifact as raw text and derive per-model counts with each provider's own counter — Anthropic's `count_tokens` is free and per-model — and attribute "context size" in the target model's tokens, never a number measured elsewhere.**

The measurable bloat signal, computed in-band from usage fields the vendors already send (Ch. 4):

- **Clean resume:** `cacheRead ≈` the previous turn's total processed input, with small `cacheCreation`.
- **Bloated re-seed:** `cacheRead ≈ 0` and `cacheCreation ≈` the full checkpoint size.

That delta is the number to put in the UI, and the one to alert on. It is the honest answer to "did switching cost me anything?", and it needs no extra request — consistent with the repo's existing refusal to poll for rate limits (`README.md`).

### 10.6 Budgeting the checkpoint

Precedents rather than invented numbers: Anthropic's sub-agents return "often 1,000–2,000 tokens"; compaction preserves architectural decisions, unresolved bugs and implementation details while discarding redundant tool outputs, and Claude Code keeps the five most recently accessed files ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Codex's compaction path keeps a handoff summary **plus up to 20,000 tokens of the most recent user messages**, and its summarisation prompt literally reads "Create a handoff summary for another LLM" with framing that tells the target to avoid duplicating work ([analysis](https://60ke.github.io/posts/openai-codex-context-compaction/) `[S]`). The widely-cited thresholds — 93% auto-compact, a 90% hard cap, a 70% manual trigger — are rules of thumb, not documented rules `[U]`.

Design target: **a structured 2,000–4,000-token handoff**, measured in the *target's* tokens, degrading in tiers (full checkpoint → tool results collapsed to previews + artifact paths → decisions and git state only), and never exceeding the number of tokens it replaces. Carry decisions, unresolved questions, touched files with diffstats, command results truncated to a preview plus a path, and the workspace's git state. Drop conventions, skill bodies, reasoning, and raw tool output.

### 10.7 Guardrails the harness enforces

1. **Resume before re-seed within a provider** — resume reuses a cached prefix at 0.1×; a fresh seed is cold and full price.
2. **Per-switch injection budget** — a hard cap (default ~4k tokens) measured with the target's counter, refusing to inject past it.
3. **Dedupe ledger** — key `(target session, item fingerprint)`, refuse anything already `injected`.
4. **Never trust the target to have deduped** — Codex cannot read injected items back; the ledger is authoritative.
5. **Cap carried tool results** — preview plus artifact path, mirroring Claude Code's disk offload rather than shipping a 30k-character `Bash` output into a new provider.
6. **Warn before an expensive switch** — estimate the checkpoint's cost and compare it with the `cacheRead` savings the user is giving up.
7. **Never inject reasoning the target cannot read** — no Anthropic thinking blocks into Codex, and never carry an item whose `encrypted_content` is `null`.
8. **Never re-execute a side-effecting tool** — replay is reporting only.

### 10.8 Changes to the store layer

`db.ts` currently has no event sourcing: `events(thread_id, seq, payload, created_at)` with a `PRIMARY KEY (thread_id, seq)`, plus a `schema_version` table and an ordered `steps[]` migration list (`db.ts:16-62`). Three concrete additions, all additive:

- **`injection_ledger`** as above (new table, new migration step).
- **`events` gains `provenance`, semantic-id and `payload_ref`/`payload_bytes` columns** (Ch. 3 §3.2). Note the existing single `payload` column already *is* the whole event JSON, so the full tool input/output lives inside that JSON (not in a second column of the same name); the blob table from Ch. 3 holds the large ones and `payload_ref` points at them.
- **Tighten `appendEvent`** (`db.ts:137-146`): it computes `MAX(seq) + 1` in a separate statement before inserting. With `PRIMARY KEY (thread_id, seq)` that lookup is an index seek, not an O(n) scan, and `node:sqlite` is synchronous, so inside the one main process there is no interleaving; the race is real only across connections (a second process or worker). Deltas are never persisted (Ch. 5 §5.1), so write rate does not change. Folding it into one `INSERT … SELECT COALESCE(MAX(seq),0)+1` statement (plus a `busy_timeout`) is cheap hardening, not a performance fix.

Retention is the last piece: the canonical log grows without bound by design (Ch. 3), so pruning must be a policy — keep full payloads for the last N turns per thread, replace older tool results with a preview plus a blob reference, and never delete the provenance.

### 本章新增来源清单

1. [Claude Code — How Claude remembers your project](https://code.claude.com/docs/en/memory) `[P]` — four-tier `CLAUDE.md`, `@import` (max 4 hops), auto-memory `MEMORY.md` (first 200 lines / 25 KB), 4 MiB skip, project-root re-injection after `/compact`.
2. [Claude Code — Prompt caching](https://code.claude.com/docs/en/prompt-caching) `[P]` — resume re-sends the whole conversation and reads the unchanged prefix from cache; per-model caches; TTL buckets.
3. [Anthropic — Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) `[P]` — `clear_tool_uses_20250919` (`trigger` 100k, `keep` 3, `clear_at_least`, `exclude_tools`, `clear_tool_inputs`), `clear_thinking_20251015`, `applied_edits`.
4. [Anthropic — Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) `[P]` — `compact_20260112`, ≥50k trigger, `compaction` block, caching-breakpoint advice.
5. [Anthropic — Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) `[P]` — free per-model `count_tokens`; newer tokenizer ≈30% more tokens.
6. [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) `[P]` — tool-result clearing as the safest compaction; keep/drop guidance; 1–2k-token sub-agent summaries.
7. [Lessons from building Claude Code: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) `[P]` — cache-safe forking; don't change models or tools mid-session.
8. [Codex — App server](https://developers.openai.com/codex/app-server/) `[P]` — `thread/resume`, `thread/inject_items`, `thread/compact/start`, `contextCompaction`.
9. [Codex — `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md) `[P]` — discovery, one file per directory, `project_doc_max_bytes` 32 KiB.
10. [Codex — Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) `[P]` — `model_auto_compact_token_limit(_scope)`, `compact_prompt`.
11. [AGENTS.md](https://agents.md) `[P]` — the shared cross-agent instruction format.
12. [OpenCode — Rules](https://opencode.ai/docs/rules/) `[P]` — `AGENTS.md`, `instructions` config, `CLAUDE.md` fallback, `OPENCODE_DISABLE_CLAUDE_CODE`.
13. [OpenCode — Plugins](https://opencode.ai/docs/plugins/) · [SDK](https://opencode.ai/docs/sdk) `[P]` — `experimental.session.compacting`, `session.summarize`, `revert`/`unrevert`.
14. [ACP v1 — Schema](https://agentclientprotocol.com/protocol/v1/schema) · [Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) `[P]` — no memory channel; `toolCallId`; `usage_update`.
15. [ACP v2 — Session setup](https://agentclientprotocol.com/protocol/v2/session-setup) `[P]` — replay reports, never re-executes.
16. [OpenAI — Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) `[P]` — `cached_tokens` / `cache_write_tokens`, 1,024-token minimum, 128-token rounding.
17. [Codex `thread/inject_items` spike](https://github.com/chenxiangning/codemoss/blob/main/docs/research/spikes/2026-07-27-s1-codex-thread-inject-items.md) `[S]` — no dedup, caller-owned ids, rollout-only read-back (codex-cli 0.144.5).
18. [Codex CLI compaction analysis](https://60ke.github.io/posts/openai-codex-context-compaction/) `[S]` — `BodyAfterPrefix` scope, 20k-token retention, handoff-summary prompt.
19. Local repository (verified in-place, 2026-09): `src/main/db.ts:16-62,137-146`.

---

<a id="conclusion"></a>

## Conclusion

Four questions were asked of this plan, and the research answers them unevenly — which is itself the most useful result.

**Can the hardcoded keys be replaced by a real BYOK registry?** Yes, completely, and the shape is settled: one `Provider` record — id, label, wire protocol, base URL, credential, model list with capability flags, headers, env, query params, retries, and a raw-path escape hatch — from which each driver compiles its own native configuration (Ch. 1). The work is not uniform. Claude needs the `ANTHROPIC_AUTH_TOKEN`-versus-`ANTHROPIC_API_KEY` header distinction and an `Options.env` spread because the TypeScript SDK *replaces* the subprocess environment rather than merging it. Codex needs a profile file under `CODEX_HOME` and a backup of a config file the user owns. OpenCode takes its credential as spawn environment because ACP has no credential channel at all. Antigravity is the one genuine wall: Gemini-compatible endpoints only, no OpenAI/Anthropic BYOK, and third-party access that Google's terms treat as a breach — so it ships opt-in, default-off, behind an explicit acknowledgement (Ch. 2).

**Can all four agents work identically?** For shell, file editing, search, resume, interrupt, and user-invoked skills, yes. Model-invoked skills and MCP-over-HTTP are lossy on the ACP presets, and pre-tool guardrails are only *fully* enforceable on Claude, OpenCode, and (in `ask`/`auto-edit`) Codex — under Codex's `full` mode the honest answer is warn-after-the-fact. Two live defects surfaced along the way: `codexPolicy("ask")` emits the retired `approval_policy: "untrusted"`, and `forAcp` silently drops *all* HTTP MCP servers — the user's own included — when an agent's `mcpCapabilities.http` is false, which is the protocol default (Ch. 2).

**Can context survive a switch?** Not as portability — as *re-seeding*. No shipping product performs live cross-agent context transfer, and none is likely to, because hidden reasoning, prompt caches, approvals, tokenizers, and tool-call schemas do not travel. What is achievable is better than the industry's current floor: keep a durable, replayable canonical transcript; keep *every* provider's session cursor alive in parallel instead of one `sessionId`; and seed the new session through the best native channel available — Codex's `thread/inject_items` is close to lossless, OpenCode's `session.prompt({ noReply: true })` would be clean but is unreachable until a native OpenCode driver exists (the repo drives OpenCode over ACP), and Claude, ACP and today's OpenCode fall back to a synthetic first message. Then show the user exactly what did not make it (Ch. 3).

**Can cache hit rate be high?** Yes, and the mechanism is discipline rather than tuning: freeze and sort the tool set at thread creation, split static from dynamic system prompt, keep history append-only, never mutate the model or reasoning effort mid-thread, and stop rebuilding sessions because an MCP server list changed. Measure it in-band from usage fields the vendors already send — after fixing the double count at `claude.ts:289` (Ch. 4).

**And the interface?** One interface, four agents — the UI's job is to be specific about where they differ. Capability-driven affordances, controls disabled with a reason instead of hidden, a switch contract that lists what carries over and what does not, reasoning that streams and stays collapsed by default, and a cache meter built from data the vendors already send. The test for every screen: could a user tell, from the UI alone, that Codex cannot veto a shell command in Full mode, or that an ACP agent is receiving no HTTP MCP servers at all? If not, the screen is still lying (Ch. 7). The interaction layer has to behave like a developer tool rather than a web page: APG-conformant splitters, real collapse, a browser pane that can take the full width, an explicit take-over model for the agent driving that pane, and one rendering contract so all four agents' answers look identical (Ch. 8). And the existing interface needs a refinement pass rather than a repaint: the visual language is already sound, but the shell should borrow T3 Code's three collapsible regions and thread-lifecycle sections, and WorkBuddy's tabbed results panel and message inbox — while explicitly refusing T3's Full-access default and WorkBuddy's office-scenario framing (Ch. 9). Finally, the switch itself has to be *cheap and provable*: replay to the client is free while only model input is billed, `thread/inject_items` is not idempotent so the harness must own a deduplication ledger, and "did the switch bloat my context?" is answered by comparing cache-read and cache-write tokens across the turn boundary rather than by guessing (Ch. 10).

The ordering in Ch. 6 is the deliverable: **event model → usage → registry → injection → parity → handoff → cache and streaming polish.** Every later slice writes into the substrate the first one defines. And the only genuinely irreversible operations — writing to a user's `~/.codex/config.toml`, and transforming `sessionId` into a `bindings` map — are cheap to make reversible *before* release and expensive afterwards.

---

<a id="references"></a>

## References

### Harness & protocol specifications

- **Agent Client Protocol — Overview (v1)** — agentclientprotocol.com, 2026. [link](https://agentclientprotocol.com/protocol/v1/overview)
- **Agent Client Protocol — Initialization (v1)** — `clientCapabilities`, `agentCapabilities.mcpCapabilities.http` (default `false`), version negotiation. [link](https://agentclientprotocol.com/protocol/v1/initialization)
- **Agent Client Protocol — Session Setup (v1)** — `session/new`, `session/load`, `session/resume`, `mcpServers`. [link](https://agentclientprotocol.com/protocol/v1/session-setup)
- **Agent Client Protocol — Prompt Turn (v1)** — full `sessionUpdate` variant set; `agent_thought_chunk`, `tool_call_update`, `usage_update`, stop reasons. [link](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)
- **Agent Client Protocol — Tool Calls (v1)** — tool `kind` enumeration, `session/request_permission`, permission option kinds. [link](https://agentclientprotocol.com/protocol/v1/tool-calls)
- **Agent Client Protocol — Session Config Options (v1)** — `configOptions` categories, `session/set_config_option`, `config_option_update`. [link](https://agentclientprotocol.com/protocol/v1/session-config-options)
- **Agent Client Protocol — Authentication (v1)** — `authMethods`, `authenticate`, terminal auth type. [link](https://agentclientprotocol.com/protocol/v1/authentication)
- **Agent Client Protocol — Session Setup (v2)** — drops `session/load`; `session/resume` + `replayFrom`. [link](https://agentclientprotocol.com/protocol/v2/session-setup.md)
- **Agent Client Protocol — Session Config Options (v2)** — in-place model switching. [link](https://agentclientprotocol.com/protocol/v2/session-config-options)
- **Agent Client Protocol — RFD: Forking of existing sessions** — `session/fork` remains a draft proposal. [link](https://agentclientprotocol.com/rfds/session-fork.md)
- **Agent Client Protocol — RFD: End-Turn Token Usage** — strawman `cachedReadTokens` / `cachedWriteTokens`, "not ready for Preview". [link](https://agentclientprotocol.com/rfds/end-turn-token-usage.md)
- **JSON-RPC 2.0 Specification** — request/response vs notification semantics. [link](https://www.jsonrpc.org/specification)

### Claude Code & Claude Agent SDK

- **Claude Code — Environment variables** — `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. [link](https://docs.claude.com/en/docs/claude-code/env-vars)
- **Claude Code — Other LLM gateways** — Anthropic does not support routing Claude Code to non-Claude models through a gateway. [link](https://code.claude.com/docs/en/llm-gateway)
- **Claude Code — Gateway compatibility guide** — headers to forward, "disable pre-release capabilities". [link](https://code.claude.com/docs/en/llm-gateway-protocol)
- **Claude Code — Model configuration** — alias pinning and pinned-model capabilities. [link](https://code.claude.com/docs/en/model-config)
- **Claude Code — Manage costs** — miss definition (">5% and at least 2,000 tokens"), expected rebuilds, cache lifetime by credential type. [link](https://code.claude.com/docs/en/costs)
- **Claude Agent SDK — Configuration** — `Options.env` replaces (does not merge) the subprocess environment; `settingSources`; `model`/`fallbackModel`. [link](https://code.claude.com/docs/en/agent-sdk/configuration)
- **Claude Agent SDK — TypeScript reference** — `resume`, `forkSession`, `model`, `hooks`, `apiUsage` cache fields. [link](https://code.claude.com/docs/en/agent-sdk/typescript)
- **Claude Agent SDK — Streaming output** — `includePartialMessages`; raw, non-accumulated events; subagent deltas not forwarded. [link](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- **Claude Agent SDK — Work with sessions** — `resume`/`continue`/`forkSession`; `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. [link](https://code.claude.com/docs/en/agent-sdk/sessions)
- **Claude Agent SDK — Modifying system prompts** — preset + `append` vs full replacement; first-request recording; `snapshot:false`; `excludeDynamicSections`; `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`. [link](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)

### Anthropic API

- **Anthropic — Prompt caching** — 4 breakpoints, `tools → system → messages` order, 5m/1h TTL and write multipliers, minimum cacheable prefix, invalidation matrix, `cache_read_input_tokens` / `cache_creation_input_tokens`. [link](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **Anthropic — Streaming Messages** — `text_delta`, `thinking_delta`, `signature_delta`, `input_json_delta`; cumulative usage on `message_delta`. [link](https://platform.claude.com/docs/en/build-with-claude/streaming)
- **Anthropic — Preserved thinking** — `signature` binds a thinking block to its model and prefix; unreadable blocks are dropped. [link](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)

### OpenAI Codex & Responses API

- **Codex — Advanced configuration** — `[model_providers.<id>]` fields, `wire_api`, `.auth` command, profile-file change in 0.134.0, `approval_policy` values. [link](https://developers.openai.com/codex/config-advanced)
- **Codex — Configuration reference** — `model_catalog_json`, `model_auto_compact_token_limit(_scope)`, project-local ignored keys. [link](https://developers.openai.com/codex/config-reference)
- **Codex — App server** — `thread/start`, `thread/resume` (model override + one-time switch warning), `thread/fork`, `thread/inject_items`, `thread/compact/start`, `skills/extraRoots/set`. [link](https://developers.openai.com/codex/app-server/)
- **Codex app-server protocol v2 JSON schema** — notification names, `TokenUsageBreakdown` (`cachedInputTokens`, `cacheWriteInputTokens`, `netNewInputTokens`), `ThreadInjectItemsParams`, `ContextCompaction` item type. [link](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)
- **openai/codex issue #45361** — per-thread `config` overrides on app-server; camelCase `mcpServers` unsupported on `thread/start`. [link](https://github.com/openai/codex/issues/45361)
- **OpenAI — Prompt caching guide** — 1024-token minimum, `usage.input_tokens_details.cached_tokens`, `prompt_cache_options.ttl`, invalidation list, `prompt_cache_key`. [link](https://platform.openai.com/docs/guides/prompt-caching)

### OpenCode

- **OpenCode — Providers (v2)** — `providers.<id>` shape, credential precedence, OpenAI-compatible package, explicit model capabilities. [link](https://dev.opencode.ai/v2/docs/providers/)
- **OpenCode — Models (v2)** — capabilities, limits, variants. [link](https://dev.opencode.ai/v2/docs/models)
- **OpenCode — SDK** — `session.prompt` per-message `model`, `noReply`, `session.abort`/`revert`/`summarize`. [link](https://opencode.ai/docs/sdk/)
- **OpenCode — ACP support** — `opencode acp`; credentials injected as spawn env by the client. [link](https://opencode.ai/docs/acp/)
- **OpenCode — Plugins** — `tool.execute.before` can `throw` to block a tool. [link](https://dev.opencode.ai/docs/plugins/)
- **OpenCode — Permissions** — `allow|ask|deny`, glob object syntax, session-scoped `always`. [link](https://dev.opencode.ai/docs/permissions/)
- **Models.dev** — upstream provider/model catalog OpenCode builds on. [link](https://models.dev)

### Google Antigravity

- **Antigravity CLI — Installation & Auth** — Gemini API key mode; `GEMINI_API_KEY` only; `GOOGLE_GEMINI_BASE_URL` for Gemini-compatible endpoints. [link](https://antigravity.google/docs/cli/install)
- **Google Antigravity — Terms of Service** — §6: third-party access is a breach and may lead to suspension or termination. [link](https://antigravity.google/terms)
- **shindgew/agy-acp** — community ACP adapter; `AGY_BIN`; `mode`/`model`/`reasoningEffort` config options; ToS warning. [link](https://github.com/shindgew/agy-acp)

### DeepSeek

- **DeepSeek — 上下文硬盘缓存 (Context disk cache)** — automatic prefix caching, cache-prefix-unit matching, `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. [link](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)

### Peer harnesses (prior art)

- **WorkBuddy — 模型配置** — `models.json`, provider presets, "自定义协议" toggle bypassing path auto-completion. [link](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model)
- **Zed — External Agents** — model/provider config, auth, and native MCP config are owned by the agent, not the client; imported threads are archive entries. [link](https://zed.dev/docs/ai/external-agents)
- **Vibe Kanban — Executor architecture** — `spawn_follow_up()` works only within one executor. [link](https://deepwiki.com/BloopAI/vibe-kanban/3.1-executor-architecture-and-configuration)
- **T3 Code — docs/internals/overview.md** — provider behaviour belongs behind an adapter boundary; providers differ in rollback capability. [link](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)

### Platform & tooling

- **Electron — safeStorage** — on Linux, protected content may be unprotected when no secret store is available. [link](https://www.electronjs.org/docs/latest/api/safe-storage)
- **Vitest — Snapshot testing** — `toMatchSnapshot` workflow. [link](https://vitest.dev/guide/snapshot.html)

### Local repository sources

- `HARNESS.md` — the harness contract this app implements. `research-ai-agent-harnesses.md` — prior harness survey.
- `src/shared/types.ts`, `src/main/service.ts`, `src/main/settings.ts`, `src/main/db.ts`, `src/main/agents/{types,registry,claude,codex,acp/driver,rpc}.ts`, `src/main/mcp/servers.ts`, `src/main/guard.ts`, `src/main/skills/*`, `src/renderer/src/{store.ts,components/ThreadView.tsx,markdown.tsx}`, `test/*`, `README.md`.

---

<a id="待完善事项--open-items"></a>

## 待完善事项 / Open items

**Unverified claims carried forward** (marked `[U]` in the chapters; do not treat as fact without a spike):

1. **Claude: resuming with a different `model`.** The Agent SDK documents `model` and `setModel()` but does not state whether `{ resume, model }` is supported. `setModel()` is "only available in streaming input mode" (`sdk.d.ts:2750-2755`) and this driver uses a string prompt per turn, so `{ resume, model }` is the only path that needs no refactor. Ch. 3 gives a cheap verification harness (start on model A, capture `session_id`, resume with `model: B`, read the effective model from the init `SystemMessage`).
2. **Codex `wire_api = "chat"` status.** Current docs show only `"responses"` and carry no deprecation notice for `"chat"`, yet `model_verbosity` is documented as ignored on Chat Completions providers. Verify against the installed Codex version before relying on either.
3. **`~/.codex/models.json` as a default filename** — not confirmed; `model_catalog_json` is documented as an explicit *path*.
4. **Codex `turn/start` model override** — no documented per-turn `model` parameter was found; model appears to be thread-scoped. Note the driver *already sends* `model` on both `thread/resume` and `turn/start` (`codex.ts:321`, `:356`), so the spike is about whether the effective model changes, not whether the field is accepted.
5. **ACP `usage_update` / compaction for specific agents** — `usage_update` carries no cache dimension in v1, and no compaction notification was found in the ACP v1 prompt-turn page. Whether OpenCode or Antigravity emit anything beyond the spec is unverified.
6. **Antigravity's `modelProvider: "gemini"` settings file** — reported by the community adapter's documentation, not by Google's own CLI page; the chapter marks it `[U]`.
7. **OpenCode `noReply` reachability.** The plan lists `session.prompt({noReply:true})` as a seeding channel, but the repo drives OpenCode over ACP (`registry.ts:34-40`) and the HTTP SDK is not the ACP wire format — so the channel is unreachable until a native driver exists. Phase 6 gates it behind a `capabilities.seedNoReply` flag for that reason.
8. **DeepSeek per-parameter cache invalidation** (reasoning effort, verbosity, tool order) — no published matrix; left as `unknown` rather than guessed.
9. **OpenCode config schema by installed version** (added in review). The preset installs `opencode-ai` (v1 line); Ch. 1 §1.3 cites the v2 `providers.<id>` / `settings.baseURL` schema. Which one the installed binary reads, whether it honours `OPENCODE_API_KEY`, and whether a harness-owned config path avoids writing the user's `opencode.json` are unverified (spec S8).

**Residual review notes** (non-blocking, from the chapter reviews):

- Ch. 1: when Antigravity is driven through `agy-acp`, the injection point is `AcpAgentConfig.env` at spawn, not the official `agy` CLI's own settings file — worth stating explicitly in the implementation ticket.
- Ch. 1: `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` also disables MCP tool search and preloads all MCP tools; document that degradation alongside the flag.
- Ch. 4: define cumulative session hit rate as `ΣcacheRead / Σ(cacheRead+cacheWrite+netNew)`, not the arithmetic mean of per-turn rates.
- Ch. 4: when the previous turn was itself a miss, the ACP estimator should degrade to `unknown` rather than reporting an `estimated` value.
- Ch. 6: pin the rollback threshold numerically (the revision uses "7-day hit rate down >5 pp versus the M3 baseline").
- Ch. 10: the per-mechanism cost table (§10.1) summarises figures sourced elsewhere in the chapter; add a per-row footnote if cell-level traceability is wanted.

**Process disclosure.** Chapters 1, 3 and 4 passed review in round 1. Chapters 2, 5 and 6 were revised after a round-1 `REVISE`; chapters 5 and 6 were revised by the reviser role and their corrections verified. Chapter 2's first revision pass produced no edits and the scheduled retry could not run (the subagent quota was exhausted mid-task), so the Chapter 2 corrections specified by the reviewer — the Codex pre-tool-veto landing point (`item/commandExecution/requestApproval`, not `mcpServer/elicitation/request`), the matrix and summary cells that depended on it, and the missing source for `modelProvider: "gemini"` — were applied directly by the editor-in-chief and verified against `src/main/agents/codex.ts:211` and `src/main/mcp/servers.ts:159-165`. That chapter has not had a second independent pass.

Chapters 7 (UI/UX) and 8 (interaction mechanics) were added after the review rounds, on follow-up requests, and were authored by the editor-in-chief against the renderer source. Both were then sent for independent review: **Chapter 7 passed in round 1; Chapter 8 was returned with three citation defects** — a 404 Electron link, a CSS line reference pointing three lines above the animation, and two table rows mis-attributed to the WAI-ARIA APG window-splitter pattern, which specifies roles and keys but neither cursor styling nor animation. Those three corrections were applied by the editor-in-chief (the reviser role was unavailable) and each was checked against the cited source. Chapter 8 has not had a second review pass.

Chapter 9 (UI refinement, benchmarked against T3 Code and WorkBuddy) went through the same independent review: **returned with two factual errors and four wording corrections, all now applied.** The errors were that T3's right panel was described as hosting the terminal (its own docs put the terminal in a separate drawer — the chapter contradicted itself two paragraphs later) and that `SettingsSheet.tsx` was said to have seven sections when it has six. The reviewer spot-checked twelve third-party claims against the cited pages; every other one held verbatim.

Chapter 10 (context economy on switch) **passed review in round 1** — the reviewer verified all 27 spot-checks against their cited sources, including the beta header, the two context-editing strategy names and their defaults, the compaction trigger bounds, the Codex and OpenCode memory limits, and the ACP replay quote. Three citation-precision notes were applied afterwards: an ACP `messageId` attributed to the wrong page, a `body_after_prefix` gloss that came from a source-level analysis rather than the vendor reference, and a `cache_control` placement tip attributed to context editing instead of prompt caching.
