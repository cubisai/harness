# Phase 1 — Provider registry (BYOK)

**Plan chapters:** Ch. 1 (all), Ch. 7 §7.2 · **Depends on:** 0 · **Independently shippable:** yes · **Risk:** med

Replaces the hardcoded credential surface (`SecretName` + `SECRET_ENV`, `settings.ts:13-17`) with one `Provider` record that every driver compiles into its own native config at run time. Subscription login stays a first-class peer; the old `secrets.*` fields are kept readable for one release.

**Out of scope:** any *new* injection into an agent process (phase 2), and the capability-driven UI (phase 3). This phase only stores providers, exposes them to the UI, and can probe them — while keeping today's legacy behaviour (the three saved keys exported into `process.env` for every agent) working unchanged until phase 2 replaces it.

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/01-byok-registry.md`](../../plan/docs/01-byok-registry.md) — the whole chapter: §1.1 the `Provider` schema and why each field is forced by a real harness, §1.2 storage + migration + the subscription-login decision, §1.4 the test-connection probes and 401/404/400 triage, §1.5 one catalog feeding four `models()`.
- [`plan/docs/07-ui-ux.md`](../../plan/docs/07-ui-ux.md) — §7.2 the settings surface this phase builds (provider list + editor, per-agent credential row, migration banner, Antigravity gate).
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 2 §2.1 (how each harness is actually pointed at a provider, incl. Codex `model_providers`), Part 1 §1.2 (OpenCode `settings.baseURL`) and §1.4–1.5 (WorkBuddy `models.json`, first-party BYOK comparison) — the survey the minimum field set was derived from.
- [`plan/docs/06-roadmap.md`](../../plan/docs/06-roadmap.md) — §6.4 on persistence and IPC migration, since this phase is the first to version `settings.json`.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S2 (Codex `wire_api`), S3 (`~/.codex/models.json`).

---

### T1.1 — Define the unified Provider schema in a new `src/main/providers.ts`

- **What:** Add `WireProtocol`, `ModelCapabilities`, `ProviderModel`, `ProviderSecret`, `Provider`, a `PROVIDER_ID` regex validator and a reserved-id set to `src/main/providers.ts`; add the structural `ProviderView` (a `Provider` with `secret` omitted) to `src/shared/types.ts`.
- **Files:** `src/main/providers.ts` (new), `src/shared/types.ts` (modify)
- **Acceptance:** `pnpm typecheck` green; `pnpm test -- providers` passes a test asserting `isProviderId("claude") === false` (reserved), `isProviderId("my-gateway") === true`, `isProviderId("a b") === false`, and `isProviderId("unskilled") === false`; a `satisfies Record<WireProtocol, Provider>` fixture with one literal per protocol compiles.
- **Notes:** Reproduce the interface verbatim from Ch. 1 §1.1 — each field is forced by a real harness (`query_params`, `http_headers`, `request_max_retries` from Codex; `settings.baseURL` + explicit `models` from OpenCode; the `X-Api-Key` vs `Authorization: Bearer` split from Claude). Reserved ids: `claude`, `codex`, `unskilled`, `default` — ids the harness itself uses as names (`unskilled` is the MCP tool-server name, `default` the model sentinel). Provider ids and agent ids are **separate namespaces**: the migrated `deepseek` provider legitimately shares the DeepSeek agent's id, and credential choices are keyed by agent id, so no lookup confuses them. Collisions with a *vendor's* names are the injector's problem, not the registry's — phase 2 namespaces every generated id (e.g. `unskilled-<id>`), because Codex ships built-in provider ids such as `openai`. `wireProtocol` is not cosmetic: it picks the path suffix, the request body, and which probes are legal.

### T1.2 — Version `settings.json` and migrate the three legacy secrets

- **What:** Add `schemaVersion: number` to the file shape (it has **no** version field today; an absent field means the legacy v1 shape, and this phase writes `2`) and a one-shot forward migration: when `schemaVersion < 2` and any of `secrets.{anthropic,deepseek,openai}` exist, synthesize one `Provider` per key (`anthropic` → `anthropic-messages`; `deepseek`, `openai` → `openai-chat`) whose `secret.kind = "safeStorage"` and `secret.ciphertext` is the existing blob byte-for-byte, and record `migratedProviders: string[]`. **Do not delete `secrets.*`.**
- **Files:** `src/main/settings.ts` (modify), `test/fixtures/legacy-settings.json` (new), `test/settings.test.ts` (modify)
- **Acceptance:** a test loads the fixture (which has `secrets.anthropic` + `secrets.openai` and no `schemaVersion`) and asserts: exactly two `Provider`s; `providers.find(p => p.id === "anthropic")!.wireProtocol === "anthropic-messages"`; that provider's `secret.ciphertext` is byte-identical to the fixture's blob; `migratedProviders` equals `["anthropic", "openai"]`; and after re-reading the file, `JSON.parse(readFileSync(file)).secrets` still contains both original blobs.
- **Notes:** Ch. 1 §1.2. Moving the *ciphertext* (not the plaintext) between JSON fields is opaque-safe, so `safeStorage` stays.
  - Keep the atomic write at `settings.ts:50-55` (tmp file → `rename`, mode `0o600`) and write `schemaVersion`, `providers` and `migratedProviders` in **one** write, not several.
  - The migration must be idempotent: a second `new SettingsStore(file, box)` must not duplicate providers, and must not re-run once `schemaVersion === 2`.
  - A provider id synthesized from a legacy key is `anthropic` / `deepseek` / `openai`; these are *not* in the reserved set, so a later user-created provider may legitimately be named after a gateway instead.

### T1.3 — Retire `SECRET_ENV` in favour of provider-scoped secret access

- **What:** Delete `SECRET_ENV`; replace `setSecret`/`secret`/`env()` with `setProviderSecret(id, value | null)`, `providerSecret(id)` and `providerEnv(id)` (the selected provider's `env` map plus its resolved key). Keep `SecretName` only as a deprecated alias for a provider id in `src/shared/types.ts`. **Preserve today's behaviour:** `applySecretsToEnv` (`index.ts:137-148`) currently exports the three saved keys into `process.env` for *every* agent — that is how a saved `anthropic` key reaches Claude and `deepseek` reaches `dsh` today. Until phase 2 lands per-driver injection, keep that export, re-sourced from the migrated providers through a `legacyEnv()` in `providers.ts` (`anthropic` → `ANTHROPIC_API_KEY`, `deepseek` → `DEEPSEEK_API_KEY`, `openai` → `OPENAI_API_KEY`) — otherwise this phase silently stops every saved key from reaching its agent.
- **Files:** `src/main/settings.ts` (modify), `src/shared/types.ts` (modify), `src/main/index.ts` (modify)
- **Acceptance:** `grep -rn "SECRET_ENV" src/` returns no matches; `pnpm test -- settings` passes an assertion that the module has no `SECRET_ENV` export; a test migrates a legacy file with `secrets.deepseek` and asserts `legacyEnv()` returns `{ DEEPSEEK_API_KEY: <plaintext> }` (the value today's `env()` returns — the old `settings.test.ts:41` assertion, kept); `index.ts`'s `settings:secret` handler (`index.ts:307-316`) calls `setProviderSecret` and rejects an unknown provider id with a thrown `unknown provider <id>`.
- **Notes:** Ch. 1 §1.2. `SECRET_ENV` is read in three places today: the import (`index.ts:19`), `applySecretsToEnv` (`index.ts:137-148`) and the IPC handler (`index.ts:307-308`). The editor allow-list at `index.ts:264` (`Object.keys(settings.env())`) must switch to `Object.keys(settings.providerEnv(selectedId))` so keys still stay out of the editor's environment. `envRef` secrets read from **our own** process env, so `providerSecret` must resolve `kind: "envRef"` without touching `safeStorage`.

### T1.4 — Model the subscription-login-vs-BYOK choice per agent

- **What:** Add a per-agent credential union `{ kind: "byok"; providerId: string } | { kind: "subscription" }` persisted in `Settings`, where `subscription` means *the agent's own login/config* (Claude/Codex subscription, `opencode auth login`, dsh's own settings). Default every agent to `subscription` — **except** that a legacy `anthropic` key defaults Claude to `{ kind: "byok", providerId: "anthropic" }`, because that key already overrides Claude's subscription today through `process.env` and the upgrade must not change which credential Claude uses. (A `byok` default for ACP agents is impossible: with no provider configured there is no `providerId` to point at.) Add a pure `providerWarning(provider, agentId)` returning the feature-loss text when Claude is pointed at a non-first-party host.
- **Files:** `src/shared/types.ts` (modify), `src/main/settings.ts` (modify), `src/main/providers.ts` (modify)
- **Acceptance:** `pnpm test -- providers` asserts: the default for `claude` is `{ kind: "subscription" }` on a fresh file and `{ kind: "byok", providerId: "anthropic" }` after migrating a file with `secrets.anthropic`; the default for `opencode` is `{ kind: "subscription" }`; `providerWarning({ baseURL: "https://api.anthropic.com", ... }, "claude")` is `null`; and `providerWarning({ baseURL: "https://gateway.example.com", ... }, "claude")` matches `/Remote Control/` and `/MCP tool search/`.
- **Notes:** Ch. 1 §1.2/§1.3. The criteria are empirical: `ANTHROPIC_API_KEY` overrides a Pro/Max/Team/Enterprise subscription; setting only `ANTHROPIC_BASE_URL` without a gateway credential leaves the saved login active; a non-first-party `ANTHROPIC_BASE_URL` disables Remote Control as of v2.1.196 and MCP tool search by default. Never delete the subscription path — it carries entitlements a BYOK key cannot reproduce, which is exactly the "does removal break a paying user?" test.

### T1.5 — Replace the API-keys section with a provider list + editor

- **What:** Delete the `KEYS` constant (`SettingsSheet.tsx:18-22`) and the `SecretRow` component (`SettingsSheet.tsx:187-245`); add a new `ProviderSheet.tsx` with a list (label, protocol chip, base-URL **host only**, model count, state dot) and an editor ordered protocol → base URL → credential → models, plus the "Send the URL exactly as typed" switch (`pathMode: "raw"`) and the "strip experimental headers" switch (`betaHeaders: "strip"`).
- **Files:** `src/renderer/src/components/ProviderSheet.tsx` (new), `src/renderer/src/components/SettingsSheet.tsx` (modify), `src/renderer/src/api.ts` (modify), `src/shared/types.ts` (modify)
- **Acceptance:** `pnpm typecheck` green and `pnpm build` green; `grep -n "SecretRow\|const KEYS" src/renderer/src/components/SettingsSheet.tsx` returns nothing; a component test (`.tsx`, per Phase 0 T0.10) renders the list from a fixture of two `ProviderView`s and asserts the rendered text contains each host but **not** any substring of a secret value.
- **Notes:** Ch. 7 §7.2. Reuse the existing `.dot-ok` / `.value` / `.button ghost danger` vocabulary (`SettingsSheet.tsx:230-241`) and the `.sheet` / `.segmented` / `.row` classes; do not invent a parallel class set (Ch. 7 §7.9). The base-URL cell shows the host, never the full URL — a gateway URL can carry credentials in userinfo. The editor's field order matches the failure-mode order in Ch. 1 §1.4, so a user debugging a 404 meets the raw-path switch exactly where they need it.

### T1.6 — Implement the three-probe test connection with 401/404/400 triage

- **What:** Add `testConnection(provider, model)` to `src/main/providers.ts` running three probes per protocol: (1) list models, (2) one minimal generation (`max_tokens: 1` for Messages/Chat, `max_output_tokens: 1` for Responses), (3) a tools probe that sends one trivial function and requires a tool-call block back; return `{ reachable, listsModels, supportsTools, triage? }`.
- **Files:** `src/main/providers.ts` (modify), `src/main/index.ts` (modify), `src/preload/index.ts` (modify)
- **Acceptance:** `pnpm test -- providers` passes: with a stub returning `401` the result has `reachable === false` and `triage` matching `/X-Api-Key/` and `/Authorization: Bearer/`; with a stub that answers chat but returns no tool-call block, `supportsTools === false` while `reachable === true`; with a stub returning `404`, `triage` matches `/raw/` (the `pathMode: "raw"` hint).
- **Notes:** Ch. 1 §1.4. The tools probe is the load-bearing one — an OpenAI-compatible endpoint that answers chat but cannot call tools must be reported as failing, because Ch. 2's parity promise depends on it.
  - 400 → suggest `betaHeaders: "strip"` (a rejected `anthropic-beta` header or a strict schema); Responses-only fields are silently ignored on Chat Completions.
  - Model listing is meaningful for Claude only with gateway discovery enabled, so "lists models" is allowed to be `null`/skipped rather than a failure.
  - Failure text is the triage sentence, never a bare status code.

### T1.7 — Show the migration banner and the per-agent credential row

- **What:** On first launch after the upgrade, render the migrated providers as *"Anthropic (from your saved key)"* etc. with a one-line banner *"Your saved keys now live in Providers. Nothing was deleted."*, and above the list add one row per installed agent — `Claude — [Subscription login | Provider ▾]`, `Codex — [Subscription login | Provider ▾]`, ACP agents `[Agent's own config | Provider ▾]` — showing `providerWarning()` inline when a provider is chosen for Claude.
- **Files:** `src/renderer/src/components/ProviderSheet.tsx` (modify), `src/renderer/src/components/SettingsSheet.tsx` (modify), `src/shared/types.ts` (modify)
- **Acceptance:** a component test (`.tsx`, T0.10) renders a `SettingsView` whose `migratedProviders` is `["anthropic","openai"]` and asserts the banner text is present and that each migrated row's label matches `/from your saved key/`; a second render with `migratedProviders: []` asserts the banner is absent.
- **Notes:** Ch. 7 §7.2. The banner is truthful only because T1.2 keeps `secrets.*`. The agent row is where the subscription-vs-BYOK decision becomes visible rather than a footnote. Antigravity is **not** listed in the generic provider picker (Ch. 2 §2.3) — its opt-in gate belongs to phase 9.

### T1.8 — Feed one provider definition into every driver's `models()`

- **What:** Compile `Provider.models` into each native form: Claude → `models()` plus `ANTHROPIC_DEFAULT_*_MODEL` alias pins from `ProviderModel.alias`; Codex → the generated catalog path; OpenCode → explicit `models` with `capabilities` and `limit`; ACP → `configOptions` of category `model`. Driver model lists come from the registry, not from hardcoded arrays.
- **Files:** `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `src/main/providers.ts` (modify)
- **Acceptance:** `pnpm test -- providers` passes a **snapshot test** of `catalogFor(provider)` for one fixture provider with two models (one with `alias: "opus"`, one without) across all four protocols; the snapshot contains the wire `modelID` when set and the picker `id` otherwise.
- **Status (2026-09-26):** the pure `catalogFor` and its snapshot test (this task's acceptance) shipped in step A. **The driver wiring — `models()` reading the registry — moves to Phase 2** (T2.2 renders the same catalog into env). Without injection, a user-created provider's models would show in the picker while the agent still talks to its default endpoint, and the migrated providers carry no models to show. `MODELS` (`claude.ts:47`) stays the only Claude list until then.
- **Notes:** Ch. 1 §1.5. `alias` exists because Claude resolves `opus`/`sonnet`/`haiku` through `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`, and `haiku` also serves background tasks — unpinned aliases drift and trigger premature compaction. Keep `claude.ts`'s `MODELS` array (`claude.ts:45-50`) as the no-provider fallback until phase 2 lands injection. A custom provider has no Models.dev catalog entry, which is why OpenCode's model map must be declared explicitly.

### T1.9 — Prove the renderer view never carries a secret

- **What:** Replace `SettingsView.secretsSet: Record<SecretName, boolean>` (`shared/types.ts:158`) with `providers: ProviderView[]` and `providerCredential: Record<string, CredentialChoice>`, and keep `secretsEncrypted`. Add a test that the whole `view()` payload is secret-free.
- **Files:** `src/shared/types.ts` (modify), `src/main/settings.ts` (modify), `src/renderer/src/api.ts` (modify), `test/settings.test.ts` (modify)
- **Acceptance:** a test stores a key through `setProviderSecret`, then asserts `JSON.stringify(store.view())` contains neither the plaintext key nor its base64 ciphertext, and that `view().providers.every(p => !("secret" in p))` is `true`.
- **Notes:** Ch. 1 §1.2. The old test at `settings.test.ts:34-44` asserts `secretsSet`; rewrite it against `providers` rather than deleting the intent — "is it set" is still the only thing the renderer may learn. `secretsEncrypted` still reports whether the OS offered a keychain.

### T1.10 — Wire provider CRUD through IPC and the preload bridge

- **What:** Add `providers:list`, `providers:save`, `providers:remove`, `providers:test` and `providers:setCredential` IPC handlers in `index.ts`; extend `UnskilledApi` in `src/shared/types.ts` and the `api` object in `src/preload/index.ts` (`setSecret` at `preload/index.ts:27` becomes `setProviderSecret`).
- **Files:** `src/main/index.ts` (modify), `src/preload/index.ts` (modify), `src/shared/types.ts` (modify)
- **Acceptance:** `pnpm test -- service` (or a new `test/providers-ipc.test.ts`) asserts that saving a provider with a duplicate id and a changed `wireProtocol` returns the updated `ProviderView` and that removing a provider the migration created leaves `secrets.*` untouched; `grep -c "setSecret" src/preload/index.ts` returns `0`.
- **Notes:** Ch. 7 §7.2. IPC boundaries are where a plaintext key could accidentally reach the renderer, so `providers:save` takes the secret as a write-only argument and returns a `ProviderView`, never an echo of the input. Setting or removing a provider secret disposes running drivers so the next turn starts with the new environment (mirrors `index.ts:310-312`).

---

## Risks & rollback

- **Downgrade safety.** The migration writes new fields but never deletes `secrets.*`. Rollback is: ship a build that ignores `providers` and reads `secrets.*` as before — the keys still decrypt because the ciphertext was copied, not moved. Verify by downgrading once during review.
- **Corrupt/partial file.** `read()` (`settings.ts:41-48`) resets a corrupt file to defaults; if that ever fired *between* the schema bump and the provider write, the keys would be lost. The single atomic write in T1.2 is the mitigation — do not split it.
- **Silent re-encryption.** Never re-encrypt a migrated blob; that would need the plaintext and could fail on another machine's keychain. Copy the blob verbatim.
- **UI regression.** Deleting `SecretRow` removes the only key-entry surface. Land T1.5, T1.9 and T1.10 in the same commit as T1.3, or the app has no way to set a key.
- **Silent key loss.** Deleting `SECRET_ENV` without `legacyEnv()` would stop every saved key from reaching its agent while the UI still says "Saved". T1.3's `legacyEnv()` assertion is the guard; verify once by hand that a saved DeepSeek key still reaches `dsh` after the upgrade.
- **Rollback command:** revert the phase's commits; `settings.json` keeps working because `schemaVersion` is ignored by an older build and `secrets.*` is intact.

## Exit criteria

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` are green.
- [ ] A legacy `settings.json` fixture migrates to providers with `secrets.*` intact and the migration is idempotent.
- [ ] `grep -rn "SECRET_ENV" src/` returns nothing.
- [ ] The provider list is snapshot-tested and the renderer view is proven secret-free.
- [ ] Test connection reports reachable / lists-models / supports-tools separately, with 401/404/400 triage text.
- [ ] Choosing a non-first-party provider for Claude shows the Remote Control + MCP-tool-search warning; subscription login is still selectable.
- [ ] Every saved legacy key still reaches the same agent process it reached before the upgrade (`legacyEnv()`), and Claude's default credential matches what it effectively used before.
