# Milestone 4 — Implementation Spec

The engineering plan in [`../plan/docs/M4-centralized-harness-plan.md`](../plan/docs/M4-centralized-harness-plan.md) (10 chapters) turned into **executable phases**. The plan explains *why*; this folder is the *what to build, in what order, with what acceptance criteria*.

**Status:** not started. Every phase below is unstarted unless its checkbox says otherwise.

**Reviewed 2026-09-25** — see [`REVIEW-2026-09-25.md`](REVIEW-2026-09-25.md) for what was corrected and why.

---

## How to use this spec

1. Read this file, then the phase you're picking up. Each phase opens with a **Research references** block pointing at the plan chapters it implements — read those before the tasks, not after.
2. Each phase is **independently shippable** — it must leave `pnpm typecheck`, `pnpm test` and `pnpm build` green, and the app usable.
3. Work phases in order unless the dependency column says a phase has no blockers. Phase 0 first, always.
4. A phase is done when **every task's acceptance criterion passes** and the exit criteria at the end of the file are met. Not when the code compiles.
5. Anything marked `[U]` in `open-questions.md` must be spiked *before* the phase that depends on it — never assumed.

---

## Phase map

| # | Phase | Plan chapters | Depends on | Independently shippable | Risk |
|---|---|---|---|---|---|
| **0** | [Substrate: event model, usage, DB migrations](phases/phase-0-substrate.md) | Ch. 5, Ch. 4 §4.1, Ch. 3 §3.2, Ch. 10 §10.8 | — | yes (additive only) | low |
| **1** | [Provider registry (BYOK)](phases/phase-1-provider-registry.md) | Ch. 1, Ch. 7 §7.2 | 0 | yes | med |
| **2** | [Credential injection per driver](phases/phase-2-injection.md) | Ch. 1 §1.3, Ch. 10 §10.2 | 1 | yes (per-driver flag) | **high** (writes user files) |
| **3** | [Capability parity + defect fixes](phases/phase-3-parity.md) | Ch. 2 | 0 | yes | med |
| **4** | [Streaming + reasoning display](phases/phase-4-streaming.md) | Ch. 5, Ch. 7 §7.4 | 0 | yes | low |
| **5** | [Cache discipline + observability](phases/phase-5-cache.md) | Ch. 4, Ch. 7 §7.3 | 0, 4 | yes | low |
| **6** | [Context survival: bindings, handoff, injection ledger](phases/phase-6-context-survival.md) | Ch. 3, Ch. 10 | 0, 1, 2 | yes (gated by confirm card) | **high** (one-way migration) |
| **7** | [Interaction mechanics: splitters, collapse, browser, take-over](phases/phase-7-interaction.md) | Ch. 8 | 0 | yes | med |
| **8** | [UI refinement toward T3 Code / WorkBuddy](phases/phase-8-ui-refinement.md) | Ch. 9 | 7 (for the shell parts) | yes (3 sub-passes) | low |
| **9** | [Antigravity opt-in + release hardening](phases/phase-9-release.md) | Ch. 2 §2.3, Ch. 6 §6.4–6.7 | 1, 2, 3, 5, 6 (8 for T9.8/T9.10) | yes | med (legal) |

```
0 substrate
├── 1 registry ── 2 injection ── 6 context survival ──┐
├── 3 parity                                          │
├── 4 streaming ── 5 cache ───────────────────────────┼── 9 release
└── 7 interaction ── 8 ui refinement ─────────────────┘
```

**Critical path:** 0 → 1 → 2 → 6 → 9. Phases 3, 4→5 and 7→8 can run in parallel with it; phase 9 is last because it hardens what 5, 6 and 8 ship (the cache rollback helper, the bindings migration, the Settings IA and the render-parity snapshot).

---

## Why phase 0 is first (do not reorder)

The event vocabulary and the usage fields are the types that `db.ts`, `shared/types.ts`, the renderer store, and all four drivers read. Landing them late means touching all of those twice, and re-migrating every persisted event row. Concretely, `src/main/agents/claude.ts:289` currently adds `cache_read_input_tokens` **into** `inputTokens` and drops `cache_creation_input_tokens` — every later phase that reports cost inherits that bug if it isn't fixed in phase 0.

---

## Cross-phase invariants

These hold in every phase. Violating one is a bug regardless of what the phase asked for.

1. **Never re-execute a side-effecting tool during handoff.** Carry the recorded result with provenance. Replay is reporting only.
2. **Never inject what the target already loads itself.** No project conventions (`CLAUDE.md`/`AGENTS.md` content), no skill bodies, no reasoning the target cannot read.
3. **Never write a user-owned config file without a timestamped backup and a tested restore.** Applies to `~/.codex/config.toml` above all.
4. **Never change the model, the tool set, or reasoning effort mid-thread** without classifying the cache invalidation it causes and telling the user.
5. **Never poll for anything.** All observability (usage, cache hit rate, rate limits) comes in-band from data the agents already send.
6. **Never delete provenance.** Pruning replaces payloads with previews + blob references; it does not erase who produced what.
7. **Never hide a capability gap.** Disable the control and say why, or state the loss explicitly.
8. **Never ship a phase with a red `pnpm typecheck` / `pnpm test`.**

**Repo facts that override the plan where they differ.** (1) **OpenCode is an ACP agent here** (`src/main/agents/registry.ts:34-40`, `opencode acp`), so the OpenCode HTTP SDK's `session.prompt({noReply:true})` is *not* a reachable seeding channel — phase 6 gates it behind a capability flag and uses the ACP path. (2) **There is no CI configuration in the repo** despite what the root `README.md:143` says; phase 0 creates it. (3) **The Claude driver runs one `query()` per turn with a string prompt** (`claude.ts:194-222`), not streaming input mode, so `Query.setModel()` and the other `Query` control methods ("only available in streaming input mode", `sdk.d.ts:2750-2755`) are unreachable without a driver refactor. (4) **Three driver implementations, four target agents.** `claude.ts`, `codex.ts` and `acp/driver.ts` are the only adapters; OpenCode, Antigravity, DeepSeek and Cursor all run through the ACP one. "Four-driver" parity tests therefore mean three adapters fed per-agent fixtures. (5) **Omitting `settingSources` loads every settings source, including CLAUDE.md** (`sdk.d.ts:2176-2185`); `[]` is isolation mode and disables CLAUDE.md. Never pass `[]`.

---

## Conventions

**Language & types.** TypeScript, ESM, no new runtime dependencies without a note in the phase file. Types that cross the main↔renderer boundary live in `src/shared/types.ts` and are additive-first: new optional fields before removals, and any removed field stays as a read-only projection for one release.

**Persistence.** SQLite via `node:sqlite`. All schema changes are **additive** and go into the `steps[]` array in `db.ts:49` as a new entry — never edit an existing step. New tables are created in the `CREATE TABLE IF NOT EXISTS` block *and* guarded for existing databases.

**Feature flags.** Per-provider and per-feature flags live in `Settings` (`src/main/settings.ts`) with a safe default of *off* for anything that writes outside the app's data folder.

**Tests.** Vitest, `test/*.test.ts`, fixtures in `test/fixtures/`. Component tests (`renderToStaticMarkup`) need the JSX test setup phase 0 adds (T0.10): today `vitest.config.ts` collects only `*.test.ts` and `tsconfig.node.json` has no `jsx`, so no test can import a `.tsx` component yet. Anything touching an agent protocol needs a fake: reuse `test/fixtures/mock-acp-agent.mjs`, and extract the inline fakes in `claude-e2e.test.ts` / `codex-e2e.test.ts` rather than writing new ones. Unit tests run everywhere; real-binary e2e is gated on binary presence (`UNSKILLED_CODEX_BIN`), not on platform.

**Citations.** In phase files, `README.md:<n>` means the **repo-root** `README.md`; this file is cited by section (e.g. *spec README → Conventions*), not by line, because its line numbers move. Plan chapters are cited as `Ch. n §n.m` and live in `plan/docs/`; the chapter files `01-…10-*.md` are generated from `M4-centralized-harness-plan.md` — edit the combined plan, then run `python3 plan/docs/_split_chapters.py` (`--check` reports drift), so the two never diverge.

**Commits.** One task per commit where practical. Phase exit criteria in the PR description, copied from the phase file's checklist.

---

## Task format

Every task in every phase file uses this shape, so progress is checkable without reading code:

```markdown
### T<n>.<m> — <imperative title>
- **What:** one or two sentences.
- **Files:** `path` (new|modify) …
- **Acceptance:** a *falsifiable* check — a command, an assertion, or an observable behaviour.
- **Notes:** gotchas, citations, links to the plan chapter.
```

A task with an unfalsifiable acceptance criterion ("works correctly") is not done being written.

### Required sections

Every phase file carries, in this order:

1. **Preamble** — plan chapters, dependencies, risk, and what is out of scope.
2. **`## Research references`** — the exact plan chapter files and sections this phase implements, plus `HARNESS.md` and `research-ai-agent-harnesses.md` where they are load-bearing, and the `open-questions.md` spikes that gate it. Links are relative from `spec/phases/`. An implementer should be able to open this phase, follow one link, and have the full reasoning behind every task.
3. **Tasks** in `T<phase>.<n>` form.
4. **`## Risks & rollback`** and an **`## Exit criteria`** checklist.


---

## Status board

- [x] Phase 0 — Substrate (2026-09-25; CI workflow not yet run on GitHub)
- [x] Phase 1 — Provider registry (2026-09-26; T1.8 driver wiring moved to Phase 2; manual `dsh` key check pending)
- [x] Phase 2 — Credential injection (2026-09-26; T2.3 redesigned per S10 — no writes to `$CODEX_HOME`; OpenCode env-only per S8; manual in-app Claude BYOK + `dsh` checks pending)
- [x] Phase 3 — Capability parity (2026-09-26; T3.3 inverted per spike — Ask/Auto-edit stay on `untrusted`; renderer `ProviderSheet.tsx` id branches deferred to phase 8)
- [x] Phase 4 — Streaming + reasoning (2026-09-26; broadcast reuses `LiveUpdate { type: "delta" }`; item ids stamped on terminal events; no fake-anthropic extraction — Claude mapping tested via the exported handler)
- [x] Phase 5 — Cache discipline (2026-09-26; browser tools pinned from turn 1; compaction knobs built but not wired by default; eager `sessionId: null` on agent switch left to Phase 6 bindings; cache-write spend shown in tokens, no price table)
- [x] Phase 6 — Context survival (2026-09-26; bindings backfilled from `session_id`; handoff = Codex `thread/inject_items` or one synthetic first message, through the ledger; git ref only for Hand off; stale-cursor re-seed and the model-switch card variant carried forward)
- [x] Phase 7 — Interaction mechanics (2026-09-27; APG splitters with geometry as a setting, terminal drawer, `<details>` tool rows, browser device emulation + screenshots + move-to-main, take-over lock, one tool/diff/Markdown contract with four-driver render parity; OpenCode's late `rawInput` unverified)
- [x] Phase 8 — UI refinement (2026-09-27; Passes 1–2 and density shipped; T8.13 worktrees deferred behind Phase 9 T9.7; T8.15 covered by T7.12; pins session-local)
- [ ] Phase 9 — Release hardening

---

## Traceability

| Plan chapter | Phase |
|---|---|
| Ch. 1 BYOK registry | 1, 2 |
| Ch. 2 Capability parity | 3, 9 |
| Ch. 3 Context survival | 0 (event log), 6 |
| Ch. 4 Cache hit rate | 0 (usage fields), 5 |
| Ch. 5 Streaming + reasoning | 0 (vocabulary), 4 |
| Ch. 6 Roadmap | this file's phase map |
| Ch. 7 UI/UX surface | 1 (settings), 4 (reasoning), 5 (meter), 6 (switch card), 8 |
| Ch. 8 Interaction mechanics | 7 |
| Ch. 9 UI refinement | 8 |
| Ch. 10 Context economy | 0 (ledger), 2 (memory scope), 6 |

Open items and unverified claims: [`open-questions.md`](open-questions.md).
