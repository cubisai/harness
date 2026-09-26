# Phase 4 — Streaming + reasoning display

**Goal.** Make the harness show output and reasoning *as it arrives*. Phase 0 landed the vocabulary; this phase wires the live-only half of it per driver, fixes the renderer bug that blanks the streaming bubble mid-turn, and stops re-parsing markdown on every token. Deltas stay live-only: nothing here writes to the database.

**Deliverables:** `src/main/agents/types.ts`, `src/main/agents/{claude,codex}.ts`, `src/main/agents/acp/driver.ts`, `src/main/service.ts`, `src/renderer/src/live.ts` (new), `src/renderer/src/streaming.ts` (new), `src/renderer/src/store.ts`, `src/renderer/src/markdown.tsx`, `src/renderer/src/components/{ThreadView,ReasoningBlock}.tsx`, `tsconfig.node.json`, `test/fixtures/{mock-acp-agent,mock-codex-app-server}.mjs`, `test/fixtures/fake-anthropic.mjs` (new, extracted from `test/claude-e2e.test.ts`), `test/{live,streaming}.test.ts` (new).

**Protocol field names, per driver (Ch. 5 §5.3 — use these exactly, do not map from memory):**

| Canonical live kind | Claude (`includePartialMessages: true`) | Codex (app-server v2) | ACP v1 |
|---|---|---|---|
| `text-delta` | `content_block_delta` + `delta.type === "text_delta"` → `delta.text` | `item/agentMessage/delta` → `params.delta` | `agent_message_chunk` → `update.content.text` |
| `reasoning-delta` | `delta.type === "thinking_delta"` → `delta.thinking` | `item/reasoning/textDelta` → `params.delta` (+`contentIndex`) | `agent_thought_chunk` → `update.content.text` |
| `reasoning-summary` | — (no summary channel) | `item/reasoning/summaryTextDelta` → `params.delta` (+`summaryIndex`); a new index opens on `item/reasoning/summaryPartAdded` | *unverified* whether any v1 agent emits summaries |
| signature | `delta.type === "signature_delta"` → `delta.signature` | n/a | n/a |
| `tool-input-delta` | `delta.type === "input_json_delta"` → `delta.partial_json` (this is **tool input**, not output) | — | — |
| `tool-output-delta` | **none** — Claude has no tool-output stream | `item/commandExecution/outputDelta` → `params.delta` | `tool_call_update.content[]` → `c.content.text` |
| `thinking-progress` | `SDKThinkingTokensMessage`: `type:"system"`, `subtype:"thinking_tokens"`, `estimated_tokens` | n/a | n/a |

**Ordering contract.** `StoredEvent.seq` keeps terminal order and must not change. Live deltas get their own **per-`itemId` monotonic index**, and the renderer must drop any delta whose terminal event for that `itemId` has already landed — otherwise a late frame appends text after the authoritative block. Terminal text is the ground truth for replay (Phase 6), so a delta that arrives after its terminal event is discarded, never merged.

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/05-streaming-reasoning.md`](../../plan/docs/05-streaming-reasoning.md) — the whole chapter, and especially §5.3 (the mapping table with the exact notification names per driver) and §5.4 (the three file-level changes: `claude.ts`, `codex.ts`, `acp/driver.ts`).
- [`plan/docs/07-ui-ux.md`](../../plan/docs/07-ui-ux.md) — §7.4 the rendering rules for reasoning and tool output, including the opaque-stream case.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 3 §A4 (the per-protocol mapping of text/reasoning/tool-call/approval into one canonical vocabulary) and Part 1 §1.2 (OpenCode's event surface, as a cross-check on what an ACP agent implements).
- [`plan/docs/03-context-survival.md`](../../plan/docs/03-context-survival.md) — §3.2, because the terminal events this phase emits are what a later handoff replays.

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S5 (ACP notifications beyond the spec).

---

### T4.1 — Add the live-delta channel to `TurnInput` and `LiveUpdate`

- **What:** Add the delta callbacks the drivers need — `onReasoningDelta({ itemId, text, opaque })`, `onReasoningSummary({ itemId, index, text })`, `onToolInputDelta({ toolUseId, text })`, `onToolOutputDelta({ toolUseId, text })`, `onUsageUpdate(usage)`, `onThinkingProgress({ estimatedTokens })` — to `TurnInput` (`src/main/agents/types.ts:26-43`) and broadcast each as a `LiveUpdate` variant from `Service.send` (`service.ts:117-145`). Keep `onTextDelta` as-is.
- **Files:** `src/main/agents/types.ts`, `src/main/service.ts`, `src/shared/types.ts`.
- **Acceptance:** `pnpm typecheck` green. A `test/service.test.ts` case drives a fake driver that calls `onReasoningDelta` and asserts the broadcast `LiveUpdate` is `{ type: "reasoning-delta", threadId, itemId, text, opaque }` and that `store.listEvents` is unchanged (no row written).
- **Notes:** Ch. 5 §5.1–5.2. `onTextDelta` today is the only incremental channel (`agents/types.ts:36`, broadcast at `service.ts:128`); one live scalar cannot express four concurrent streams. `usage-update` deliberately reuses Phase 0's cache dimensions rather than inventing new ones. Every callback must carry the item key — that is what makes T4.5 possible.

### T4.2 — Claude: switch on `delta.type` instead of filtering for `text_delta`

- **What:** Replace the `text_delta`-only branch at `claude.ts:242-247` with a switch on `ev.delta.type`: `text_delta` → `onTextDelta`; `thinking_delta` → `onReasoningDelta` (`opaque: false`); `signature_delta` → hold the signature and attach it to the pending `thinking` terminal event (`opaque: true`, no editable text); `input_json_delta` → `onToolInputDelta`. Also handle `SDKThinkingTokensMessage` (`type:"system"`, `subtype:"thinking_tokens"`) → `onThinkingProgress`. Keep the `parent_tool_use_id` guard at `:243` but do **not** extend subagent filtering to reasoning.
- **Files:** `src/main/agents/claude.ts`, `test/claude.test.ts`, `test/fixtures/fake-anthropic.mjs` (new — extracted from the inline `fakeAnthropic()` at `test/claude-e2e.test.ts:19-58`, which today emits only a `text_delta` at `:50`).
- **Acceptance:** `test/claude.test.ts` asserts that a `stream_event` sequence of `text_delta` → `thinking_delta` → `signature_delta` yields one `text-delta`, one `reasoning-delta` with `opaque: false`, and a terminal `thinking` event whose `signature` is the delta's signature and whose text is not treated as editable. `pnpm typecheck` green.
- **Notes:** Ch. 5 §5.4, §5.5. The guard is dead weight for stream events (the SDK always sets `parent_tool_use_id` to `null` on `SDKPartialAssistantMessage`, and subagent token deltas are not forwarded) — keep it, but subagent attribution must keep coming from complete messages. On Fable 5.1 the `thinking` field is empty and the `signature` *carries* the reasoning, so a serializer that drops "empty" blocks destroys replayability and a tampered signature always 400s: store opaque reasoning as an opaque payload, never as round-trippable text.

### T4.3 — Codex: handle reasoning, summary, and command-output deltas

- **What:** Add cases to the `onNotification` switch at `codex.ts:138-172` for `item/reasoning/textDelta` → `onReasoningDelta`, `item/reasoning/summaryTextDelta` → `onReasoningSummary` (indexed by `summaryIndex`), `item/reasoning/summaryPartAdded` → open a new summary index, and `item/commandExecution/outputDelta` → `onToolOutputDelta`. Extend the `params` cast at `:135` with `contentIndex` and `summaryIndex`. Accumulate per `itemId` in the existing `t.deltas` map. Do **not** handle `item/fileChange/outputDelta` — it is deprecated ("the server no longer emits this notification").
- **Files:** `src/main/agents/codex.ts`, `test/fixtures/mock-codex-app-server.mjs` (modify — it emits only `item/completed` for reasoning at `:128` and no output delta at `:122-126`), `test/codex.test.ts`.
- **Acceptance:** `test/codex.test.ts` asserts that the fixture's reasoning deltas produce `reasoning-delta` broadcasts in arrival order and that `item/commandExecution/outputDelta` produces `tool-output-delta` for the right `toolUseId` before the `tool-result`. Assert `summaryPartAdded` opens index 1 and `summaryTextDelta` for index 1 is attributed there.
- **Notes:** Ch. 5 §5.3–5.4. `summaryTextDelta` is a curated **summary**; `textDelta` is **verbatim** — the UI must not present them as the same thing. `item/plan/delta` is flagged EXPERIMENTAL ("clients should not assume concatenated deltas match the completed plan item content") and belongs behind a capability flag, or be skipped in favour of the stable `turn/plan/updated` terminal event already handled in Phase 0.

### T4.4 — ACP: stream thoughts immediately, surface tool output before completion

- **What:** Replace `t.thought += …` at `acp/driver.ts:154-156` with an immediate `onReasoningDelta`; keep `flushText` (`:136-141`) emitting the terminal `thinking` from whatever accumulated, so agents that do not stream thoughts still produce one. In the `tool_call`/`tool_call_update` branch (`:157-179`), surface `content` as `onToolOutputDelta` on every update that carries it, instead of discarding everything until `status === "completed" | "failed"`. Emit `onUsageUpdate` from the `usage_update` case (`:180-187`) rather than only mutating local state. Add a driver capability flag stating whether this agent streams thoughts in real time.
- **Files:** `src/main/agents/acp/driver.ts`, `test/fixtures/mock-acp-agent.mjs` (modify — add the `"reason"` scenario and an in-progress `tool_call_update` with `content` from T0.8 if not already present), `test/acp.test.ts`.
- **Acceptance:** `test/acp.test.ts` asserts that the three thought chunks arrive as three `reasoning-delta` broadcasts *before* the turn's `thinking` terminal event, and that an in-progress `tool_call_update` with `content` produces a `tool-output-delta` before the `tool-result`.
- **Notes:** Ch. 5 §5.4. ACP v1 does not *require* agents to emit thought chunks in real time, hence the capability flag — when it is off, the terminal `thinking` is the only thing users see, and the UI must say so rather than showing an empty reasoning block. OpenCode is registered here as a built-in ACP agent (`registry.ts:34-40`, `command:"opencode"`, `args:["acp"]`), so this path is exercised against a real v1 server.

### T4.5 — Fix the store: per-item live state, cleared only by its terminal event

- **What:** Extract the live reducer into a new DOM-free `src/renderer/src/live.ts` exporting `emptyLive()`, `appendDelta(state, delta)`, `flushPending(state)`, and `applyLiveEvent(state, stored)`. `store.ts` keeps a `live: Record<threadId, Record<itemId, LiveItem>>` instead of the single `liveText` string, and the `"event"` case (`store.ts:286-296`) stops wiping the whole bubble: `applyLiveEvent` marks only the item named by the terminal event's `itemId` as done. Drop deltas whose terminal event already landed. The `text-delta` case (`store.ts:297-299`) appends to `pending` and schedules `flushPending` on a 16 ms frame timer instead of one store write per token.
- **Files:** `src/renderer/src/live.ts` (new), `src/renderer/src/store.ts`, `src/renderer/src/components/ThreadView.tsx`, `tsconfig.node.json` (modify — add `src/renderer/src/live.ts` to `include` at `:16`, as `palette.ts`/`cmdline.ts`/`fileref.ts` already are, so tests can import it), `test/live.test.ts` (new).
- **Acceptance:** `test/live.test.ts` asserts (a) **ordering + coalescing**: three `appendDelta` calls for one `itemId` followed by one `flushPending` yield a single visible string in arrival order; (b) **a mid-turn `tool-use` does not clear the streaming buffer** — applying a stored `tool-use` event for a *different* item leaves the in-progress item's text intact; (c) applying the matching `assistant-text` terminal event clears that item and a later `appendDelta` for it is a no-op.
- **Notes:** Ch. 5 §5.1, §5.6; Ch. 7 §7.4. This is the actual bug: `store.ts:290-294` sets `clearLive = event.kind !== "user"`, so today every Codex `thinking` and every Claude `tool-use` mid-turn blanks the bubble. Live state must be per-`itemId` and cleared only by the matching terminal event. `vitest.config.ts:6` sets `environment: "node"`, so the reducer must be pure and DOM-free — that is why it lives in `live.ts` and not in `store.ts`. Per-item cap: truncate the live buffer keeping the tail; the terminal event is the ceiling.

### T4.6 — Markdown: freeze completed blocks, render the tail as plain text

- **What:** Add `src/renderer/src/streaming.ts` exporting `splitStreamingTail(text)` → `{ frozen, tail }`, where `frozen` ends at the last **complete** block boundary and `tail` is the remainder — never containing an unterminated fence — plus `memoizeByHash(text, parse)` so a growing tail does not re-parse the frozen prefix. Change `Markdown` (`markdown.tsx:13-53`) so that when `streaming` is set it renders `memoizeByHash(frozen, parseBlocks)` and emits `tail` as plain text, replacing the current `const blocks = parseBlocks(text)` at `:14` which re-parses the whole string per delta.
- **Files:** `src/renderer/src/streaming.ts` (new), `src/renderer/src/markdown.tsx`, `src/renderer/src/components/ThreadView.tsx`, `tsconfig.node.json`, `test/streaming.test.ts` (new).
- **Acceptance:** `test/streaming.test.ts` asserts (a) a partial/unterminated fenced block — `"para\n\n```js\nconst a = 1"` — puts the whole fence in `tail` and leaves no `code` block in `parseBlocks(frozen)`; (b) `memoizeByHash` invokes the parser once for two calls with the same frozen prefix and different tails (spy on the parser); (c) a completed fence followed by a paragraph splits with the fence in `frozen`.
- **Notes:** Ch. 5 §5.6; Ch. 7 §7.4. This task is the single owner of the streaming tail; Phase 7 T7.12 reuses `streaming.ts` rather than re-implementing it. `parseBlocks` (`markdown.tsx:61-108`) currently treats an unterminated fence as a `code` block running to end-of-input, which renders a `<pre>` that is open and growing — the "broken markdown" this task removes. O(N) per token becomes O(tail) per token. `streaming.ts` must be pure TS with no JSX, or `tsconfig.node.json` (which includes `test/**/*` but has no `jsx` setting) cannot typecheck a test that imports it.

### T4.7 — `ReasoningBlock` replaces `<details className="thinking">`

- **What:** New `src/renderer/src/components/ReasoningBlock.tsx`: collapsed by default, auto-expanding only while it is the newest thing on screen; consumes `reasoning-delta` when the stream is transparent and a `thinking-progress` **token counter** when it is opaque. Replace `ThreadView.tsx:79-85`. Enforce mutual exclusion in the component: the opaque spinner and the visible text stream must never drive the same element — pick the channel by `opaque`, and when a turn starts opaque and later produces text, tear the spinner down before mounting the text block. Also add the `plan` checklist row and the `compaction` divider (*Context compacted · 12.4k → 4.1k tokens*) to the `ThreadView` switch (`:63-103`), since the terminal events for both landed in Phase 0.
- **Files:** `src/renderer/src/components/ReasoningBlock.tsx` (new), `src/renderer/src/components/ThreadView.tsx`, `src/renderer/src/styles/app.css` (modify — reuse the existing class vocabulary).
- **Acceptance:** Interaction (auto-expand, teardown) needs a DOM, which the suite does not have; so assert the pure decision function exported from `live.ts` (keep it out of the `.tsx` so it typechecks without JSX) returns `"text"` for `{ opaque: false }`, `"tokens"` for `{ opaque: true }`, and never `"both"` for any input. `pnpm build` succeeds; a `.tsx` test (Phase 0 T0.10) asserts `renderToStaticMarkup` of a `compaction` event contains `Context compacted` and of a `plan` event contains each step; `pnpm preview:ui` renders both without a console error.
- **Notes:** Ch. 5 §5.5–5.6; Ch. 7 §7.4. Show reasoning **only when a reasoning stream exists** — no placeholder row, no spinner for its own sake. The joint-driven failure is specific and bad: on a model whose reasoning lives in the `signature`, the spinner fills the slot, the text never arrives, and the user sees an open, permanently empty reasoning pane. A "Show reasoning" preference belongs in Settings, not in the block. No fake progress bars (Ch. 7 §7.10).

### T4.8 — Flush accumulated buffers as terminal events on abort

- **What:** On abort, emit the accumulated live buffers as terminal events before the existing `notice`: Claude's pending thinking signature, Codex's `t.deltas` map (already flushed at `codex.ts:362`), and ACP's `flushText` (already called at `driver.ts:381`). Verify each driver's abort path emits `thinking`/`assistant-text` for text that arrived only as deltas, so nothing a user watched stream vanishes when they hit Escape.
- **Files:** `src/main/agents/claude.ts`, `src/main/agents/codex.ts`, `src/main/agents/acp/driver.ts`, `test/{claude,codex,acp}.test.ts`.
- **Acceptance:** `test/acp.test.ts` and `test/codex.test.ts` abort a streaming turn and assert that every delta the test observed is present in the accumulated terminal text, and that the `notice` (*"Stopped."*) comes after those terminal events.
- **Notes:** Ch. 5 §5.6. `codex.ts:363` already special-cases `turn.status === "interrupted"` and `acp/driver.ts:382` maps `stopReason === "cancelled"`; the new work is that unflushed *deltas* must not vanish, which only matters once deltas exist.

---

## Risks & rollback

- **Delta flood.** Mitigation: coalesce per `itemId` on a 16 ms timer (T4.5), cap the per-item live buffer (truncate, keep the tail), and rely on the terminal event as the persisted ceiling — the delta stream is the volume, the terminal event is the ceiling (Ch. 5 §5.6).
- **Out-of-order deltas.** Mitigation: the per-`itemId` monotonic index plus the "drop after terminal" rule above; T4.5's test (c) covers the post-terminal case.
- **Two channels for one state.** Mitigation: T4.7's mutual-exclusion decision function is unit-tested; a turn that flips from opaque to transparent tears down rather than grows.
- **Reasoning content leaking into persisted text.** Mitigation: opaque reasoning is stored as an opaque payload with its signature (T4.2); it is never rendered as editable text.
- **Extracting two more inline fakes.** Mitigation: T4.2 extracts only the Claude fake and only when the delta test needs it; the ACP/Codex fixtures are extended in place, not rewritten.
- **Rollback.** Every change is per-driver and additive: reverting T4.2–T4.4 restores the previous single-`text-delta` behaviour with no schema change, because no delta is ever persisted.

## Exit criteria

- [x] `pnpm typecheck`, `pnpm test`, `pnpm build` green.
- [x] A test asserts delta ordering and that N deltas coalesce into one visible update.
- [x] A test asserts a partial/unterminated fenced code block never renders as a `code` block.
- [x] A test asserts a mid-turn `tool-use` for one item does not clear another item's streaming buffer.
- [x] A test asserts a `reasoning-delta` broadcast writes no `events` row.
- [x] Claude `thinking_delta`/`signature_delta`/`input_json_delta` and Codex reasoning/output deltas are each covered by a driver test.
- [x] ACP thought chunks are broadcast before the terminal `thinking`, and tool output is broadcast before the `tool-result`.
- [x] Aborting mid-stream leaves every observed delta present in the terminal text.
- [x] `ReasoningBlock` never drives one element from both `thinking-progress` and `reasoning-delta`.
- [x] `pnpm preview:ui` renders a `plan` row and a `compaction` divider with no console error.
