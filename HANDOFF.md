# Handoff — after Phase 2 (credential injection)

Written 2026-09-26 at the end of the Phase 2 session. Read this, then `CLAUDE.md` (the opencode-delegation workflow), then `spec/README.md`.

## Where things stand

| Phase | State | Commits |
|---|---|---|
| 0 — Substrate | done (CI workflow not yet run on GitHub) | `f41a196` |
| 1 — Provider registry | done | `8b68753` |
| 2 — Credential injection | **done**: typecheck + 242 tests + build + `electron . --smoke` green | `f95ceaa` A+B, `5726269` C, `bf0c569` D, `8cb39a6` E, `242848e` F, `f09a2d7` G (+ `5ce511c` flaky-test fix) |

**Uncommitted on purpose (the user decides):** `.gitignore`, `plan/docs/*` edits, `CLAUDE.md`, `HANDOFF.md`, all of `spec/`. Phase commits carry code + tests only, with no attribution trailer.

## What Phase 2 shipped (`src/main/inject/`)

- `index.ts`: `injectionFor(source, agentId, env, opts)` → an `InjectionPlan` (env/args/files/warning/error/byok) with a non-enumerable redacting `toJSON`. On subscription it strips every provider-key var, including shell-exported ones.
- `claude.ts`: `Options.env`. `api.anthropic.com` gets `ANTHROPIC_API_KEY`; any other host gets `ANTHROPIC_AUTH_TOKEN`. Plus alias pins, custom headers, strip-betas, and a `resolveSettings()` stale-key notice. `settingSources` is never set.
- `codex.ts`: **S10** — `--profile` is rejected by `codex app-server` (0.157), so it uses `-c` overrides, the key in `UNSKILLED_<ID>_KEY`, and a catalog in `<userData>/codex-catalogs/` that is validated with `codex debug models`. Nothing is written to `$CODEX_HOME`. A `configWarning` on a BYOK start counts as a failure.
- `opencode.ts`: **S8** — the v1 schema goes through `OPENCODE_CONFIG_CONTENT` with `apiKey: "{env:VAR}"`, so no file is written. Only 1.x and openai-chat providers are supported; anything else errors.
- `acp.ts`: dsh → `DEEPSEEK_API_KEY`. Unknown agents get the protocol's key var and base URL, plus a "may not reach it" notice. Antigravity gets `provider.env` only (S6 is still open).
- `memory-scope.ts`: a one-time notice for CLAUDE.md + AGENTS.md. `redact.ts`: `Service.emit` scrubs every event, and turn errors are redacted before `console.error`.
- Settings are now **v3**: a `deepseek` provider with no choice makes dsh `byok:deepseek`. `applySecretsToEnv`/`legacyEnv` are gone. `GATED_DRIVERS` is empty (`providerInjection` is kept for a future file-writing driver).

## Open items

- **Manual checks (running app):** Claude on a BYOK provider, and `dsh` receiving its DeepSeek key (dsh isn't installed on this machine).
- **User request, not yet scheduled:** the model picker should show the provider name and be searchable. Decide whether it goes at the end of phase 2 or in phase 8 (logged in `.ai/plans/phase-2-injection.md`).
- **Gaps recorded:** `CLAUDE_CODE_PROMPT_CACHE_TTL` / gateway model discovery have no Provider field; OpenCode supports openai-chat only (other protocols need their own spike). Live text deltas are redacted too since `ee90edd` (a key split across two deltas can slip past the live view; the stored event is redacted whole).
- The spec's T2.3 text is annotated as superseded; `spec/open-questions.md` has S8 and S10 resolved.

## Environment facts (this machine)

- codex-cli 0.157.0 (the user's login works; for real turns use the cheap `gpt-5.6-luna`), opencode 1.18.32, Node 24.3.0, pnpm 11.24.0.
- **Never** touch `~/.config/opencode/opencode.json` (it powers the delegation workers) or `~/.codex` in tests. Use temp `XDG_*` / `CODEX_HOME`. Run `electron . --smoke --user-data-dir=<tmp>` so real app data is left alone.
- opencode briefs: no key-like strings (a false content-filter retry once caused two concurrent implementers), and "dispatch exactly once".
- Full-suite timeouts under heavy machine load (load average ~20) are load, not regressions; rerun the affected files.

## Phase 3 in progress (paused 2026-09-26, branch `m4` pushed to origin)

Plan and approved decisions: `.ai/plans/phase-3-parity.md`. Spikes S1/S4/S9 and the "untrusted is NOT retired" finding are in `spec/open-questions.md`.

| Step | State | Commit |
|---|---|---|
| A — capabilities + skillsDelivery (T3.1, T3.2) | done | `67bdb46` (+ `8b39214`, cache-only-success fix) |
| B — dropped HTTP MCP notice, reopen notice, pinned Codex policy (T3.3, T3.4, T3.9) | done | `84ed108` |
| C — guardrails on ACP / Codex (Auto-edit → untrusted) / OpenCode plugin (T3.5) | done, 279 tests + build green | `3a909dc` |
| D — `approvals.ts` + `Service.applyModel()` (T3.6, T3.7) | **next** | — |
| E — Library capability chips, PermissionCard by guardEnforcement, no-agent-id-branch test (T3.8) | todo | — |

Found and fixed in step C: real Codex sends approvals as `/bin/zsh -lc '<cmd>'`, and the real `block-dangerous-git.py` let that wrapped form through. `unwrapShell()` in `guard.ts` (mirrored in the OpenCode plugin) fixes it. `test/fixtures/strict-guard.py` mimics the real script's match-from-start behaviour, so this regression stays caught.

Step E must also remove the id-dispatch in `src/main/inject/index.ts` (`agentId === "claude"` etc.), which the no-id-branch test would flag. `.ai/tmp/` still holds the phase 3 briefs; clear it at phase close-out.

## Next

Finish Phase 3 (steps D and E above), then Phase 4 (streaming) or 6. Phase 6 (context survival) is now unblocked on the critical path (0 → 1 → 2 → 6 → 9).
