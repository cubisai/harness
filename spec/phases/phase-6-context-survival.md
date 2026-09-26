# Phase 6 — Context survival: bindings, handoff, injection ledger

**Plan:** Ch. 3 (all), Ch. 10 §10.2, §10.4–10.7. **Depends on:** 0 (event payload, provenance, usage fields, `injection_ledger` table), 1, 2, and 3 (T6.5 reuses T3.7's `applyModel()`). **Risk:** high — T6.1 is a **one-way** migration and T6.6 seeds a channel that is **not idempotent**.

The canonical `threads`/`events` pair in `src/main/db.ts` is the only portable asset; provider cursors are parallel and disposable. This phase keeps every cursor, seeds a new session through the best channel the target offers, and reports exactly what did not cross. Invariants 1, 2, 4, 6 and 7 from `../README.md` bind every task here.

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/03-context-survival.md`](../../plan/docs/03-context-survival.md) — the whole chapter: §3.1 the two-layer model and the `SessionBinding` shape, §3.2 the event-log prerequisites, §3.3 the three switch cases and the seeding channels, §3.4 the loss contract, §3.5 trust reset and rollback.
- [`plan/docs/10-context-economy.md`](../../plan/docs/10-context-economy.md) — the whole chapter: §10.4 the injection ledger and why `thread/inject_items` is not idempotent, §10.5 the bloat signal, §10.6 the checkpoint budget, §10.7 the guardrails.
- [`plan/docs/07-ui-ux.md`](../../plan/docs/07-ui-ux.md) — §7.3 the switch contract card the user sees before anything is lost.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 3 in full: the portability blockers, ACP's limits, the peer-tool comparison, and the blueprint. This is the chapter's evidence base and the reason the honest answer is "re-seed, not port".

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S1 (whether a model can change on resume), S4 (Codex per-turn model).

---

### T6.1 — Replace `Thread.sessionId` with a per-provider `bindings` map
- **What:** Add `SessionBinding` (Ch. 3 §3.1) and `Thread.bindings: Record<string, SessionBinding>` keyed `` `${agent}:${instanceId}` ``; add a `bindings` JSON column to `threads` as a new entry in `steps[]`; keep `sessionId` as a **read-only projection** of `bindings[currentKey].resumeCursor` for one release. Stop `updateThread` nulling it (Phase 5 T5.2 may already have removed the eager `sessionId: null`; this task makes the per-agent cursor survive the switch).
- **Files:** `src/shared/types.ts` (modify — `Thread` at `types.ts:163-175`), `src/main/db.ts` (modify — `steps[]` `db.ts:49`, `THREAD_COLS` `db.ts:159`, `toThread` `db.ts:184-196`), `src/main/service.ts` (modify — `service.ts:72-81`), `test/db.test.ts` (modify)
- **Acceptance:** `pnpm test -- db` — a case opens a pre-bindings DB (mirror `db.test.ts:34-52`), migrates, and reads `bindings === {}` with `sessionId` intact. A round trip writes a binding for `codex:default`, switches the thread to `claude`, switches back, and asserts `bindings["codex:default"].resumeCursor` is unchanged and `sessionId` equals the projection.
- **Notes:** Ch. 3 §3.1. Additive migration only (README conventions); `sessionId` survives because a rollback without it loses session continuity.

### T6.2 — Thread JSON export/import as the pre-migration safety net
- **What:** `exportThread(id)` writes `{schemaVersion, thread, events[]}`; `importThread(json)` restores it as a new thread. This is the only reversibility path for T6.1.
- **Files:** `src/main/handoff.ts` (new), `src/main/service.ts` (modify), `src/shared/types.ts` (modify — `ThreadExport`), `src/preload/index.ts` (modify), `test/handoff.test.ts` (new)
- **Acceptance:** export a thread with a binding and 3 events, delete the row, import the JSON, and assert the restored thread's `bindings` and ordered event kinds are identical. An unknown/older `schemaVersion` is refused with a message, never partially imported. Events whose tool payload was offloaded (`payload_ref`, Phase 0 T0.6) are exported **with** their blob content (inlined or as a sidecar), so an import on another machine does not produce dangling refs — asserted by exporting a thread with one offloaded payload, importing it into a fresh data folder, and reading the payload back.
- **Notes:** Ch. 3 §3.1, §3.5. No export/import path exists today (verified: no `exportThread`/`importThread` anywhere in `src/`).

### T6.3 — `handoff.ts`: canonical events → structured checkpoint
- **What:** `buildCheckpoint(threadId)` reads the canonical events (Phase 0's `payload` + `provenance`) and emits a `HandoffCheckpoint`: goal + decisions, files touched with diffstats, commands run with exit codes and truncated output, open questions, artifact blob refs, workspace git state (`HEAD`, branch, dirty list), provenance header. **Thread state only.**
- **Files:** `src/main/handoff.ts` (new), `src/main/git.ts` (modify — add `gitState(cwd)`), `test/handoff.test.ts` (new)
- **Acceptance:** a fixture thread seeded with `CLAUDE.md` text, a skill body, and a `thinking` event produces a checkpoint whose serialized form contains none of the three (assert absence); the files list equals the paths from `workingTreeDiff` (`git.ts:53-89`).
- **Notes:** Ch. 10 §10.2 (the duplication trap), Ch. 3 §3.3c, invariant 2. Never inject what the target already loads itself.

### T6.4 — Checkpoint budget and tiered degradation
- **What:** measure the checkpoint in the **target's** tokens; target 2,000–4,000 tokens with a hard cap of `min(25% of destination window, 4k)` (Ch. 10 §10.6–10.7 — it supersedes Ch. 3's earlier `~8k`); degrade in tiers: full → tool results collapsed to `summary` + artifact path → decisions + git state only. Refuse a checkpoint larger than the tokens it replaces.
- **Files:** `src/main/handoff.ts` (new), `src/main/agents/types.ts` (modify — optional `countTokens?()`), `test/handoff.test.ts` (new)
- **Acceptance:** with a fake counter, an over-budget fixture degrades exactly one tier at a time and reports `tier`; a tier-0 checkpoint exceeding the replaced token count returns `{ok:false, reason}`.
- **Notes:** Ch. 10 §10.6, §10.5 (per-model counters; Anthropic's newer tokenizer ≈30% more tokens), §10.7 guardrails 2 and 5. Tokens never transfer across tokenizers. Most targets have no free counter the harness can call (Anthropic's `count_tokens` needs an API key the user may not have given us); when `countTokens` is absent, estimate conservatively (bytes/3) and label the budget `estimated`.

### T6.5 — `seed()` on the driver contract; route through Phase 3's `applyModel()`
- **What:** add `seed({threadId, sessionId, checkpoint})` returning `{mode: "resume" | "seeded" | "unsupported", reason?}`. Do **not** add a second `applyModel`: Phase 3 T3.7 already defines `Service.applyModel(threadId, model)` → `"in-place" | "new-session" | "unsupported"` with a driver `setModel?` hook; extend its return to `{ mode, reason }` there if the switch dialog needs the reason. Route case (a) native resume, (b) model change via `applyModel`, (c) cross-agent seeding (and `new-session` from (b)).
- **Files:** `src/main/agents/types.ts` (modify — `AgentDriver` `types.ts:50-70`), `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `src/main/service.ts` (modify)
- **Acceptance:** a driver without a seeding channel returns `unsupported` with a reason and the switch dialog disables Hand off; a stale cursor marks the binding `lost`, emits an `error`/`notice`, and falls through to case (c).
- **Notes:** Ch. 3 §3.3a–c, §3.5; Ch. 7 §7.3. Claude `{resume, model}` is undocumented `[U]` — route to (c) until S1 passes (`setModel()` is unreachable in this driver; see spec README repo fact 3).

### T6.6 — Codex seeding via `thread/inject_items`
- **What:** emit real Responses-shaped `function_call`/`function_call_output` items (never fabricated reasoning) and call `thread/inject_items {threadId, items}`; it must **not** start a user turn, and no side-effecting tool is re-executed.
- **Files:** `src/main/agents/codex.ts` (modify — beside `runTurn` `codex.ts:297-378`), `test/fixtures/mock-codex-app-server.mjs` (modify — add an `inject_items` scenario), `test/codex.test.ts` (modify)
- **Acceptance:** against the mock, `seed()` issues exactly one `thread/inject_items` whose `items` contain a `function_call_output` carrying the recorded `call_id`, and `runTurn` is not invoked; a second identical `seed()` issues zero inject calls.
- **Notes:** Ch. 3 §3.3c; Ch. 10 §10.4. **`thread/inject_items` is not idempotent** — the documented behaviour check found duplicate injections write duplicate rollout records with no error, ids are caller-owned, and injected items are not readable back through the API. The ledger, not the target, is the source of truth.

### T6.7 — OpenCode seeding via `session.prompt({noReply:true})`
- **What:** seed through `session.prompt` with `noReply: true` (returns a `UserMessage`, no AI response) and per-message `model`, gated on a **driver capability flag** — never on `driver.id === "opencode"`.
- **Files:** `src/main/agents/types.ts` (modify — `capabilities.seedNoReply`), `src/main/agents/opencode.ts` (new, only if a native channel lands), `test/opencode.test.ts` (new, gated on a fake)
- **Acceptance:** with the flag off the switch dialog offers the ACP path (T6.8); with it on, a fake asserts exactly one `session.prompt` carrying `noReply: true` and no `turn-end` event.
- **Notes:** Ch. 3 §3.3c; Ch. 10 §10.4 (the same ledger covers `noReply`). **Verified in-repo:** OpenCode is registered as an ACP agent (`registry.ts:34-40`, `opencode acp`), so today it takes the ACP synthetic-prompt path; do not add a native driver in this phase.

### T6.8 — Claude and ACP seeding via a synthetic first message
- **What:** send the checkpoint **once**, as a synthetic first user message (the end of `messages`, per Ch. 4 §4.3c). For Claude, if a system-prompt change is needed at all, use `systemPrompt: {type:"preset", preset:"claude_code", append: <short provenance header>}` on the new session's first request only — never a custom string (it replaces the default and loses tools, safety and environment context), never the checkpoint body (that bills it twice and breaks T6.4's budget), and never on a resume (the recorded prompt is replayed; a later `append` is ignored). For ACP the only channel is a synthetic first `session/prompt`. Today's OpenCode takes this ACP path (T6.7).
- **Files:** `src/main/agents/claude.ts` (modify — options `claude.ts:194-219`), `src/main/agents/acp/driver.ts` (modify — `openSession`/`session/prompt` `driver.ts:257-296,377-380`), `test/claude.test.ts` (modify), `test/acp.test.ts` (modify)
- **Acceptance:** a Claude test asserts that if `systemPrompt` is set it has `type === "preset"` (never a bare string) and its `append` does **not** contain the checkpoint body, and that the checkpoint text appears exactly once across `systemPrompt` + prompt; an ACP test against `mock-acp-agent.mjs` asserts the checkpoint arrives as one `session/prompt`. (The agent *will* answer a synthetic prompt — ACP has no no-reply flag — so assert the reply is stored as a `handoff`-scoped event and not shown as a normal assistant turn, rather than asserting it does not exist.)
- **Notes:** Ch. 3 §3.3c; Ch. 4 §4.3c. The system prompt is recorded on a session's first request and reused until compaction, so a later `append` is invisible on resume unless `snapshot:false`, which forbids cache reuse; because `append` lands in the system block it sits **inside** the cached prefix, ahead of messages in the `tools → system → messages` hierarchy — which is why the checkpoint goes in messages. `excludeDynamicSections: true` is optional here (it moves cwd/git status into the first user message); only adopt it if Phase 5 does so for every Claude session, or it changes the prefix shape per thread.

### T6.9 — The injection ledger: `intent → injected → failed`, verify-then-inject
- **What:** the `injection_ledger` table already exists from Phase 0 T0.6 — do **not** add another migration step for it. Add the `Store` methods (`recordIntent`, `markInjected`, `markFailed`, `injectedFingerprints(target)`) and `planInjection()`. Write an `intent` row per item before injecting, `injected` after. `item_fingerprint` = sha256 of the canonical item + protocol id. On a resumed/retried switch, skip fingerprints already `injected` for that target session and roll a half-finished checkpoint forward from `intent` rows.
- **Files:** `src/main/db.ts` (modify — new methods only), `src/main/handoff.ts` (modify — `planInjection()`), `test/handoff.test.ts` (new)
- **Acceptance:** injecting a checkpoint twice writes zero new `injected` rows and issues zero inject calls the second time; throwing between the `intent` and `injected` writes and re-running completes the same fingerprint without duplication and ends `injected`; `failed` rows are retried.
- **Notes:** Ch. 10 §10.4, §10.7 guardrails 3–4. The same ledger covers OpenCode `noReply` and the Claude/ACP synthetic first message, where no server-side dedup exists at all.

### T6.10 — The bloat signal, computed in-band
- **What:** on the post-switch turn compare `cacheRead + cacheWrite + netNew` against the pre-switch turn's total processed input (Phase 0's `turn-end.usage`). Clean resume → `cacheRead ≈` the prior total; bloated re-seed → `cacheRead ≈ 0` and `cacheWrite ≈` checkpoint size. Emit a `handoff`/`notice` event carrying the delta; **never poll**.
- **Files:** `src/main/service.ts` (modify — after `runTurn` returns, `service.ts:145-150`), `src/shared/types.ts` (modify — a `handoff` event kind or a `notice` payload for the signal), `src/renderer/src/App.tsx` (modify — surface), `test/service.test.ts` (modify)
- **Acceptance:** a fake driver emitting pre-switch `cacheRead=10000` and post-switch `cacheRead=9800` yields a "reused" signal; post-switch `cacheRead=0, cacheWrite=4000` yields "re-seeded 4.0k tokens".
- **Notes:** Ch. 10 §10.5; invariant 5. Needs only Phase 0's usage fields. For ACP targets `cacheRead` is `null` (unless S5 finds the prompt response reports it), so the signal is `unavailable` there — say so rather than reporting "re-seeded".

### T6.11 — The switch contract UI
- **What:** replace the agent `<select>` (`App.tsx:85-99`) with a `SwitchDialog` built from Ch. 3 §3.4's loss table — **Carries over** (visible messages, decisions, changed files, command results, workspace snapshot) and **Does not carry over** (reasoning, prompt cache, approvals, cwd trust) — with **Hand off**, **Start fresh**, and a quiet **Switch back to X** when a binding still exists. Model switches use the lighter variant; `unsupported` disables the option with the reason in `title`.
- **Files:** `src/renderer/src/components/SwitchDialog.tsx` (new), `src/renderer/src/App.tsx` (modify), `src/renderer/src/store.ts` (modify), `src/renderer/src/styles/app.css` (modify), `test/switch-dialog.test.tsx` (new, per Phase 0 T0.10), `test/palette.test.ts` (modify — only if a *Switch agent…* palette action is added)
- **Acceptance:** `renderToStaticMarkup` of a Codex→Claude switch names the carried count and both loss categories; with a `codex:*` binding present, "Switch back to Codex" renders and calls `updateThread({agent:"codex"})`; with `unsupported` seeding, Hand off is `disabled` and carries a `title` reason.
- **Notes:** Ch. 7 §7.3, §7.9 (`.sheet`/`.segmented`/`.notice`; no modal chains); Ch. 3 §3.4.

### T6.12 — Trust reset and git checkpoint before a switch
- **What:** on any agent switch reset permission mode, allow-always rules, additional workspace roots and credentials; re-declare `cwd` explicitly on resume; prior approvals are retained as evidence, never as authorization. Drop a git checkpoint `harness-handoff/<seq>` before the switch and refuse on a dirty worktree unless the user commits or stashes.
- **Files:** `src/main/handoff.ts` (modify — `checkpointGit()`), `src/main/service.ts` (modify), `test/handoff.test.ts` (new)
- **Acceptance:** on a temp git repo, `harness-handoff/<seq>` exists after a successful switch and does not exist when the switch was refused; a dirty worktree refuses with an actionable message; no allow-always rule from the old agent survives the switch.
- **Notes:** Ch. 3 §3.5; invariant 4 (classify the cache invalidation and tell the user).

### T6.13 — Handoff invariant tests
- **What:** one suite pinning the cross-phase invariants end to end.
- **Files:** `test/handoff.test.ts` (new), `test/fixtures/mock-codex-app-server.mjs` (modify), `test/fixtures/mock-acp-agent.mjs` (modify — add a seed scenario)
- **Acceptance:** all in one file: (1) a checkpoint built from a thread containing a side-effecting `Run` event replays as a `tool-result` and never re-invokes the tool; (2) every injected item carries a non-null `provenance.agent`; (3) after Codex→Claude→Codex, `bindings["codex:default"].resumeCursor` is unchanged; (4) injecting the same checkpoint twice is a no-op the second time; (5) a mid-injection throw rolls forward without duplicating; (6) export→import restores bindings and events.
- **Notes:** Ch. 3 §3.3–3.5; Ch. 10 §10.4, §10.7; invariants 1, 2, 6. Reuse `mock-acp-agent.mjs` and the Codex mock rather than new fakes.

---

## Risks & rollback

- **One-way migration.** `bindings` cannot be losslessly projected back to a single `sessionId`. Mitigations: T6.2 export/import, keep `sessionId` for one release, gate every switch behind the confirm card (T6.11). Do **not** drop the column in this release.
- **Non-idempotent seeding.** A crash between inject and mark duplicates rollout records silently (Ch. 10 §10.4). Mitigation: the ledger is authoritative (T6.9); never trust the target to dedupe.
- **Undocumented Claude resume+model** `[U]` (Ch. 3 §3.3b). Route to case (c) until the verification harness (session on A, resume with model B, read the effective model from the init `SystemMessage`) passes.
- **Cross-provider token counts.** Keep the canonical artifact as raw text and count with the target's counter (Ch. 10 §10.5).
- **Rollback.** Reverting the migration step is impossible once rows exist; the recovery path is T6.2 export/import. If a seeding channel misbehaves, flip its per-driver capability flag — the dialog falls back to **Start fresh** without a code change.

## Exit criteria

- [ ] `pnpm typecheck && pnpm test && pnpm build` green.
- [ ] `sessionId` is a read-only projection; `bindings` survives a restart.
- [ ] Export/import restores bindings and events (T6.2).
- [ ] No checkpoint carries conventions, skill bodies, or reasoning (T6.3).
- [ ] The ledger is idempotent and rolls forward (T6.9, T6.13 4–5).
- [ ] The bloat signal is emitted in-band and surfaced (T6.10).
- [ ] The switch card lists carries/does-not and offers Hand off / Start fresh / Switch back (T6.11).
- [ ] A git checkpoint exists before a successful switch; a dirty worktree refuses (T6.12).
- [ ] No side-effecting tool replayed, provenance complete, no binding dropped (T6.13 1–3).
