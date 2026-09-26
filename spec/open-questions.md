# Open questions and unverified claims

Every `[U]` carried by the plan is a **spike**: do it *before* the phase it blocks (spec README, rule 5). Each spike below names what is unknown, what it blocks, and the cheapest falsifiable experiment that resolves it.

---

### S1 — Does Claude support `{ resume, model }` together?
- **Unknown:** the Agent SDK documents `model` and `setModel()` but not whether resuming with a different model is supported.
- **Blocks:** phase 3 (per-message model switch, Ch. 2 §2.2).
- **Experiment:** start a session on model A, capture `session_id`, resume with `model: B`, assert no error, and read the effective model from the init `SystemMessage` / `SDKResultMessage`. Pass = effective model is B.
- **Context:** `Query.setModel()` exists in the installed SDK but is "only available in streaming input mode" (`sdk.d.ts:2750-2755`); the driver sends a string prompt per turn, so `{ resume, model }` is the only path that needs no refactor. A fail here means phase 3 either refactors the Claude driver to streaming input or classifies Claude model changes as `new-session`.

### S2 — Codex `wire_api = "chat"` status — RESOLVED (see below)
- **Unknown:** current docs show only `"responses"` and carry no deprecation notice for `"chat"`, yet `model_verbosity` is documented as ignored on Chat Completions providers.
- **Blocks:** phase 1/2 (registry + injection).
- **Experiment:** run the installed `codex` against the fake endpoint with `wire_api = "chat"`; assert whether it connects and which path it takes. Record the installed version.

### S3 — Is `~/.codex/models.json` a default filename? — RESOLVED (see below)
- **Unknown:** `model_catalog_json` is documented as an explicit *path*; the default filename is unconfirmed.
- **Blocks:** phase 1 (registry model lists).
- **Experiment:** point Codex at a dir with and without `models.json` and observe whether it is read; or inspect the installed binary for the literal string.

### S4 — Does a `model` sent on `turn/start` actually take effect?
- **Unknown:** no documented per-turn `model` parameter was found; model appears thread-scoped.
- **Blocks:** phase 3.
- **Experiment:** the driver **already sends** `model` on `thread/resume` and on every `turn/start` (`codex.ts:321`, `:356`), and the mock accepts it — so acceptance is not the question. Against the real app-server, change the model between two turns of one thread and read the effective model from the next `turn/started`/usage; record whether it changed on `turn/start` alone or only after `thread/resume`.

### S5 — ACP `usage_update` / compaction beyond the spec
- **Unknown:** `usage_update` carries no cache dimension in v1, and no compaction notification was found in the ACP v1 prompt-turn page. Whether OpenCode or Antigravity emit anything beyond the spec is unverified.
- **Blocks:** phase 4/5 (streaming + cache observability).
- **Experiment:** drive the mock ACP agent and one real ACP agent (OpenCode), log every notification, and compare the observed set against the v1 page. Also log the `session/prompt` **response** `usage` object — the driver already reads `res.usage.inputTokens` (`driver.ts:377-391`) — and record whether it carries the RFD's `cachedReadTokens`/`cachedWriteTokens`; if it does, ACP cache fields are `reported`, not `unavailable`.

### S6 — Antigravity's `modelProvider` settings file
- **Unknown:** `~/.gemini/antigravity-cli/settings.json` accepting `modelProvider: "gemini"` only is reported by the community adapter's docs, not by Google's own CLI page.
- **Blocks:** phase 9 (opt-in gate) and phase 2 (ACP injection).
- **Experiment:** with `agy-acp` installed and the file present, change `modelProvider` and observe whether the adapter honours it. If unverifiable, keep the chip's wording ("Gemini-compatible endpoints only") and do not rely on the field.

### S7 — DeepSeek per-parameter cache invalidation
- **Unknown:** no published matrix for reasoning effort, verbosity, or tool order.
- **Blocks:** phase 5 (cache discipline).
- **Experiment:** run two identical turns against `dsh` with one parameter changed between them, compare cache-hit fields; record `unknown` if the fields are absent rather than guessing.

### S8 — OpenCode: installed version, config schema, credential variable — RESOLVED (see below)
- **Unknown:** the preset installs `opencode-ai` (`registry.ts:38`), which the research survey places on the **v1** line; the plan's config shape (`providers.<id>`, `package`, `settings.baseURL`) is the **v2** schema, and v1 uses `provider.<id>` with `npm` + `options.baseURL`. Also unverified: whether the ACP mode reads `OPENCODE_API_KEY`, and whether a harness-owned config path (e.g. an env-var override) can replace a write to `~/.config/opencode/opencode.json`, and where a harness-supplied plugin (T3.5a) can be loaded from without writing into the project or the user's config dir.
- **Blocks:** phase 2 (T2.4) and phase 3 (T3.5a).
- **Experiment:** run `opencode --version`; start `opencode acp` with a generated config at a temp path pointed to by each candidate env var, containing one custom provider; list models over ACP (`configOptions` category `model`) and assert the custom model appears. Repeat with the key only in `OPENCODE_API_KEY`. Record the version and which schema/variables worked.

### S9 — Codex `sandbox` value spelling
- **Unknown:** the repo sends `sandbox: "workspace-write"` / `"danger-full-access"` (`codex.ts:57-66`); the docs' app-server example shows camelCase `workspaceWrite`. Guessing wrong silently changes the isolation boundary.
- **Blocks:** phase 3 (T3.3).
- **Experiment:** send `thread/start` with each spelling to the installed app-server; assert which is accepted and read back the effective sandbox policy from the response/`thread/started`. Record the version.

---

## Resolved (verified in the chapters — do not re-spike)

- **S2 (resolved 2026-09-25, codex-cli 0.157.0):** `wire_api = "chat"` is rejected at config load — "`wire_api = \"chat\"` is no longer supported. How to fix: set `wire_api = \"responses\"`" (exit 1). Codex can only target Responses-API providers; an `openai-chat`-only provider is **not** Codex-compatible and the registry/injector must say so (invariant 7).
- **S3 (resolved 2026-09-25, codex-cli 0.157.0):** `$CODEX_HOME/models.json` is **not** read by default (a planted unique slug did not appear in `model/list`). An explicit `model_catalog_json = "<path>"` **is** read, with a strict schema (e.g. `missing field supported_reasoning_levels`); an invalid catalog is silently replaced by defaults with only a `configWarning` notification — so T1.8/phase 2 must generate the full schema and treat `configWarning` as a failure.
- **S1 (resolved 2026-09-26, Agent SDK 0.3.281 + its bundled Claude Code, fake Messages API, temp `CLAUDE_CONFIG_DIR`):** `query({ resume: <session>, model: B })` works. The resumed turn went out as model B on the same session id with the prior history (the message count grew 2 → 3), and there were no errors. Claude model changes are **`in-place` at the next turn** through `{ resume, model }`; the streaming-input refactor for `setModel()` isn't needed for this.
- **S4 (resolved 2026-09-26, codex-cli 0.157.0, fake Responses endpoint, temp `CODEX_HOME`):** a `model` on `turn/start` takes effect **in-place** on the same thread (the endpoint saw `model-a`, then `model-b`) and sticks for later turns (`model: null` stayed on `model-b`). Codex model switches are `in-place`, with no `thread/resume` needed.
- **S9 (resolved 2026-09-26, same setup):** the `thread/start` request takes kebab-case `sandbox`: `read-only | workspace-write | danger-full-access`. `workspaceWrite` is **rejected** ("unknown variant"). The *response* reports the policy as `{ "type": "workspaceWrite", … }`, which is where the camelCase in the docs comes from. The repo's values are correct; pin them with a test.
- **`approval_policy = "untrusted"` is NOT retired in 0.157 (found 2026-09-26, same setup): the Ch. 2 §2.2 / T3.3 premise is wrong.** `thread/start` accepts and echoes `untrusted`. With `workspace-write`, a fake model requesting `touch made.txt` got an `item/commandExecution/requestApproval` under `untrusted` (declined → file not created); even `ls` asked. Under `on-request` the same `touch` ran **without asking** and created the file. So `untrusted` is exactly the "ask before every command" behaviour Ask mode wants, and switching Ask to `on-request` would silently remove approvals. T3.3 becomes: keep `untrusted` for Ask and pin it with a test.
- **S10 (found 2026-09-26 while preparing T2.3, codex-cli 0.157.0, temp `CODEX_HOME` only): the profile design in T2.3 cannot work.** `codex --profile X app-server` fails: "`--profile` only applies to runtime commands and `codex mcp`" (app-server is not among them). What works is `-c` overrides on the app-server argv: `-c model_provider="unskilled-<id>"`, `-c model="<slug>"`, `-c model_catalog_json="<app-data path>"`, and `-c model_providers.unskilled-<id>={ name, base_url, env_key="UNSKILLED_<ID>_KEY", wire_api="responses", http_headers={…} }`. The key lives only in the spawn env. A full turn reached the fake endpoint with `Authorization: Bearer <key>` and the custom header, `model/list` returned only the catalog's slugs (the catalog **replaces** the built-in list), and there was no `configWarning`. **Nothing is written to `$CODEX_HOME`**, and `config.toml` stayed byte-identical. Catalog schema: `{ "models": [entry] }`, where each entry needs `slug, display_name, context_window, supported_reasoning_levels` plus the required `shell_type, visibility, supported_in_api, priority, support_verbosity, truncation_policy, experimental_supported_tools`, and **either** `base_instructions` **or** `model_messages.instructions_template`. `codex debug models` prints the installed version's full schema (about 40 fields). A catalog that fails to parse under `-c` makes app-server **exit at startup** with the error on stderr; there's no warning. So validate it first with `codex debug models -c model_catalog_json=…`. Don't put secrets in `-c` args, because argv is visible in `ps`; headers are fine, keys are not.
- **S8 (resolved 2026-09-26, opencode 1.18.32, fully isolated: temp `XDG_{CONFIG,DATA,CACHE,STATE}_HOME`, fake OpenAI-compatible endpoint logging headers; the real `~/.config/opencode` was never loaded):**
  - **Schema is v1:** `provider.<id>` with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, `options.apiKey`, `options.headers`, and `models.<id>` with `name`, `tool_call` (bool) and `limit.{context,output}`. **`capabilities.tools` (v2 spelling) is silently ignored** — the model resolves with `toolcall: true` regardless — so T2.4 must emit `tool_call`, and its acceptance test must check `tool_call`, not `capabilities.tools`. Unknown keys are dropped, not rejected. The v2 branch is untestable on this machine; ship v1 only and refuse (with a notice) on an unrecognised major.
  - **Credential:** `OPENCODE_API_KEY` does **not** reach a custom provider (request arrived with no `Authorization`). Two working channels: `options.apiKey: "{env:VAR}"` interpolation, or a provider-level `env: ["VAR"]` array. Both arrive as `Authorization: Bearer <key>`. Use `{env:UNSKILLED_<ID>_KEY}` so the key lives only in the spawn env, never in a file. `options.headers` also reaches the endpoint.
  - **No write to the user's file is needed.** `OPENCODE_CONFIG=<path>` loads an extra config file *merged over* the global `~/.config/opencode/opencode.json` (the harness `model` wins over the global `model`; providers merge by key). opencode did not rewrite the file it loaded. **But** a project-local `opencode.json` `model` beats `OPENCODE_CONFIG`. `OPENCODE_CONFIG_CONTENT='<json>'` is the *final* merge and beats the project file too, with no file at all. → T2.4 uses `OPENCODE_CONFIG_CONTENT` (harness-owned, no file anywhere, highest precedence), so the "merge into the user's `opencode.json` + backup" fallback path is dropped, and `providerInjection.opencode` gates only the env, not a write.
  - **ACP:** `opencode acp` with the injected env lists the custom model in the `session/new` `configOptions` entry with `category: "model"`, and it is the `currentValue`. `session/prompt` reaches the endpoint with the key and emits `agent_message_chunk` and `usage_update`. `initialize` advertises only `authMethods: ["opencode-login"]`, so there is no credential channel in-protocol (as T2.5 assumed).
  - **Plugin location (T3.5a):** a `plugin: ["file:///abs/path/plugin.js"]` entry in the harness-owned config loads from the app data folder. `plugin` arrays **concatenate** across layers (global first, then harness), so the user's own plugins (e.g. `opencode-runtime-fallback`) still load. Nothing needs to be written into the project or the user's config dir.
  - Note: the global config still loads underneath, so the user's global `provider` entries remain selectable in the picker; that's acceptable, because the harness sets `model`.
- Anthropic usage: `input_tokens` is post-breakpoint only; `total = cache_read + cache_creation + input`. Ch. 6 §6.1.
- Claude Agent SDK `Options.env` replaces (does not merge) `process.env`. Ch. 6 §6.3.
- Electron `safeStorage` on Linux with no secret store is detectable via `getSelectedStorageBackend() === "basic_text"`; `isEncryptionAvailable()` cannot detect it. Ch. 6 §6.4.
- ACP `agentCapabilities.mcpCapabilities.http` defaults to `false`; omitted capabilities are unsupported. Ch. 2 §2.2.
- Codex `approval_policy = "untrusted"` is retired; the repo's `codexPolicy("ask")` is a live defect. Ch. 2 §2.2.
- Codex's pre-tool veto lands at `item/commandExecution/requestApproval`, not `mcpServer/elicitation/request`. Ch. 2 §2.2.
- T3 Code puts the terminal in a drawer, not a right-panel tab; `SettingsSheet.tsx` has six sections. Ch. 9 review note.
- `settingSources: []` is SDK isolation mode and disables CLAUDE.md; omitting it loads all sources (installed `sdk.d.ts:2176-2185`). Phase 2 must not pass `[]`.
- `Query.setModel()` is only available in streaming input mode (installed `sdk.d.ts:2750-2755`); see S1.
- `events.payload` already exists and holds the whole event JSON (`db.ts:36-42`); new tool-I/O fields live inside that JSON, with only `payload_ref`/`payload_bytes` as new columns (phase 0, T0.6).
