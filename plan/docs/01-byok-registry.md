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
