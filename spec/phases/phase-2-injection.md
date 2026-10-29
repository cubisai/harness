# Phase 2 — Credential injection per driver

**Plan chapters:** Ch. 1 §1.3, Ch. 10 §10.2 · **Depends on:** 1 · **Independently shippable:** yes, behind a per-provider flag · **Risk:** **high** — this phase writes user-owned files.

Turns a stored `Provider` (phase 1) into the native configuration each driver reads. Four injectors, one per mechanism. Every injector returns a **complete** environment, never a patch, because the Claude Agent SDK's TypeScript `env` **replaces** the subprocess environment rather than merging it.

| Driver | Mechanism | Landing file |
|---|---|---|
| Claude | `Options.env` (spread `process.env` or lose `PATH`/`HOME`); settings sources left at their default | `src/main/providers/inject-claude.ts` (new) |
| Codex | `$CODEX_HOME/unskilled-<id>.config.toml` + `--profile unskilled-<id>` | `src/main/providers/inject-codex.ts` (new) |
| OpenCode | spawn env credential + generated provider config, schema per installed version (S8) | `src/main/providers/inject-opencode.ts` (new) |
| Generic ACP | `AcpAgentConfig.env` (`registry.ts:14`) | `src/main/providers/inject-acp.ts` (new) |

**Gate:** every injector that writes outside the app's data folder is off by default (`Settings.providerInjection: Record<AgentId, boolean>`, keyed by **driver/agent id** — the risk is which file a driver writes, not which provider it points at — safe default `false`) per the spec README's feature-flag convention. Claude's injector writes no file, so it needs no flag.

**Hand-over from phase 1:** phase 1 keeps the legacy global `process.env` export (`legacyEnv()`, T1.3). This phase replaces it per driver: a driver whose credential choice is `byok` gets its env from its `InjectionPlan`; a driver on `subscription` gets **no** provider keys at all. Once all four injectors land, delete the global export (`applySecretsToEnv`) — otherwise a legacy `ANTHROPIC_API_KEY` in `process.env` keeps overriding a Claude user who chose *Subscription login*.

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/01-byok-registry.md`](../../plan/docs/01-byok-registry.md) — §1.3 the per-driver injection mechanism, driver by driver, including the `Options.env`-replaces-subprocess-environment trap and the Codex profile-file approach.
- [`plan/docs/10-context-economy.md`](../../plan/docs/10-context-economy.md) — §10.2 the memory scopes and the duplication trap (what must never be injected because the agent already loads it).
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 2 §2.1 (the exact env vars, `~/.codex/config.toml` shape and OpenCode spawn-env pattern) and Part 1 §1.4 (WorkBuddy's `models.json`, a worked example of a harness writing provider config for someone else's agent).
- [`plan/docs/02-capability-parity.md`](../../plan/docs/02-capability-parity.md) — §2.3 for why Antigravity's injector is Gemini-only and default-off.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S2 (Codex `wire_api`), S6 (Antigravity's provider setting), S8 (OpenCode version, schema and credential variable).

---

### T2.1 — Define the shared injection contract and the per-provider gate

- **What:** Add `src/main/providers/inject.ts` with `InjectedEnv = Record<string, string>` and `InjectionPlan = { env: InjectedEnv; args?: string[]; files?: { path: string; contents: string }[]; warning?: string }`, plus `inject(provider, driverId, opts)` dispatching to the four injectors; add the `providerInjection` flag to `Settings`.
- **Files:** `src/main/providers/inject.ts` (new), `src/shared/types.ts` (modify), `src/main/settings.ts` (modify)
- **Acceptance:** `pnpm test -- inject` asserts `inject(provider, "claude").env.PATH` is defined and non-empty, and that `inject(provider, "codex")` with `providerInjection.codex !== true` returns a plan with `files: []` and no `args` (i.e. the write is gated off). A test asserts that with Claude's choice set to `subscription`, the Claude plan's env contains **no** `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`, even when `process.env` has a legacy one (strip them after spreading).
- **Notes:** Ch. 1 §1.3. The "env replaces" rule is the single most common cause of a working CLI breaking under the SDK — losing `PATH` means the agent cannot find `git`, and losing `HOME` breaks its own config discovery. Every injector spreads `process.env` first.
  - `InjectionPlan` is data, not side effects: the caller (T2.8) applies it, so a plan can be asserted in a unit test without touching the filesystem.
  - The gate is per driver: a user may want BYOK for Claude but not for the agent that writes `~/.codex`.

### T2.2 — Claude injector: `src/main/providers/inject-claude.ts`

- **What:** Build `Options.env` by spreading `process.env` then setting `ANTHROPIC_BASE_URL`, the correct one of `ANTHROPIC_API_KEY` (`X-Api-Key`) or `ANTHROPIC_AUTH_TOKEN` (`Authorization: Bearer`) from `provider.secret`, `ANTHROPIC_MODEL`, the three `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` pins from `ProviderModel.alias`, `ANTHROPIC_CUSTOM_HEADERS` (newline-separated `Name: Value`), and `CLAUDE_CODE_PROMPT_CACHE_TTL`; set `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` when `betaHeaders === "strip"`. Leave `settingSources` **unset** (all sources, like the CLI) and call `providerWarning()` for the feature-loss notice. Guard against a stale key in a settings file instead: before the turn, call the SDK's `resolveSettings({ cwd })` (`@alpha`, `sdk.d.ts:3114-3164`) and, if any source's `settings.env` sets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`, emit a `notice` naming the file that will override the provider.
- **Files:** `src/main/providers/inject-claude.ts` (new), `src/main/agents/claude.ts` (modify)
- **Acceptance:** `pnpm test -- inject` asserts (a) the plan's `env.PATH === process.env.PATH` and `env.HOME === process.env.HOME`; (b) a provider whose credential is a gateway token produces `ANTHROPIC_AUTH_TOKEN` and **not** `ANTHROPIC_API_KEY`; (c) a provider with `baseURL: "https://gateway.example.com"` returns a `warning` matching `/Remote Control/` and `/MCP tool search/`; (d) `claude.ts` builds its `Options` **without** a `settingSources` key (or with one that includes `"project"`) — a test fails if it is ever `[]`; (e) a fixture user-settings file whose `env` sets `ANTHROPIC_API_KEY` produces the override notice.
- **Notes:** Ch. 1 §1.3. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are two different headers, not aliases — picking the wrong one is the 401 in Ch. 1 §1.4.
  - `ANTHROPIC_CUSTOM_HEADERS` requires Claude Code ≥ 2.1.227; emit it only when `provider.headers` is non-empty.
  - `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is set **only** when the user enables model discovery, because a shared-key gateway would otherwise expose every model.
  - **Do not** pass `settingSources: []`: the installed SDK documents `[]` as "SDK isolation mode" and says the list "must include `'project'` to load CLAUDE.md files" (`sdk.d.ts:2176-2185`). `[]` would silently drop CLAUDE.md, hooks, permissions and user plugins — and break invariant 2's premise that Claude loads its own conventions. (Ch. 1 §1.3 originally recommended `[]`; corrected in review.)
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` also disables MCP tool search and preloads every MCP tool (plan open-items review note); say so next to the switch.
  - `ANTHROPIC_MODEL` and the alias pins are phase 1's catalog (`catalogFor`) rendered into env; keep them in one place so a model-list refresh cannot desync them.
  - **Also owns the driver side of T1.8** (deferred from phase 1): when a driver's credential is `byok`, its `models()` comes from `catalogFor(provider)` — Claude `claude.models`, Codex the catalog file, ACP the `model` config option — falling back to today's lists on `subscription`. Land it in the same change as the injector, so the picker never lists a model the agent cannot reach.

### T2.3 — Codex injector: `src/main/providers/inject-codex.ts` (**highest-risk task**)

> **Superseded 2026-09-26 by spike S10** (`open-questions.md`): `codex --profile X app-server` is rejected by 0.157, so no profile file is written. Shipped design: `-c` overrides on the app-server argv + key in the spawn env (`UNSKILLED_<ID>_KEY`) + a validated catalog in `<userData>/codex-catalogs/`. Nothing is written to `$CODEX_HOME`, so the backup/restore/remove-profile obligations below and the `providerInjection.codex` gate no longer apply (approved by the user). Code lives in `src/main/inject/codex.ts` (see `.ai/plans/phase-2-injection.md` for the directory deviation). The acceptance equivalent is `test/inject-codex.test.ts` plus the real-binary BYOK e2e in `test/codex-e2e.test.ts`, which asserts that `config.toml` is byte-identical and that no profile file exists.

- **What:** Write `$CODEX_HOME/unskilled-<id>.config.toml` containing `[model_providers.unskilled-<id>]` with `base_url`, `env_key` (or a `.auth` command — never both), `wire_api = "responses"`, headers, `query_params` and retry keys, plus `model_catalog_json` pointing at a generated catalog **file** in the app data folder; add `["--profile", "unskilled-<id>"]` to the Codex args. The `unskilled-` prefix keeps our profile and provider names from colliding with the user's own profiles and with Codex's built-in provider ids (a migrated provider is literally named `openai`). **Before any write**, copy the user's existing `$CODEX_HOME/config.toml` to `config.toml.<ISO-timestamp>.bak` (belt-and-braces: the injector never writes it, but a profile overlays it), and **refuse** to overwrite an existing `unskilled-<id>.config.toml` that lacks our generated-file header; provide `restoreCodexConfig()` and `removeCodexProfiles()`.
- **Files:** `src/main/providers/inject-codex.ts` (new), `src/main/index.ts` (modify — `args: ["app-server"]` at `index.ts:189` becomes profile-aware), `test/inject-codex.test.ts` (new)
- **Acceptance:** a test with a temp `CODEX_HOME` containing a `config.toml` asserts (a) the `.bak` file exists and its bytes equal the original byte-for-byte; (b) `<id>.config.toml` parses and its `base_url` matches the provider; (c) `restoreCodexConfig(home, backupPath)` restores `config.toml` byte-identically (`readFileSync` buffers equal); (d) a second inject over an already-backed-up config does **not** overwrite the first `.bak`; (e) a pre-existing, hand-written `unskilled-x.config.toml` without the generated header is left byte-identical and the inject returns an error; (f) `config.toml` itself is byte-identical after inject.
- **Notes:** Ch. 1 §1.3. `--profile <id>` loads `~/.codex/config.toml` then overlays `~/.codex/<id>.config.toml`; as of **0.134.0** the `[profiles.*]` table and the top-level `profile =` selector are no longer read.
  - Project-local `.codex/config.toml` silently ignores `model_provider`/`model_providers`, so provider keys are **user-level only**.
  - `model_catalog_json` is a **path to a JSON file**, not inline JSON, and a profile file can override it.
  - `env_key` and `.auth` are mutually exclusive — writing both is a config error, not a precedence question.
  - Prefer profile files over cloning `CODEX_HOME`, because cloning also forks auth state.
  - This is the one task in the whole spec that mutates a file the user owns and the app does not — its rollback test is not optional.

### T2.4 — OpenCode injector: `src/main/providers/inject-opencode.ts`

- **What:** ACP has no credential channel for the agent itself, so pass the key in the spawn environment via `AcpAgentConfig.env`, and materialize the provider with an explicit `models` map carrying `capabilities.tools` and `limit.context`/`limit.output`. **The schema depends on the installed OpenCode (spike S8):** the v2 schema is `providers.<id>` with `package` (`@opencode-ai/ai/providers/openai-compatible`) and `settings.baseURL`; the v1 line the preset installs (`opencode-ai`, `registry.ts:38`) uses `provider.<id>` with `npm` + `options.baseURL`. Detect the major version once (`opencode --version`) and emit the matching shape. **Prefer not writing the user's file at all:** if S8 confirms a harness-owned config path (a generated file in the app data folder selected by env var), use it; only if it does not, merge into the user-level `~/.config/opencode/opencode.json` (the location the repo already reads at `external.ts:41-43`) under the same timestamped-backup rule as Codex, gated by `providerInjection.opencode`.
- **Files:** `src/main/providers/inject-opencode.ts` (new), `src/main/agents/registry.ts` (modify — the `opencode` preset at `registry.ts:32-40`)
- **Acceptance:** `pnpm test -- inject` asserts, for both a v1 and a v2 version string, that the plan carries the decrypted key in the env variable S8 recorded and that the generated provider's `models` contains every `ProviderModel.id` with a `capabilities.tools` boolean, under the right top-level key (`provider` vs `providers`); if the merge path is used, a second test asserts a pre-existing `opencode.json` is backed up before the merge and that unrelated top-level keys survive.
- **Notes:** Ch. 1 §1.3. A custom provider has no Models.dev catalog entry, so the `models` map **must** be explicit — otherwise the picker is empty. Injecting the key as spawn env is what the OpenCode ACP docs prescribe for editor clients; which variable name the installed version reads is S8's job. Do not write anything into the project folder.

### T2.5 — Generic ACP injector: `src/main/providers/inject-acp.ts`

- **What:** Expand `AcpAgentConfig.env` (`registry.ts:14`) from the selected `Provider` — base URL as the agent's expected env var, the key, and `provider.env` — before spawning the preset, and pass it through `createAcpDriver`'s `connect()` (`driver.ts:201`).
- **Files:** `src/main/providers/inject-acp.ts` (new), `src/main/agents/acp/driver.ts` (modify), `src/main/agents/registry.ts` (modify)
- **Acceptance:** `pnpm test -- acp` spawns `test/fixtures/mock-acp-agent.mjs` with an injected env and asserts the mock reports the key present; and a test captures `console.error`/`console.warn` during injection and asserts no captured string contains the key.
- **Notes:** Ch. 1 §1.3. ACP's `initialize` negotiates `protocolVersion`, `clientCapabilities`, `clientInfo` and returns `authMethods` — there is **no** field for handing provider credentials to the agent; `session/new`'s only `env` lives inside a stdio MCP server entry, i.e. it configures the MCP subprocess, not the agent. So the harness-side `env` field is the only injection point.
  - **Exposure surface:** the key sits in the child process's environment — readable by the child and, on Linux, by any process that can read `/proc/<pid>/environ`. Document this in the injector's module comment and never log the env object.
  - The same injector covers Cursor and any user `agents.json` entry; a preset with no known credential variable gets `provider.env` only, and the UI must say the key may not reach it.

### T2.6 — Memory-scope guard: never inject what the agent already loads

- **What:** Add `src/main/providers/memory-scope.ts` with `memoryScopeCheck(projectPath)` returning warnings; emit a one-time `notice` when a project contains **both** `CLAUDE.md` and `AGENTS.md` (the same conventions load twice on Claude, and OpenCode also reads `CLAUDE.md`), and assert that no code path injects `CLAUDE.md`/`AGENTS.md` content or a skill body into a prompt.
- **Files:** `src/main/providers/memory-scope.ts` (new), `src/main/service.ts` (modify), `src/main/index.ts` (modify)
- **Acceptance:** a test with a temp project containing both files asserts `memoryScopeCheck()` returns a warning matching `/CLAUDE\.md/` and `/AGENTS\.md/` and that `service.send` emits exactly one `notice` for it; a project with only `AGENTS.md` returns `[]`; a test asserts `composePrompt(catalog(), "x", <a model-invoked skill name>)` throws (it already does, `compose.ts:16-18`) so a skill body is never injected for a model-invoked skill.
- **Notes:** Ch. 10 §10.2 and cross-phase invariant 2. Claude loads a four-tier `CLAUDE.md` hierarchy; Codex reads `AGENTS.md` once per run; OpenCode reads `AGENTS.md` and falls back to `CLAUDE.md`. The rule this enforces: a checkpoint carries **thread state only** — decisions, task status, files touched, commands and outcomes, open questions, cursor. Never conventions, never skill bodies, never reasoning the target cannot read.
  - The warning is a notice, not a block: both files can legitimately coexist (a Claude+Codex repo), so the harness states the duplication and lets the user decide.

### T2.7 — Redact secrets from every log and error path

- **What:** Add `src/main/providers/redact.ts` with `redactSecrets(text, secrets)` replacing every known key with `«redacted»`, and route all injector logging plus driver `error`/`notice` text through it.
- **Files:** `src/main/providers/redact.ts` (new), `src/main/providers/inject-*.ts` (modify), `src/main/index.ts` (modify)
- **Acceptance:** a test asserts `redactSecrets("auth failed for sk-ant-abc", ["sk-ant-abc"])` contains no `sk-ant-abc`; a test that forces an injector to fail (unwritable `CODEX_HOME`) spies on `console.error` and asserts the captured output contains neither the key nor its base64 ciphertext.
- **Notes:** Ch. 1 §1.3. This is the enforcement of the phase's exposure surface: a key may exist in a child process's environment but must never appear in an event, a notice, a log line, or the renderer. Keep the redactor a pure function so it is trivially testable and has no dependency on `SettingsStore`.

### T2.8 — Prove the four injectors with one regression harness

- **What:** Add `test/inject.test.ts` that runs all four injectors against fixture providers and asserts the phase's invariants in one place: `PATH`/`HOME` present, the key absent from every serialized plan and from captured logs, the gate respected, and no `files[].path` pointing inside the project `cwd`.
- **Files:** `test/inject.test.ts` (new), `test/fixtures/` (reuse `mock-acp-agent.mjs`; extract the inline fake from `claude-e2e.test.ts` rather than writing a new one)
- **Acceptance:** `pnpm test -- inject` passes a single `describe` that iterates `["claude", "codex", "opencode", "acp"]` and, for each, asserts `plan.env.PATH` is set, `JSON.stringify(plan)` does not contain the fixture key, and `plan.files.every(f => !f.path.startsWith(cwd))`.
- **Notes:** README conventions — Vitest, `test/*.test.ts`, reuse the existing fakes. The "no file under cwd" assertion is the mechanical form of invariant 2 (never inject what the target already loads) and invariant 3 (never write a user config without a backup): the only writable locations are the app data folder and `$CODEX_HOME`/`~/.config/opencode`, each backed up.

---

## Risks & rollback

- **Codex config.toml (highest).** A bad write breaks the user's own Codex setup outside this app. Mitigations: timestamped backup before any write (T2.3), a tested `restoreCodexConfig()`, one write per provider file (`<id>.config.toml` never touches `config.toml`), and the `providerInjection.codex` flag defaulting to `false`. Rollback: `restoreCodexConfig()` from the Settings UI, or manually copy the `.bak` back.
- **OpenCode user config.** Same class of risk, smaller surface: merge, never replace, and back up first. Unrelated top-level keys must survive a round-trip.
- **Env-replacement regression.** If any injector forgets to spread `process.env`, the agent loses `PATH`/`HOME`. T2.1's and T2.8's `PATH`/`HOME` assertions are the guard; run them for every injector, not just Claude.
- **Flag-off behaviour.** With every flag off the app must behave exactly as phase 1 left it (subscription login, no writes). Verify by running the full suite with `providerInjection` cleared.
- **Rollback command:** run `removeCodexProfiles()` (deletes only the generated `unskilled-*.config.toml` and catalog files), `restoreCodexConfig()` if `config.toml` differs from its backup, restore `opencode.json` from its `.bak` if the merge path was used, then revert the phase commits. The flag-off default means no user file was touched unless the user opted in.

## Exit criteria

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` are green.
- [ ] Injected env contains `PATH` and `HOME` for all four injectors; the key never appears in logs or events.
- [ ] The Codex backup exists and `restoreCodexConfig()` restores `config.toml` byte-identically.
- [ ] A non-first-party Claude base URL raises the Remote Control + MCP-tool-search warning.
- [ ] A project with both `CLAUDE.md` and `AGENTS.md` produces exactly one warning notice; no convention or skill body is ever injected.
- [ ] No injector writes a file inside the project `cwd` (asserted by T2.8).
- [ ] With every `providerInjection` flag off, behaviour is identical to phase 1.
- [ ] Claude's options never set `settingSources: []`; CLAUDE.md still loads under BYOK.
- [ ] A driver on *Subscription login* receives no provider key, even when a legacy key exists; the global `applySecretsToEnv` export is gone.

### Exit-criteria status (2026-09-26, commits f95ceaa…f09a2d7)

- [x] typecheck, test (242) and build are green; `electron . --smoke` passes against a temp user-data dir.
- [x] PATH/HOME present for all four injectors; key absent from serialized plans, argv, files, logs and stored events (`test/inject-regression.test.ts`).
- [~] Codex backup/restore: **not applicable** — S10 redesign writes nothing to `$CODEX_HOME` (real-binary e2e asserts `config.toml` byte-identical, no profile file).
- [x] Non-first-party Claude base URL raises the Remote Control + MCP tool search warning.
- [x] CLAUDE.md + AGENTS.md → exactly one notice; model-invoked skill bodies are never composed into a prompt.
- [x] No injector writes inside the project cwd.
- [~] "Flag-off identical to phase 1": no driver is gated any more (none writes outside app data). Intended behaviour change: app-stored keys no longer reach every process through the global env.
- [x] `settingSources` is never set; CLAUDE.md still loads under BYOK.
- [x] Subscription agents get no provider key (even a shell-exported one); `applySecretsToEnv` is gone.
- [ ] Manual: Claude BYOK in the running app; `dsh` receiving its DeepSeek key (dsh not installed here).
