# Phase 9 — Antigravity opt-in + release hardening

Depends on **1, 2, 3** for the Antigravity gate, and on **5** (T9.4/T9.5 extend `cache-policy.ts`), **6** (T9.7, T9.10's handoff checks) and **8** (T9.8's Settings IA, T9.10's render snapshot) for release hardening. Ships the last provider behind a legal gate, and verifies — rather than re-implements — that the M4 migrations are reversible before release. Leaves `pnpm typecheck`, `pnpm test` and `pnpm build` green.

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/02-capability-parity.md`](../../plan/docs/02-capability-parity.md) — §2.3, the Antigravity findings: no OpenAI/Anthropic BYOK, Gemini-compatible endpoints only, and third-party access treated as a ToS breach.
- [`plan/docs/06-roadmap.md`](../../plan/docs/06-roadmap.md) — §6.4 (persistence and IPC migration, including `sessionId` as a one-release projection), §6.5 (the test and CI split), §6.6 (the irreversible-risk table), §6.7 (release strategy and rollback triggers).
- [`plan/docs/01-byok-registry.md`](../../plan/docs/01-byok-registry.md) — §1.2, the subscription-login-vs-BYOK judgement this phase's rollback trigger protects.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 1 §1.5 (the first-party BYOK comparison, i.e. what "supported" means per vendor) and §1.6 (which surveyed harnesses are archived or unmaintained — useful when deciding what to document as a reference).
- The plan's own **待完善事项 / Open items** section, near the end of [`plan/docs/M4-centralized-harness-plan.md`](../../plan/docs/M4-centralized-harness-plan.md), lists every `[U]` this phase must not present as settled.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S6 (Antigravity).

---

## Antigravity, honestly

### T9.1 — Gate Antigravity behind a default-off opt-in with a persisted acknowledgement
- **What:** Antigravity is reachable only through the community `agy-acp` adapter; Google's own docs offer no OpenAI/Anthropic BYOK, and third-party access is a Terms-of-Service breach that may lead to account suspension (Antigravity ToS §6). Default it off; enabling requires an explicit acknowledgement that **persists**.
- **Files:** `src/main/settings.ts` (modify: `antigravity` flag + `antigravityAck` with a version and timestamp), `src/main/agents/registry.ts` (modify: filter the preset unless enabled), `src/renderer/src/components/SettingsSheet.tsx` (modify: toggle + disclosure text under **Agents & Providers**)
- **Acceptance:** with a fresh settings file, `listAgents()` does not include Antigravity; toggling on without acknowledging does not enable it; enabling requires the acknowledgement and the acknowledgement survives a restart. A test asserts the flag defaults `false` and the preset is filtered out when false.
- **Notes:** Ch. 2 §2.3 (recommendation: option 1 — opt-in behind a ToS disclosure). The acknowledgement is persisted, not session-scoped. Never use a "Full access"-style default here.

### T9.2 — Amber "Unsupported · Gemini-compatible endpoints only" chip; exclude from the provider picker
- **What:** when enabled, the Antigravity agent row shows an amber chip with that exact text; it never appears in the generic BYOK provider picker, because it has no OpenAI/Anthropic BYOK path.
- **Files:** `src/renderer/src/components/Sidebar.tsx` (modify: agent row), the Library agents view (`src/renderer/src/components/Library.tsx`, modify), `src/renderer/src/palette.ts` (modify: exclude from provider actions), `src/renderer/src/styles/app.css` (modify: `--warning` token)
- **Acceptance:** a test asserts Antigravity is absent from the provider picker by default; when enabled, the agent row renders the chip; the picker's provider list never contains it, enabled or not.
- **Notes:** Ch. 2 §2.3. "Gemini-compatible endpoints only" is the honest label; do not advertise it as a BYOK provider. Its settings file (`~/.gemini/antigravity-cli/settings.json`, `modelProvider`) is `[U]` — see open-questions S6.

---

## Release strategy

### T9.3 — Audit the feature flags; Claude and Codex first, Antigravity last
- **What:** do not add a second flag system. The flags already exist — Phase 2's `providerInjection` (per driver) and T9.1's `antigravity` gate. This task audits them for release: every driver that writes outside the app's data folder defaults off, and the rollout order is Claude → Codex → others → Antigravity last.
- **Files:** `src/main/settings.ts` (modify only if a default is wrong), `test/flags.test.ts` (new)
- **Acceptance:** a test enumerates `providerInjection` keys plus `antigravity` and asserts their defaults (`codex`, `opencode` and `antigravity` off); flipping one flag changes only that driver's plan.
- **Notes:** Ch. 6 §6.7, spec README conventions ("safe default of off for anything that writes outside the app's data folder"). Codex injection writes `$CODEX_HOME` files (Ch. 6 §6.3), so its flag defaults off.

### T9.4 — Keep telemetry at zero; compute the rollback figures locally
- **What:** no new network calls for usage, cache or limits; the hit-rate and prefix-stability figures are computed locally from persisted `turn-end` usage fields.
- **Files:** `src/main/cache-policy.ts` (modify: compute), `src/main/db.ts` (modify: read `turn-end` usage), no new endpoints
- **Acceptance:** a grep/test asserts no usage- or cache-reporting code path issues an outbound request; the cumulative session hit rate is derived as `ΣcacheRead / Σ(cacheRead + cacheWrite + netNew)`, not the arithmetic mean of per-turn rates.
- **Notes:** Ch. 6 §6.7 and §6.5; Ch. 4 review note (define cumulative, not mean).

### T9.5 — Rollback triggers, pinned numerically
- **What:** declare the three triggers and the threshold: (1) any provider silently downgrading a subscription login; (2) config-file backup/restore failing on **any** platform; (3) the post-M4.5 cache-hit regression — cache read hit-rate over the first 7 days after M4.5 falls **more than 5 percentage points** below the M3 baseline captured over the 7 days before it. Assertion form: `expect(hitRate(m4_5) - hitRate(m3)).toBeGreaterThan(-0.05)`, plus prefix-stability assertions failing on more than 1% of turns.
- **Files:** `src/main/cache-policy.ts` (modify: the comparison helper), `test/cache-regression.test.ts` (new)
- **Acceptance:** the helper returns pass/fail for a supplied baseline and current window; a fixture with a −6 pp delta fails and a −4 pp delta passes; the 1%-of-turns rule is asserted on a synthetic prefix-stability series.
- **Notes:** Ch. 6 §6.7. Because telemetry is zero, both figures are computed locally and never leave the machine.

---

## Migration & compatibility

### T9.6 — settings.json: verify the Phase 1 migration, add export/import, fix the keychain flag
- **What:** the `schemaVersion` introduction and the `secrets.*` → `providers` migration are **Phase 1 T1.2** (absent field = legacy v1, writes `2`); do not implement them again. This task adds what Phase 1 did not: a settings export/import (providers + credential choices; secrets exported only as their opaque ciphertext, which is machine-bound — say so in the UI), a corrupt-file test (`read()` resets a corrupt file to `{}`, `settings.ts:41-47`, and the next write would then discard `secrets.*` — back the corrupt file up to `settings.json.corrupt-<ts>` before the reset), and a downgrade check.
- **Files:** `src/main/settings.ts` (modify), `src/shared/types.ts` (modify), `test/settings-migration.test.ts` (new) — reuse Phase 1's `test/fixtures/legacy-settings.json`, do not add a second legacy fixture
- **Acceptance:** loading Phase 1's legacy fixture still yields `schemaVersion: 2` with `secrets` intact; a corrupt file starts with defaults **and** leaves a `settings.json.corrupt-*` copy; export → wipe → import restores providers and credential choices on the same machine. The downgrade story is documented: an older build ignores `providers` and still reads `secrets.*`.
- **Notes:** Ch. 6 §6.4. This is an **introduction, not a bump** — already done in Phase 1. While in this file, re-source `SecretBox.available` from `safeStorage.getSelectedStorageBackend() !== "basic_text"` on Linux (`src/main/index.ts:133` uses `isEncryptionAvailable()`, which can be `true` under `basic_text`) — Ch. 6 §6.4.

### T9.7 — threads.bindings: verify the one-way transform is reversible in practice
- **What:** the `bindings` column, the read-only `sessionId` projection and thread export/import are **Phase 6 T6.1/T6.2**; do not add another migration step. This task is the release gate on them: `sessionId` → `bindings` is one-way (you can synthesise `sessionId` from `bindings[activeProviderKey]`, not the reverse), so before release prove that an M3 build can still open a database the M4 build wrote, and that a pre-migration export imports cleanly.
- **Files:** `test/bindings-rollback.test.ts` (new); `src/main/db.ts` only if the test finds a defect
- **Acceptance:** after migration, `Thread.sessionId` still reads `bindings[activeProviderKey]` for a legacy thread; a rollback test imports pre-migration thread JSON and restores the old shape; a test opens a database written by the M4 build with the M3 `Store` (checked out from the last M3 tag into a fixture) and lists threads and events without error; a test asserts no code writes `sessionId` directly after the migration.
- **Notes:** Ch. 6 §6.4, §6.6. The M3 build's `migrate()` stops at its own `steps.length`, and its `SELECT` lists name columns explicitly (`THREAD_COLS`, `db.ts:159`), so extra columns are ignored — the test should confirm that rather than assume it. The per-step migration guard is Phase 0 T0.6's fix.

---

## Docs

### T9.8 — README: rewrite the Settings and Agents sections
- **What:** the Settings section (`README.md:51-61`) describes one sheet with three API keys — update it for the left-nav IA (T8.12) and the provider registry (Ch. 1). The Agents section (`README.md:69-89`) describes current per-agent behaviour — update it for capability-driven degradation, the opt-in Antigravity gate, and the `untrusted` → `on-request` Codex fix.
- **Files:** `README.md` (modify)
- **Acceptance:** no README text still claims "three API keys" or a single scrolling sheet; the Antigravity bullet states it is opt-in, unsupported, and ToS-gated; the Codex bullet no longer names `untrusted`; the CI paragraph (`README.md:143`) matches the workflow phase 0 created.
- **Notes:** Ch. 2 §2.2 (the `untrusted` retirement), Ch. 9 §9.6, Ch. 1.

### T9.9 — HARNESS.md: update only if the contract changed
- **What:** if phase 2/3 changed the harness contract (skill delivery modes, MCP delivery, pre-tool-veto guarantees), update HARNESS.md; otherwise make no edit.
- **Files:** `plan/docs/HARNESS.md` (modify only if needed)
- **Acceptance:** every capability the README claims is either true in HARNESS.md or explicitly listed as degraded; the HARNESS.md diff is empty when no contract changed.
- **Notes:** README names HARNESS.md as the contract (`README.md:9`). Ch. 2 §2.4 (`capabilities` descriptor) is the likely trigger; if nothing in the contract moved, say so and leave it.

---

## Smoke + CI

### T9.10 — Extend the smoke test
- **What:** add smoke checks for the provider registry answers, the migration path on a legacy settings file, handoff invariants, and the four-driver render snapshot.
- **Files:** `src/main/index.ts` (modify: the `--smoke` block at `:420-460` and the bridge probe at `:431`), `scripts/smoke.mjs` (pass-through only, no change needed), `test/*.test.ts` for the unit-level checks
- **Acceptance:** `pnpm smoke` prints `smoke: providers ok`, `smoke: migration ok`, `smoke: handoff ok`, `smoke: render-parity ok`, and exits non-zero if any fails; running against the legacy `settings.json` fixture still exits 0. Add the packaged-app smoke run to CI (the root `README.md:143` already claims it) as a job after Phase 0's `test` matrix.
- **Notes:** Ch. 6 §6.5. `scripts/smoke.mjs:21-24` only spawns the packaged app, so the checks live in `index.ts`. Reuse T7.12/T8.15's render snapshot fixture rather than writing a second one.

### T9.11 — CI: Antigravity/Gemini must never run
- **What:** enforce at the workflow layer — no Antigravity/Gemini credential is ever a CI secret; the job exports an explicit env allowlist (only `UNSKILLED_CODEX_BIN` and the fake-endpoint variables); any Antigravity spec stays outside the `test/**/*.test.ts` include glob (e.g. under `manual/`).
- **Files:** `.github/workflows/ci.yml` (created in phase 0), `vitest.config.ts` (modify)
- **Acceptance:** a grep over the workflow finds no Gemini/Antigravity secret and shows the explicit allowlist; a test asserts the Antigravity spec path is not collected by the default glob; the ToS acknowledgement gate stays default-off.
- **Notes:** Ch. 6 §6.5. No `.github/` exists in the repo today — phase 0 creates the workflow. Enforce by configuration, not by intention.

### T9.12 — Rollback drill: documented and reviewer-followable
- **What:** write the rollback procedure and its triggers (T9.5), so a reviewer can run it end to end on a test machine.
- **Files:** `plan/docs/rollback.md` (new — beside the other plan docs; the repo has no top-level `docs/`), `scripts/rollback-check.mjs` (new: reads persisted usage, prints the 7-day hit-rate delta and its pass/fail against −5 pp)
- **Acceptance:** a reviewer follows the doc on a test machine: export settings + threads, downgrade to the M3 build, and confirm `Thread.sessionId` and `secrets.*` still work; the check script prints the delta and the verdict.
- **Notes:** Ch. 6 §6.7, §6.6. The drill includes Phase 2's `removeCodexProfiles()` + `restoreCodexConfig()` and the OpenCode backup restore (invariant 3). The M3 baseline window needs 7 days of *pre-M4* usage, but M3 never persisted cache fields — so the baseline is only available if Phase 0 ships (and records usage) at least 7 days before the M4.5 release; say so in the doc, or the −5 pp trigger has nothing to compare against.

---

## Risks & rollback

- **Legal.** Enabling Antigravity without the acknowledgement risks user account suspension. The gate is the mitigation, not a warning (Ch. 2 §2.3; Ch. 6 §6.6).
- **Irreversible.** The `sessionId` → `bindings` transform and the `~/.codex/config.toml` write. Both need a timestamped backup and a tested restore **before** release (invariant 3; Ch. 6 §6.6).
- **Trigger-based rollback.** Roll back to Milestone 3 behaviour if any T9.5 trigger fires; a backup/restore failure on even one platform is a release blocker, not a platform bug.
- **No silent downgrade.** Any provider downgrading a subscription login must be surfaced, never absorbed (invariant 7).

## Exit criteria

- [ ] Antigravity is absent from the provider picker by default (test).
- [ ] Enabling Antigravity requires a persisted acknowledgement (test).
- [ ] A legacy settings file migrates to the current `schemaVersion` with no data loss (test).
- [ ] `Thread.sessionId` remains a working read-only projection after the bindings migration (test).
- [ ] README Settings/Agents sections match the shipped UI; HARNESS.md is updated or provably unchanged.
- [ ] `pnpm smoke` covers provider registry, migration, handoff invariants and render parity.
- [ ] CI has no Antigravity/Gemini secret and no Antigravity test in the default glob.
- [ ] The rollback drill is documented and a reviewer has run it.
