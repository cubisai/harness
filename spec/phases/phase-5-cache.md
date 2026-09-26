# Phase 5 — Cache discipline + observability

**Goal.** Measure before optimizing, then make the prompt prefix boring. Phase 0 made the cache visible (the `usage` block); this phase enforces the prefix-stability rules that keep it warm and shows the result without a single extra request. Depends on Phase 0 (usage fields) and Phase 4 (`usage-update` live channel).

**Deliverables:** `src/main/cache-policy.ts` (new), `src/main/usage.ts`, `src/main/agents/{codex,acp/driver}.ts`, `src/main/browser/{controller,tools}.ts`, `src/main/index.ts`, `src/main/service.ts`, `src/renderer/src/components/CacheMeter.tsx` (new), `src/renderer/src/App.tsx`, `test/cache-policy.test.ts` (new), `test/{codex,acp}.test.ts`, `test/codex-e2e.test.ts`.

**The enforceable checklist this phase implements (Ch. 4 §4.2, verbatim requirements):**

| # | Rule | Where it lands |
|---|---|---|
| 1 | Static/dynamic system-prompt split (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`); never `snapshot: false` in production | driver options (Phase 3/6 own the split; assert it here) |
| 2 | Tools frozen and sorted; MCP servers sorted by name; stable `tool_use` JSON key order | `cache-policy.ts` (T5.1) |
| 3 | Fix the browser-tool timing — pin the full tool set at `thread/start` / `session/new` | `index.ts`, browser tools (T5.3) |
| 4 | Skills stay out of the prefix — injected as a tool, so skill text lands in messages | already true via `skillCallPrefix`; assert it |
| 5 | History is append-only; volatile state goes in the trailing user message | `service.ts` (T5.1) |
| 6 | No mid-thread config changes (model, reasoning effort, verbosity, format, `parallel_tool_calls`) | T5.2, T5.5 |
| 7 | Place breakpoints deliberately (Anthropic allows 4; lookback is 20 blocks) | T5.1 |
| 8 | One turn per thread at a time; sub-agents get separate sessions | already true (`service.ts:98`) |

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/04-cache-hit-rate.md`](../../plan/docs/04-cache-hit-rate.md) — the whole chapter: §4.2 the prefix-stability checklist, §4.3 the mid-session rebuilds this phase deletes, §4.4 the TTL/invalidation matrix, §4.5 compaction policy, §4.6 in-band observability.
- [`plan/docs/10-context-economy.md`](../../plan/docs/10-context-economy.md) — §10.1 the per-mechanism cost table (why resume beats re-seed) and §10.3 the vendor pruning primitives to prefer over heuristics.
- [`plan/docs/07-ui-ux.md`](../../plan/docs/07-ui-ux.md) — §7.3 the cache meter and the miss badge.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 2 §2.1 compatibility caveats (protocol walls, reasoning state, tokenizer differences) — the constraints behind the per-vendor rows.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S7 (DeepSeek invalidation).

---

### T5.1 — `cache-policy.ts`: freeze, sort, and pin the tool set per thread

- **What:** New `src/main/cache-policy.ts` exporting `pinToolSet(threadId, tools)` → a frozen, name-sorted, stably-serialised tool set; `pinnedFingerprint(threadId)` → its hash; `queueConfigChange(threadId, change)`; and `drainConfigChanges(threadId)` → the changes to apply at a turn boundary. Freeze the set at `thread/start` / `session/new` (`service.ts:63-70` is where a thread is created) and sort MCP servers by name and tools deterministically.
- **Files:** `src/main/cache-policy.ts` (new), `src/main/service.ts`, `test/cache-policy.test.ts` (new).
- **Acceptance:** `test/cache-policy.test.ts` asserts the fingerprint of a given tool set is identical across three consecutive "turns", stays identical after `queueConfigChange`, and **differs only after** `drainConfigChanges` returns the queued change. Also asserts the fingerprint is invariant under input order (same tools, shuffled array → same hash) and that `tool_use` argument JSON is serialised with sorted keys.
- **Notes:** Ch. 4 §4.2(2), (5)–(8). Anthropic: modifying tool definitions invalidates the **entire** cache; OpenAI: tool **ordering** matters; DeepSeek requires a byte-identical prefix unit (`A+B` cached then `A+C` misses). This is the same module that owns the miss threshold and compaction policy, so it is the single place to read what the harness does to its prefix. Breakpoint placement (rule 7) is part of the pin: Anthropic allows 4 breakpoints (automatic caching consumes one; 4 explicit + automatic returns 400) and a read looks back at most 20 block positions, so a long thread needs a second breakpoint placed early — where the harness builds the request, emit that placement from one place rather than ad hoc at each call site. Rule 1's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` split and rule 4's skills-as-a-tool are already the drivers' shape; this task adds a fingerprint assertion that neither has drifted, and rule 5 is enforced by never rewriting a stored event (Phase 0 already makes the log append-only). Scope honestly: the harness does not build the Anthropic/OpenAI request itself — the Claude Code binary, Codex and ACP agents do — so `pinToolSet` controls only what the harness hands them (harness tools, MCP server list and order, config) and the fingerprint is of that input, not of the wire request. Breakpoint placement (rule 7) is therefore only enforceable where the harness owns a request (Phase 1's test-connection probes); for the agents, record it as their responsibility rather than asserting it.

### T5.2 — Batch MCP-config reloads and classify their cost

- **What:** The reloads at `codex.ts:314-318` (`thread/unsubscribe` + `thread/resume`) and `acp/driver.ts:265-266` (`session/close` + `session/resume`), triggered by an MCP signature change (`driver.ts:260`), **already run at the start of `runTurn`** — a turn boundary, not mid-turn — so "queue to a turn boundary" saves nothing on its own. What this task changes: (1) after T5.3 the browser tools no longer change the signature, so the only remaining trigger is a real user edit to their MCP servers; (2) route that edit through `queueConfigChange`/`drainConfigChanges` so several edits between two turns cost **one** reload, not one per edit; (3) tag the resulting turn's usage with `missCause: "session-rebuild"` as an **expected** rebuild (T5.4), and keep Phase 3 T3.9's `notice`. Do **not** remove the reload itself — without it a user's MCP edit never reaches the agent. Stop nulling the session on an agent switch at `service.ts:78`; retaining the previous provider's warm binding is Phase 6's job, so here only stop the eager `sessionId: null` — and keep today's "starts without the earlier messages" notice truthful (`service.ts:114-116` keys it on `sessionId === null`).
- **Files:** `src/main/agents/codex.ts`, `src/main/agents/acp/driver.ts`, `src/main/service.ts`, `test/codex.test.ts`, `test/acp.test.ts`.
- **Acceptance:** `test/codex.test.ts`'s `"reattaches a loaded thread once the tools appear"` (`:163`) and `test/acp.test.ts`'s `"attaches the harness's tool server when tools exist, even mid-conversation"` (`:116`) are **rewritten**: with T5.3 in place, tools present from turn 1 mean no reload ever happens (assert zero `thread/unsubscribe`/`session/close`). `"passes the user's MCP servers, and reopens the session when they change"` (`:131`) is extended: two server edits between turns produce exactly **one** `session/close` + `session/resume`, one `notice`, and a `turn-end` whose `usage.missCause === "session-rebuild"` flagged as expected.
- **Notes:** Ch. 4 §4.3 (with its review note). Every reload rewrites the whole prefix at write prices instead of read prices; the *avoidable* ones are the browser-triggered reloads T5.3 removes. Do not silently drop a user's change: a `notice` event is the contract (invariant 7). A passing *old* `:116`/`:163` test after this task is a failure signal, because they assert the mid-conversation tool attach being deleted.

### T5.3 — Fix the browser-tool timing: pin the seven tools at creation

- **What:** `README.md:93` advertises that the seven `browser_*` tools "aren't sent at all" until the Browser tab is opened, and `index.ts:178` implements exactly that (`enabledTools = () => (browser.enabled ? tools : [])`) — a deliberate mid-conversation tool injection. Change it to always pass `browserTools(browser)` (`browser/tools.ts:22`) and gate **behaviour** at runtime: when `browser.enabled` is false (`controller.ts:29`), each tool returns a `"Browser pane not open"` error through the existing `safely()` wrapper (`tools.ts:5-11`) instead of throwing an unrelated Electron error. Make it one-way: once sent, never un-mount the set.
- **Files:** `src/main/index.ts`, `src/main/browser/controller.ts`, `src/main/browser/tools.ts`, `test/browser.test.ts`, `test/codex-e2e.test.ts`, `README.md` (`:93`), `plan/docs/HARNESS.md` (item 7).
- **Acceptance:** `test/browser.test.ts` asserts every one of the seven tools returns `{ isError: true, text: "Browser pane not open" }` when `enabled` is false. `test/codex-e2e.test.ts`'s `"adds the browser tools mid-thread…"` is updated so the first turn already offers `browser_eval` (the model probe's `offered` is non-empty on turn 1), proving no mid-conversation injection occurs.
- **Notes:** Ch. 4 §4.2(3). This is "the single most expensive thing you can do to a prefix": a tool-definition change invalidates the entire Anthropic cache. Cost of the fix: a permanently larger prefix. Benefit: no invalidation and, critically, no session rebuild. If the product insists on zero-context-when-unused, the fallback is to make it one-way and classify the resulting rebuild as an **expected rebuild** in telemetry — never as a true miss. This deliberately departs from `plan/docs/HARNESS.md` item 7 ("attach them only once the user has opened the browser") and from root `README.md:93`; update both in the same change (Phase 9 T9.9 checks HARNESS.md).

### T5.4 — Define the miss threshold and classify the cause

- **What:** Add `isMiss(prevPrefix, cacheWrite)` to `cache-policy.ts`, adopting Claude Code's definition verbatim: a miss is `cacheWrite >= 2000 && cacheWrite > 0.05 * prevPrefix`. Add `classifyMiss({ toolFingerprintChanged, systemPromptChanged, modelChanged, compacted, ttlExpired, sessionRebuilt })` → `"tool-definitions" | "system-prompt" | "model" | "compaction" | "ttl-expiry" | "session-rebuild" | "unknown"`, and separate **expected rebuilds** (compaction, tool-result clearing) from true misses so alerting is not noise. Wire the result into the Phase 0 `usage.miss` / `usage.missCause` fields.
- **Files:** `src/main/cache-policy.ts`, `src/main/usage.ts`, `src/main/agents/claude.ts`, `test/cache-policy.test.ts`.
- **Acceptance:** `test/cache-policy.test.ts` asserts the threshold boundaries: `(prevPrefix 100_000, cacheWrite 4_999)` → not a miss; `(100_000, 5_001)` → miss; `(10_000, 1_999)` → not a miss even though it is 19.99%; `(10_000, 2_001)` → miss. Asserts a `compaction`-caused rebuild returns `missCause: "compaction"` and is flagged as expected, not as a true miss.
- **Notes:** Ch. 4 §4.1 ("re-processed more than 5% and at least 2,000 tokens of what it could have read from cache"). Claude Code applies it per **request**; the harness only sees per-**turn** totals (Claude's `result.usage` sums every request in an agentic turn), so a multi-request turn can hide or blend a miss. Label the badge "this turn" and never compare it to Claude Code's own per-request figure. `prevPrefix` is the previous turn's total processed input, i.e. `cacheRead + cacheWrite + netNew` from the previous `turn-end` — available in-band, no extra request. Both conditions must hold; the 5% test alone would flag a tiny thread, and the 2,000-token test alone would flag a huge one that is still 99% cached. The clearest **expected rebuild** is Anthropic's server-side tool-result clearing (`clear_tool_uses_20250919`): it removes the oldest tool interactions and replaces each cleared result with placeholder text, reporting `cleared_tool_uses` / `cleared_input_tokens` in `context_management.applied_edits` on `message_delta` (Ch. 10 §10.3). Classify it as an expected rebuild, not a true miss — and note that clearing invalidates the cached prefix **at the clear point**, which is why `clear_at_least` exists and why the static-system-prompt breakpoint must sit ahead of it.

`classifyMiss` maps the first true signal; expected rebuilds never raise the miss badge:

| Signal | `missCause` | Expected rebuild? |
|---|---|---|
| `toolFingerprintChanged` | `tool-definitions` | no — always a defect |
| `systemPromptChanged` | `system-prompt` | no |
| `modelChanged` | `model` | no — caches are per-model |
| `compacted` / tool results cleared | `compaction` | **yes** |
| idle past `cacheTtl` | `ttl-expiry` | yes, if the pause was the user's |
| `sessionRebuilt` (unsubscribe/close/resume) | `session-rebuild` | yes only if T5.3's one-way fallback was chosen |
| none of the above | `unknown` | no |

### T5.5 — Compaction policy: turn boundaries only, never beside a switch

- **What:** Add the compaction policy to `cache-policy.ts`: trigger on **remaining window** (not a fixed token count), only at a turn boundary after a tool result, never mid-tool-call, and never immediately before or after an agent or model switch (stacking compaction on a switch pays the write twice). After compaction, **re-pin the prefix** — identical system prompt and tool order — so the next write establishes a new entry. Set the vendor knobs from the policy: Claude `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (plain integer 100000–1000000), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1–100), `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` | `1h`); Codex `model_auto_compact_token_limit` with `model_auto_compact_token_limit_scope = "body_after_prefix"`.
- **Files:** `src/main/cache-policy.ts`, `src/main/agents/claude.ts` (env), `src/main/agents/codex.ts` (config), `src/main/usage.ts`, `test/cache-policy.test.ts`.
- **Acceptance:** `test/cache-policy.test.ts` asserts `shouldCompact({ remaining: 40_000, window: 200_000, atTurnBoundary: false })` is false and the same with `atTurnBoundary: true` is true; that a pending switch suppresses compaction; and that the env/config builder emits `model_auto_compact_token_limit_scope: "body_after_prefix"` for Codex and a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` integer within 100000–1000000 for Claude.
- **Notes:** Ch. 4 §4.5. TTL by idle profile:

| TTL | Write cost | When it pays |
|---|---|---|
| `5m` | 1.25× base input | a continuous coding loop — refreshes at no extra cost on each read |
| `1h` | 2× base input | only when the user genuinely pauses more than five minutes between turns |

Claude Code's effective lifetime is 1 hour on a subscription but drops to 5 minutes on usage credits or an API key, and `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts only `5m` or `1h`. Codex's `body_after_prefix` scope measures only growth beyond the carried compaction-window prefix — exactly the number that matters for cache economics. Compaction done naively is *worse* than not compacting: a summariser call with its own system prompt and no tools "diverges at the very first token and none of the cache applies". The fix — cache-safe forking — reuses the parent's system prompt and tools and appends only the compaction prompt, which is the same re-pin this task requires (Ch. 10 §10.3).

### T5.6 — `CacheMeter` in the header, following the `LimitMeter` house style

- **What:** New `src/renderer/src/components/CacheMeter.tsx` rendering beside `UsageMeter` (`App.tsx:82`) with the pure data function `cacheStats(events: StoredEvent[])` living in `cache-policy.ts`: per-turn hit rate, cumulative session hit rate, cache-write spend in USD, and a warm/cold indicator with TTL and last activity. Quiet until it has something to say, **one number**, detail in `title`, exactly like `LimitMeter` (`App.tsx:232-258`, which hides below 50%). A miss badge names the likely cause in Claude Code's own words ("tool definitions changed"). Add a `usage-update` live ticker reading Phase 4's live channel.
- **Files:** `src/renderer/src/components/CacheMeter.tsx` (new), `src/renderer/src/App.tsx`, `src/main/cache-policy.ts`, `test/cache-policy.test.ts`.
- **Acceptance:** `test/cache-policy.test.ts` computes `cacheStats` from a fixture `StoredEvent[]` in a process where `globalThis.fetch` is replaced by a spy that throws and `globalThis.window` is `undefined`; the assertion is that the spy was never called and the function returns the expected hit rate. `pnpm build` green; the meter renders nothing for a thread with no `turn-end` carrying `usage`.
- **Notes:** Ch. 4 §4.6; Ch. 7 §7.3. All of it comes **in-band** from data the agents already send — no polling endpoint, no extra request (invariant 5; the same pattern `test/claude-e2e.test.ts:125` already asserts with `expect(requests.filter(...)).toEqual([])`). ACP's `usage_update` carries no cache dimension, so the meter shows `—` rather than a fabricated number. Reuse `.usage` / `.limit-meter` / `.dot` / `.chip` from `styles/app.css` — do not invent a parallel class vocabulary (Ch. 7 §7.9).

---

## Risks & rollback

- **Pinning a larger prefix costs tokens on every request.** Mitigation: the browser tools are the only always-on addition and their definitions are small; the alternative (mid-conversation injection) costs a full prefix rewrite at write prices, which is strictly worse. If telemetry shows the prefix cost outweighing the rebuilds, the fallback in T5.3 keeps the change one-way and classifies rebuilds as expected.
- **Rewriting existing tests.** `test/codex.test.ts:163`, `test/acp.test.ts:116`, `:131`, and `test/codex-e2e.test.ts:67` assert the old mid-conversation behaviour; they must change in the same commit as the behaviour, or the phase looks green while shipping nothing.
- **Compaction knobs are vendor env vars.** Mitigation: T5.5 asserts the exact strings/values; an unknown agent simply gets no knobs, never a wrong one.
- **A meter that lies.** Mitigation: ACP shows `—`, an estimate is labelled `provenance: "estimated"`, and T5.6's test proves the number is computed only from events already in hand.
- **A stale fingerprint across a restart.** Mitigation: the pinned set is derived from the thread's stored creation-time state, not from process memory, so reopening the app yields the same fingerprint; T5.1's test asserts determinism across a fresh `cache-policy.ts` module state.
- **Rollback.** T5.2/T5.3 revert to mid-conversation rebuilds by reverting two call sites; `cache-policy.ts` is pure and deleting its importers is safe. No schema change, no persisted state.

## Exit criteria

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [ ] A unit test asserts the miss threshold at all four boundaries (5%, 2,000 tokens).
- [ ] A test asserts the tool set fingerprint is byte-identical across turns unless a queued change was applied at a boundary.
- [ ] A test asserts `cacheStats` makes no network call and does not touch `window`.
- [ ] Browser tools never trigger a reload; N user MCP edits between turns trigger exactly one reload, classified as an expected `session-rebuild`; the rewritten `codex`/`acp` tests prove it.
- [ ] The seven `browser_*` tools are offered on the first turn and return "Browser pane not open" before the tab is opened.
- [ ] `missCause` distinguishes an expected compaction rebuild from a true miss.
- [ ] Compaction never triggers mid-tool-call or adjacent to an agent/model switch, and re-pins the prefix afterwards.
- [ ] Where the harness builds a request itself (test-connection probes), it emits at most 4 explicit breakpoints; for agent-built requests, breakpoint placement is documented as the agent's responsibility.
- [ ] `CacheMeter` is silent for a thread with no cached usage, and shows one number with detail in `title`.
