# Phase 0 — Substrate: event model, usage, DB migrations

**Goal.** Land the types, the usage fields, the schema, and the test fixtures that every later phase reads. Additive only: the only behaviour this phase deliberately changes is the two usage bugs it fixes. No feature flag; nothing here writes outside the app's data folder. Do not reorder this phase — `db.ts`, `shared/types.ts`, the renderer store and all three drivers (`claude.ts`, `codex.ts`, `acp/driver.ts`) read these types, and landing them late means touching all of them twice and re-migrating every persisted row (*spec README → Why phase 0 is first*).

**Deliverables:** `src/shared/types.ts`, `src/main/db.ts`, `src/main/usage.ts` (new), `src/main/agents/{claude,codex}.ts`, `src/main/agents/acp/driver.ts`, `src/main/service.ts`, `test/fixtures/fake-openai.mjs` (new), `test/fixtures/mock-acp-agent.mjs`, `test/fixtures/mock-codex-app-server.mjs`, `test/*.test.ts`, `.github/workflows/ci.yml` (new), `vitest.config.ts`, `tsconfig.node.json` (T0.10).

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/05-streaming-reasoning.md`](../../plan/docs/05-streaming-reasoning.md) — §5.1–5.2 (why deltas and terminal events are separate channels), §5.3 (the per-driver mapping table, including the `SDKThinkingTokensMessage` and `SDKCompactBoundaryMessage` shapes), §5.4 (the exact file-level changes).
- [`plan/docs/04-cache-hit-rate.md`](../../plan/docs/04-cache-hit-rate.md) — §4.1 (the `usage` block field by field, the canonical hit-rate formula, and the `claude.ts:289` double count this phase fixes).
- [`plan/docs/03-context-survival.md`](../../plan/docs/03-context-survival.md) — §3.2 (why `payload` + stable semantic ids + `provenance` are required before anything can be replayed, and the blob-offload strategy).
- [`plan/docs/10-context-economy.md`](../../plan/docs/10-context-economy.md) — §10.8 (the `injection_ledger` schema and the `appendEvent` seq race).
- [`HARNESS.md`](../../plan/docs/HARNESS.md) — the harness contract this app implements: the skill-loading tool, the pre-tool hook exit codes, and the optional browser-tool surface. Relevant because the event vocabulary must carry what those tools produce.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 3 §A2–A4 (the canonical type vocabulary and adapter-boundary design this phase's types follow) and Part 1 §1.1 (T3 Code's teardown, the closest prior art for a normalized event log).

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — none block this phase directly; S5 shapes the fixtures it adds and whether ACP `usage` is `reported` or `unavailable`.

---

### T0.1 — Split the vocabulary into terminal (persisted) and live-only (never persisted)

- **What:** Generalise the `text-delta` rule at `src/shared/types.ts:179` from one kind to a class. Keep `ThreadEvent` as the **terminal, persisted** union; add a sibling `LiveDelta` union for live-only kinds. `appendEvent` accepts only `ThreadEvent`, so "deltas are never stored" becomes a compile-time guarantee rather than a comment.
- **Files:** `src/shared/types.ts` (modify), `src/main/db.ts` (modify — `appendEvent` signature stays `ThreadEvent`), `src/renderer/src/store.ts` (modify — the `liveText` writer typed to `LiveDelta`).
- **Acceptance:** `pnpm typecheck` green. In a new `test/events.test.ts`, a `// @ts-expect-error` on `store.appendEvent(t.id, { kind: "text-delta", itemId: "i", text: "x" })` — if live deltas ever become persistable, `tsc` reports "Unused '@ts-expect-error' directive" and typecheck fails. Runtime: every terminal kind round-trips through `appendEvent` → `listEvents` deep-equal.
- **Notes:** Ch. 5 §5.1–5.2. `text-delta` today is a `LiveUpdate` variant (`types.ts:248`) broadcast by `service.ts:128`; the new `LiveDelta` union replaces that single variant. Types land here, *emission* is Phase 4, so this phase changes no turn behaviour. Split exactly as:

| Canonical kind | Channel | Persisted | Carries |
|---|---|---|---|
| `turn-start` | terminal | yes | `turnId`, `agent`, `model` |
| `assistant-text` | terminal | yes | full text, `payload`, `provenance` |
| `thinking` | terminal | yes | full text **or** `signature`, `opaque` |
| `tool-use` / `tool-result` | terminal | yes | `toolUseId`, `payload`, `provenance` |
| `plan` | terminal | yes | entries |
| `compaction` | terminal | yes | `trigger`, `preTokens`, `postTokens` |
| `turn-end` | terminal | yes | definitive totals incl. cache dims |
| `user` / `error` / `notice` | terminal | yes | as today |
| `text-delta` | live | **no** | `itemId`, `text` |
| `reasoning-delta` | live | **no** | `itemId`, `text`, `opaque` |
| `reasoning-summary` | live | **no** | `itemId`, `index`, `text` |
| `tool-input-delta` | live | **no** | `toolUseId`, `text` |
| `tool-output-delta` | live | **no** | `toolUseId`, `text` |
| `plan-delta` | live | **no** | entries |
| `usage-update` | live | **no** | input/output/cacheRead/cacheWrite/reasoning, cost, contextUsed/Size |
| `thinking-progress` | live | **no** | `estimatedTokens` |

### T0.2 — Add stable semantic ids and `provenance` to stored events

- **What:** Add `messageId`/`turnId`/`itemId`/`parentId` (all optional) to `ThreadEvent`, and `provenance: { agent, model, provider, instanceId }` to `StoredEvent` (nullable). Extend `appendEvent(threadId, event, provenance?)` and have `Service.emit` (`service.ts:91-95`) pass the turn's provenance. `payload` on `tool-use`/`tool-result` carries the full input/result; `summary` stays the UI-only projection.
- **Files:** `src/shared/types.ts`, `src/main/db.ts`, `src/main/service.ts`, `src/main/agents/types.ts` (modify — `TurnInput` gains the provenance the driver knows).
- **Acceptance:** `listEvents` on a row written with provenance returns it; a row written with no provenance returns `provenance: null` and still parses. `tool-use` with a 2 KB `payload` returns that exact payload from `listEvents`.
- **Notes:** Ch. 3 §3.2. Provenance is load-bearing, not bookkeeping: Anthropic drops thinking blocks the receiving model cannot read and prefix-checks each block's `signature`, so the Phase 6 seeder cannot decide what to replay without per-event provenance. Nullable-optional keeps `StoredEvent` rows already on disk valid (*spec README → Conventions*, additive-first types).

### T0.3 — Add the `usage` block to `turn-end` and one canonical hit rate

- **What:** Add `usage?: Usage` to `turn-end` exactly as Ch. 4 §4.1 defines it, create `src/main/usage.ts` exporting the pure `hitRate({ cacheReadTokens, cacheWriteTokens, inputTokens })` = `cacheRead / (cacheRead + cacheWrite + netNew)` and a `normalizeUsage()` that fills `hitRate`/`provenance`. Redefine the top-level `turn-end.inputTokens` to the same uncached number so old readers (`App.tsx:214`) stop double-counting.
- **Files:** `src/shared/types.ts`, `src/main/usage.ts` (new), `test/usage.test.ts` (new), `test/events.test.ts`.
- **Acceptance:** `test/usage.test.ts` asserts `hitRate({ cacheReadTokens: 800, cacheWriteTokens: 100, inputTokens: 100 }) === 0.8`; that `cacheReadTokens: null` yields `hitRate: null` and `provenance: "unavailable"`; that `inputTokens` enters the denominator as `netNew`. A `turn-end` carrying `usage` round-trips through the DB unchanged.
- **Notes:** Ch. 4 §4.1. Vendors disagree on the denominator — OpenAI's `input_tokens` *includes* cached tokens, Anthropic's *excludes* them — so the harness normalises to true processed input. Field contract:

| Field | Type | Meaning |
|---|---|---|
| `inputTokens` | `number` | **uncached (net-new) only** |
| `outputTokens` | `number` | as reported |
| `reasoningTokens` | `number \| null` | `null` when the agent reports none |
| `cacheReadTokens` | `number \| null` | `null` == "not reported by this agent" |
| `cacheWriteTokens` | `number \| null` | `null` == "not reported" |
| `cacheTtl` | `"5m" \| "1h" \| "30m" \| "unknown" \| null` | from vendor config |
| `hitRate` | `number \| null` | the canonical formula |
| `miss` | `boolean` | Phase 5 threshold |
| `missCause?` | enum | Phase 5 classification |
| `provenance` | `"reported" \| "estimated" \| "unavailable"` | never present an estimate as fact |

### T0.4 — Fix the Claude double count and the Codex discarded cached tokens

- **What:** Extract the `result` mapping out of `handleMessage` into an exported pure `turnEndFromResult(message)` in `claude.ts` and use it to replace `claude.ts:285-297`. It must set `inputTokens = message.usage.input_tokens` (drop the `+ cache_read_input_tokens` at `:289`), `usage.cacheReadTokens = cache_read_input_tokens ?? null`, `usage.cacheWriteTokens = cache_creation_input_tokens ?? null`. Do the same for Codex: extend the local `TokenBreakdown` (`codex.ts:33-37`) with `cacheWriteInputTokens?`/`reasoningOutputTokens?`/`netNewInputTokens?`, extract `turnEndFromUsage(usage, durationMs)`, and replace `codex.ts:365-371`, which currently forwards only `inputTokens`/`outputTokens` and drops `cachedInputTokens`.
- **Files:** `src/main/agents/claude.ts`, `src/main/agents/codex.ts`, `test/claude.test.ts`, `test/codex.test.ts`.
- **Acceptance:** `test/claude.test.ts` asserts that for `usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }` the `turn-end` has `inputTokens === 1000` (not 9000), `usage.cacheReadTokens === 8000`, `usage.cacheWriteTokens === 2000`, `usage.hitRate === 8000 / 11000`. `test/codex.test.ts` asserts that a `thread/tokenUsage/updated` with `inputTokens: 9000, cachedInputTokens: 8000` yields `usage.cacheReadTokens === 8000` **and** `inputTokens === 1000` (Codex reports OpenAI-style input that *includes* cached tokens, so net-new is `netNewInputTokens` when the server sends it, else `inputTokens − cachedInputTokens`). `test/acp.test.ts` asserts an ACP `turn-end` whose prompt response has no `usage` reports `usage.provenance === "unavailable"` and `inputTokens === 0` — not `usage_update.used`.
- **Notes:** Ch. 4 §4.1 and Ch. 5 §5.3 note (c). This is the headline defect of the phase: folding reads into `input` makes the hit-rate denominator unknowable, and `cache_creation_input_tokens` was discarded entirely. `test/fixtures/mock-codex-app-server.mjs:132` already sends `cachedInputTokens: 0` / `cacheWriteInputTokens: 0`; make the values scenario-driven so a test can send non-zero ones. **ACP has the same class of bug:** `driver.ts:390` falls back to `turn.usage.used` for `inputTokens`, but `usage_update.used` is *context-window occupancy*, not per-turn input — use the prompt response's `usage` when present and report `unavailable` otherwise (Ch. 4 §4.1's optional estimator stays `provenance: "estimated"`).

### T0.5 — Map the remaining terminal events per driver

- **What:** Terminal events only (live deltas are Phase 4). **Claude:** `SDKPartialAssistantMessage` `message_start` → `turn-start`; the existing `thinking` block (`claude.ts:256-257`) gains an `opaque` flag and a `signature` when one arrived; `SDKCompactBoundaryMessage` (`type:"system"`, `subtype:"compact_boundary"`) → persisted `compaction` with `trigger`/`preTokens`/`postTokens`. **Codex:** `turn/started` (`codex.ts:154-156`) → `turn-start`; `turn/plan/updated` → `plan`; `thread/compacted` (deprecated but still in the v2 schema) and `item/started`/`item/completed` with `item.type === "contextCompaction"` → `compaction`. **ACP:** synthesise `turn-start` on `session/prompt`; a `plan` update → `plan`; `usage_update` (`driver.ts:180-187`) feeds the `turn-end` usage. ACP has no compaction update — do not invent one.
- **Files:** `src/main/agents/claude.ts`, `src/main/agents/codex.ts`, `src/main/agents/acp/driver.ts`, `test/fixtures/mock-codex-app-server.mjs` (modify — add `turn/plan/updated` and a `contextCompaction` item; it emits neither today), `test/codex.test.ts`, `test/acp.test.ts`.
- **Acceptance:** `test/acp.test.ts` asserts the first event of a turn is `{ kind: "turn-start" }`; `test/codex.test.ts` asserts a `plan` event whose entries match the fixture's `turn/plan/updated`, and a `compaction` event from the fixture's `contextCompaction` item. `pnpm typecheck` green.
- **Notes:** Ch. 5 §5.3 mapping table (verified against the v2 schema and the ACP v1 prompt-turn page, not from memory). Codex `item/fileChange/outputDelta` is deprecated — "the server no longer emits this notification" — never build on it. `thread/compacted`'s replacement path is `item/*` with `ThreadItem.type === "contextCompaction"`; handle both. `compaction` is persisted because compaction is exactly where the Anthropic prefix, and therefore the cache, restarts.

### T0.6 — Migrate the event log: new columns, `blobs`, `injection_ledger`

- **What:** Append additive steps to `steps[]` (`db.ts:49`): nullable `provenance`, `message_id`, `turn_id`, `item_id`, `parent_id`, `payload_ref`, `payload_bytes` on `events`. **Not** a `payload` column — `events.payload` already exists and holds the whole event JSON (`db.ts:36-42`), so `ALTER TABLE events ADD COLUMN payload` fails with *duplicate column name*; T0.2's tool `payload` lives inside that JSON, and only offloaded payloads move to `blobs` (the JSON then carries `{ blobRef, bytes, truncated: true, preview }`). Create `blobs(sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)` for content-addressed large tool I/O, with files at `blobs/<sha256>` beside the database. Create `injection_ledger` with `state ∈ 'intent' | 'injected' | 'failed'`. **Fix the migration runner**: `migrate()` (`db.ts:48-62`) hard-codes a single guard — `PRAGMA table_info(threads)`, applied to step 0 only — so once a new column is also added to the `CREATE TABLE IF NOT EXISTS` block (as the convention requires), its `ALTER` step throws *duplicate column name* on a fresh database. Generalise it: each step carries its own `applied(db)` check (column exists / table exists).
- **Files:** `src/main/db.ts`, `test/db.test.ts`.
- **Acceptance:** `test/db.test.ts` gains a case that builds a pre-Phase-0 database with the old `events(thread_id, seq, payload, created_at)` shape, inserts a row, opens it with the new `Store`, and asserts (a) `listEvents` returns that row with `provenance: null`, (b) opening it a second time is idempotent, (c) `blobs` and `injection_ledger` exist. A second case writes a 100 KB `tool-result` payload and asserts `payload_ref` is its sha256, that the payload is not inlined, and that writing the same payload twice yields one `blobs` row.
- **Notes:** Ch. 3 §3.2 (payload/blob columns, 64 KB inline threshold, `blobs/<sha256>`) and Ch. 10 §10.8. New tables go in the `CREATE TABLE IF NOT EXISTS` block *and* get a guarded step (*spec README → Conventions → Persistence*). `injection_ledger` schema, consumed by Phase 6, created here:

```
injection_ledger(
  thread_id, target_provider, target_session_id,
  checkpoint_id,            -- one handoff
  item_fingerprint,         -- sha256 of the canonical item + protocol id
  state,                    -- 'intent' | 'injected' | 'failed'
  injected_at
)  -- PRIMARY KEY (thread_id, target_provider, target_session_id, checkpoint_id, item_fingerprint)
```

### T0.7 — Make `appendEvent`'s seq allocation a single statement

- **What:** Replace the two-statement `SELECT COALESCE(MAX(seq),0)` + `INSERT` at `db.ts:137-146` with a single `INSERT INTO events (...) SELECT ?, COALESCE(MAX(seq),0)+1, ... FROM events WHERE thread_id = ? RETURNING seq`, and set `PRAGMA busy_timeout` in the constructor. This is **hardening**, not a live bug: `node:sqlite` is synchronous and the app has one main-process connection, so two calls never interleave today, and `MAX(seq)` over `PRIMARY KEY (thread_id, seq)` is an index seek, not an O(n) scan. It matters only if a second connection (a worker, a CLI, a second process) ever writes.
- **Files:** `src/main/db.ts`, `test/db.test.ts`.
- **Acceptance:** `test/db.test.ts` runs two `worker_threads`, each opening its own `Store` on the same file and appending 500 events to the same thread, and asserts the union of seqs is exactly `1..1000` with no duplicates and no throw. (Two `Store`s driven from one thread cannot show the race — each synchronous call finishes before the next starts — so that test would pass against the old code too.) A second case appends 10,000 events and asserts `seq` is contiguous `1..10000`.
- **Notes:** Ch. 10 §10.8. Deltas are never persisted (T0.1, Phase 4), so streaming does **not** raise the write rate; this task has no ordering dependency on Phase 4. WAL is already on (`db.ts:17`).

### T0.8 — Extract `fake-openai.mjs`; extend the ACP and Codex fixtures

- **What:** Move the inline `fakeModel()` server from `test/codex-e2e.test.ts:23-64` into `test/fixtures/fake-openai.mjs`, exporting `startFakeOpenAI()` → `{ server, url, offered, namespaces, requests }`, and add the branches the inline version lacks: **401** when the request carries no `Authorization` (and the fixture is started with `requireAuth: true`), **400** on a malformed JSON body, **404** on any path that is not `/responses`. Keep the tool-call probe (`offered`/`namespaces`) and the plan-limit headers. Extend `test/fixtures/mock-acp-agent.mjs` — it already emits one `agent_thought_chunk` at `:78`, a terminal `tool_call_update` with `content` at `:92-97`, and a `usage_update` at `:111` — with (a) a `"reason"` scenario emitting **three** thought chunks separated by a tick, and (b) an intermediate `tool_call_update` with `status: "in_progress"` and `content` **before** the terminal one.
- **Files:** `test/fixtures/fake-openai.mjs` (new), `test/fixtures/mock-acp-agent.mjs`, `test/codex-e2e.test.ts`, `test/fake-openai.test.ts` (new).
- **Acceptance:** `test/codex-e2e.test.ts` contains no `createServer` call and imports the fixture; `pnpm test` still passes with `UNSKILLED_CODEX_BIN` unset (e2e skips). `test/fake-openai.test.ts` fetches the fixture directly and asserts `401`, `400`, `404`, and that a first request returns a `function_call` for `browser_eval` while a request whose input contains `function_call_output` returns the `message`.
- **Notes:** *spec README → Conventions → Tests* requires reusing/extracting the inline fakes rather than writing new ones. `test/claude-e2e.test.ts:19-58` holds a sibling inline `fakeAnthropic()`; Phase 4 extracts it when it needs streaming deltas, so do not duplicate that work here. Read a fixture before asserting it lacks something — `mock-acp-agent.mjs` already covers the single-thought-chunk and terminal-tool-output cases.

### T0.9 — Add CI, gating real-binary e2e on binary presence

- **What:** The repo has **no CI configuration at all** (no `.github/` directory — verified), although the root `README.md:143` describes a three-OS CI with a Codex e2e on Linux. Add `.github/workflows/ci.yml` with two jobs, matching Ch. 6 §6.5 and that README paragraph:
  1. **`test`** — matrix `ubuntu-latest`, `macos-latest`, `windows-latest`: `pnpm install --frozen-lockfile`, then `pnpm typecheck`, `pnpm test`, `pnpm build`, on Node 22 (`node:sqlite` needs ≥ 22.5; this machine runs v22.22.2) and the pnpm version pinned in `packageManager`. No `codex` install, so `describe.skipIf(!codex)` (`test/codex-e2e.test.ts:66`) skips; the ungated `test/claude-e2e.test.ts` runs everywhere against its fake API.
  2. **`codex-e2e`** — `ubuntu-latest` only, a separate job (not a matrix entry): install `codex`, export `UNSKILLED_CODEX_BIN`, run `pnpm test -- codex-e2e`.
  The *tests* stay gated on binary presence; only the workflow decides where the binary exists. Never add `if: runner.os ==` to a step or to a test.
- **Files:** `.github/workflows/ci.yml` (new), `package.json` (modify — add a `packageManager` field pinning pnpm, so CI and local agree).
- **Acceptance:** `ls .github/workflows/ci.yml` succeeds. Running the `test` job's commands locally in order exits 0. The workflow contains no `continue-on-error` and no `runner.os` condition; `codex` is installed only in the `codex-e2e` job. `pnpm test` without the binary shows the Codex e2e suite **skipped**, not failed.
- **Notes:** *spec README → Conventions → Tests* ("real-binary e2e is gated on binary presence (`UNSKILLED_CODEX_BIN`), not on platform"). Cross-phase invariant 8 makes a red `pnpm test` a phase blocker, so CI is the enforcement point for every later phase. `.npmrc` sets `node-linker=hoisted`; CI must use pnpm, not npm, or the flat layout the electron-builder packaging depends on is lost. The packaged-app smoke test (`pnpm smoke`) and the release workflow the README also mentions are out of scope here; Phase 9 T9.10/T9.11 extend CI.

### T0.10 — Make component tests possible (JSX in tests)

- **What:** Phases 1, 3, 6 and 7 specify component tests via `react-dom/server`'s `renderToStaticMarkup`, but today no test can import a `.tsx` file: `vitest.config.ts` collects only `test/**/*.test.ts`, and `tsconfig.node.json` (which typechecks `test/**/*`) has no `jsx` setting and no DOM lib. Extend the Vitest include to `test/**/*.test.{ts,tsx}`, and typecheck `.tsx` tests under a config that has `"jsx": "react-jsx"` and the DOM lib (a small `tsconfig.test.json` referenced from `pnpm typecheck`, or those options added to `tsconfig.node.json`). Keep `environment: "node"`; `renderToStaticMarkup` needs no DOM.
- **Files:** `vitest.config.ts` (modify), `tsconfig.node.json` or `tsconfig.test.json` (new), `package.json` (modify — the `typecheck` script, only if a new tsconfig is added), `test/render-smoke.test.tsx` (new).
- **Acceptance:** `test/render-smoke.test.tsx` renders `Markdown` from `src/renderer/src/markdown.tsx` (it imports only React and `fileref.ts` — no store, no `window`) with `renderToStaticMarkup` and asserts a known substring; `pnpm typecheck` and `pnpm test` are green; `pnpm test` output lists the `.tsx` file.
- **Notes:** Without this, every later "component test" acceptance is unfalsifiable. Pointer/keyboard behaviour still needs pure reducers (Phase 7) unless a DOM environment is added — adding jsdom/happy-dom is a separate, noted decision (Phase 7 risks). Components that read the zustand store at render time may need the store seeded in the test; prefer testing pure selectors plus leaf components.

---

## Risks & rollback

- **`ThreadEvent` widening breaks every emitter.** Mitigation: every new field is optional and every new kind is additive; `pnpm typecheck` is the gate. Rollback: revert the `types.ts` commit — nothing persisted depends on it until T0.6.
- **Migration runner generalisation touches existing databases.** Mitigation: T0.6's acceptance test opens a pre-Phase-0 DB twice. Rollback: the new steps are nullable-column adds and `CREATE TABLE IF NOT EXISTS`; dropping them loses no user data. Do **not** automate a `schema_version` decrement.
- **Changing top-level `turn-end.inputTokens` semantics changes `UsageMeter`.** Mitigation: the change is a fix (reads are no longer counted as new input); Phase 5's `CacheMeter` is the correct place to show cached volume. No flag, because the old number was wrong.
- **Blob files are new on-disk state.** Mitigation: content-addressed and deduplicated, so a failed write is retryable and orphan-safe; deletion is Phase 6 retention policy, never here.
- **CI is a new failure surface for every later phase.** Mitigation: the workflow runs only commands that already pass locally, and the e2e suite skips without a binary. The Windows/macOS matrix may surface platform bugs the local machine never saw (paths, `node-pty`); fix or quarantine them in this phase rather than dropping an OS.

## Exit criteria

- [ ] `pnpm typecheck` green; `pnpm test` green with the Codex e2e suite skipped, not failed.
- [ ] `// @ts-expect-error` proves a live delta cannot reach `appendEvent`.
- [ ] `hitRate` unit test asserts `cacheRead / (cacheRead + cacheWrite + netNew)`, and `null` propagation for ACP.
- [ ] Claude `turn-end` no longer adds `cache_read_input_tokens` into `inputTokens`; `cache_creation_input_tokens` is reported as `cacheWriteTokens`.
- [ ] Codex `turn-end` reports `cachedInputTokens` as `cacheReadTokens` and net-new `inputTokens`; ACP no longer reports `usage_update.used` as input.
- [ ] A pre-Phase-0 `events` row still parses after the new columns exist, and the migration is idempotent.
- [ ] `blobs` and `injection_ledger` exist; a large payload is offloaded and deduplicated.
- [ ] Two worker-thread `Store`s appending concurrently produce contiguous, unique seqs.
- [ ] Every driver emits `turn-start` before its first content event.
- [ ] `.github/workflows/ci.yml` exists, runs typecheck + test + build on all three OSes, and runs the Codex e2e in a Linux-only job.
- [ ] A `.tsx` test using `renderToStaticMarkup` runs and typechecks (T0.10).
