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
