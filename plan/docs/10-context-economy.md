## 10. Context Survival Without Bloat: Memory Scopes, Idempotent Injection, Tool-Call Deduplication, and Token Accounting on Model and Provider Switch

**Thesis.** Chapter 3 specified *how* context crosses a switch. This chapter specifies what it must cost — and the answer starts with a distinction the current code does not make anywhere: **replaying history to the client is free; only what enters the model's input array is billed.** ACP states this outright — `session/resume` with `replayFrom` replays retained history as `session/update` notifications, and "Replaying a command reports its message; it does not execute the command again" ([ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)). Re-rendering the canonical event log is therefore not a cost concern at all. Every real question is about what re-enters context, and there are exactly five mechanisms to price.

### 10.1 What a switch costs, by mechanism

| Mechanism | Re-processed by the model | Cache | Free |
|---|---|---|---|
| **(a) Native resume** (Claude `resume`, Codex `thread/resume`) | The whole transcript is re-sent as input | **Yes** — the unchanged prefix bills at cache-read rate while inside the TTL | UI render, cursor bookkeeping |
| **(b) In-place model change** (Claude `setModel`, ACP `session/set_config_option`, OpenCode per-message `model`) | Whole history re-processed | **No** — "each model has its own cache" | — |
| **(c) New session + seeded checkpoint** | Only the checkpoint text | Cold prefix | Export and selection |
| **(d) Native compaction** (`thread/compact/start`, `/compact`) | The full conversation, once, to the summariser | Only with cache-safe forking (below) | Retention logic |
| **(e) `thread/inject_items`** | The injected items' tokens on **every** subsequent turn | Earlier prefix still cacheable | Building the items |

The load-bearing row is (a). Claude Code's own documentation says that resuming "sends the whole conversation again, and the request reads from the cache whatever part of its prefix is unchanged and still within the cache lifetime" ([Claude Code — prompt caching](https://code.claude.com/docs/en/prompt-caching)). So a same-provider resume is cheap *by construction* — 0.1× on the unchanged prefix — while a cross-provider switch is expensive *by construction*, because caches are per-model and per-provider and the target starts cold. **This is the single most important design consequence in the chapter: within a provider, always prefer resume over re-seed; only switch providers when the user actually wants a different agent.**

### 10.2 Memory scopes, and the duplication trap

All four agents have their own memory systems, and they overlap in ways that turn a handoff checkpoint into triple-loaded tokens.

- **Claude Code** loads a four-tier `CLAUDE.md` hierarchy at session start — managed policy, user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md` or `./.claude/CLAUDE.md`), and local (`./CLAUDE.local.md`) — discovered from the working directory *and every parent*, concatenated root-down; `@import` expands recursively to a maximum of four hops; project-root `CLAUDE.md` is **re-injected after `/compact`** ([memory docs](https://code.claude.com/docs/en/memory)). Separately, **auto memory** writes to `~/.claude/projects/<project>/memory/MEMORY.md`, of which only the first **200 lines or 25 KB** load every conversation — and it explicitly skips anything `CLAUDE.md` already says ([memory docs](https://code.claude.com/docs/en/memory)).
- **Codex** reads `AGENTS.md` once per run: global (`~/.codex/AGENTS.override.md` else `AGENTS.md`), then root→cwd with **at most one file per directory**, concatenated so nearer files override, stopping at `project_doc_max_bytes` (**32 KiB** default) ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). The format is shared across roughly 60,000 projects ([agents.md](https://agents.md)).
- **OpenCode** reads `AGENTS.md` (traversing up) plus `~/.config/opencode/AGENTS.md`, an `instructions` config array that accepts globs and remote URLs, and — for Claude Code migrants — **falls back to `CLAUDE.md` and `~/.claude/skills/`** unless `OPENCODE_DISABLE_CLAUDE_CODE` is set ([rules docs](https://opencode.ai/docs/rules/)).
- **ACP defines no memory, instructions or system-prompt channel at all** — context is `cwd`, `additionalDirectories`, `mcpServers` and embedded `ContentBlock`s ([ACP v1 schema](https://agentclientprotocol.com/protocol/v1/schema)). Memory is entirely the agent's own configuration.

The collisions are concrete and worth naming: a project with **both `CLAUDE.md` and `AGENTS.md`** loads the same conventions twice on Claude, and OpenCode reads `CLAUDE.md` as well; Claude's auto-memory then refuses to record what `CLAUDE.md` already says; and a checkpoint that restates project conventions or a skill's body duplicates content the agent already auto-loads or can load on demand through the Skill tool.

**The rule this yields:** the handoff checkpoint carries **thread state only** — decisions taken, task status, files touched, commands run and their outcomes, open questions, cursor. Never project conventions (the agent already has them), never skill bodies (they load lazily), never reasoning (the target may not be able to read it — Ch. 3 §3.4).

| Where | What belongs | Failure mode if you get it wrong |
|---|---|---|
| Canonical transcript (SQLite) | Full ordered event log with payload + provenance | Unbounded growth — prune by policy, never by deleting provenance |
| Harness memory file (project-scoped, cross-agent) | Only deliberately-shared, thread-independent facts | **Duplication** with `CLAUDE.md`/`AGENTS.md`; cross-agent leakage |
| Agent's own memory (`CLAUDE.md`, `AGENTS.md`, auto memory) | Provider-specific nuance | **Staleness** — project-root `CLAUDE.md` is read once; edits need `/clear` or `/compact` |
| MCP memory server | Large, retrievable knowledge, read on demand | Unbounded growth; never mirror it into the transcript |

### 10.3 Prefer the vendors' pruning primitives to hand-rolled heuristics

The strongest lever is Anthropic's **context editing** (beta header `context-management-2025-06-27`): `clear_tool_uses_20250919` clears old tool results with parameters `trigger` (default **100,000 input tokens**), `keep` (default **3** recent tool-use/result pairs), `clear_at_least`, `exclude_tools`, and `clear_tool_inputs` (default `false`); `clear_thinking_20251015` does the same for thinking blocks. It is **server-side** — the API removes the oldest tool interactions first and replaces each cleared result with placeholder text — and reports what it did in `context_management.applied_edits`, with `cleared_tool_uses`, `cleared_thinking_turns` and `cleared_input_tokens`, surfaced in streaming on `message_delta` ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). A sibling strategy, **`compact_20260112`** (beta `compact-2026-01-12`), summarises at a trigger of at least 50,000 input tokens (default 150,000) and returns a `compaction` block, with `pause_after_compaction` and custom `instructions` ([compaction threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)).

Two cautions that belong in `cache-policy.ts` (Ch. 4). First, clearing invalidates the cached prefix **at the clear point**, so `clear_at_least` exists to make the invalidation worth paying for — and placing a `cache_control` breakpoint after the static system prompt keeps that prefix from being re-billed when a later layer is cleared or compacted ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Second, compaction done naively is *worse* than not compacting: a summariser call with its own system prompt and no tools "diverges at the very first token and none of the cache applies". Anthropic's fix, **cache-safe forking**, reuses the parent's system prompt and tools and appends the compaction prompt ([Lessons from building Claude Code](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)).

Elsewhere: Codex's `thread/compact/start` returns `{}` immediately and streams a `contextCompaction` item lifecycle ([app-server](https://developers.openai.com/codex/app-server/)), with `model_auto_compact_token_limit` and `model_auto_compact_token_limit_scope` — `total` (default) or `body_after_prefix` — documented as growth "after the carried compaction-window prefix", and read by a source-level analysis as subtracting the cached prefill so cached tokens do not inflate the trigger ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference); the prefill reading is `[S]` — [analysis](https://60ke.github.io/posts/openai-codex-context-compaction/)) — plus `compact_prompt` for custom instructions. OpenCode exposes `session.summarize`, `session.revert`/`unrevert`, and an `experimental.session.compacting` plugin hook that fires *before* the summary and can append to or replace the continuation prompt ([plugins](https://opencode.ai/docs/plugins/), [SDK](https://opencode.ai/docs/sdk)). **ACP exposes nothing** — compaction there is entirely the agent's internal behaviour, which is why an ACP agent's context growth is unobservable and must be inferred from `usage_update`'s `used`/`size` ([prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)).

Anthropic's own framing is worth adopting as the default posture: clearing tool calls and results is "one of the safest lightest touch forms of compaction" once a call is deep in the history, with the counterweight that "overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later" ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

### 10.4 Idempotent injection: the "no duplicated tool calls" requirement

There are two distinct duplication risks. Re-*executing* a side-effecting tool is the first — already forbidden in Ch. 3, and ACP's replay semantics make the safe path explicit. Re-*sending* is the second, and it is worse than it looks, because **`thread/inject_items` is not idempotent.** The official documentation describes it only as appending "raw Responses API items to a loaded thread's model-visible history" and never mentions deduplication ([app-server](https://developers.openai.com/codex/app-server/)). A reproducible spike against `codex-cli 0.144.5` found that injecting the same item twice returns `{}` both times and writes **two identical rollout records** — no dedup, no error, and the server neither assigns nor rewrites item ids. The injected items are attached to a synthetic `turn_id` and are **not readable back through the API**; the only read-back is the rollout JSONL on disk ([spike](https://github.com/chenxiangning/codemoss/blob/main/docs/research/spikes/2026-07-27-s1-codex-thread-inject-items.md) `[S]`). Idempotency is entirely the caller's problem.

The identity primitives exist, but they are per-protocol: Anthropic `tool_use.id` (`toolu_…`), ACP `toolCallId` (documented as "a unique identifier for this tool call within the session") plus an opaque per-message `messageId` ([ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) for `toolCallId`; the replay `messageId` is defined in [ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup)), and Codex's `call_id` on Responses `function_call`/`function_call_output` items. Note the scope: ACP's `tool_call_update` is an upsert keyed by `toolCallId`, so it is idempotent **within** a session — but a fresh session has no memory of it, which is exactly the switch case.

So the harness owns a **durable injection ledger**, a new table alongside the event log:

```
injection_ledger(
  thread_id, target_provider, target_session_id,
  checkpoint_id,            -- one handoff
  item_fingerprint,         -- sha256 of the canonical item + protocol id
  state,                    -- 'intent' | 'injected' | 'failed'
  injected_at
)
```

The protocol: write an `intent` row per item *before* injecting; inject; mark `injected`. On a resumed or retried switch, **verify-then-inject** — skip every fingerprint already recorded `injected` for that target session, and roll a half-finished checkpoint forward from `intent` rows rather than re-injecting blindly. Because Codex cannot read injected items back, **the ledger — not the target — is the source of truth.** The same ledger covers OpenCode's `session.prompt({noReply: true})` — if and when a native driver makes that channel reachable (Ch. 3 §3.3c) — and the synthetic first message used for Claude and ACP, where no server-side dedup exists at all.

### 10.5 Token accounting, and the bloat signal

You cannot compare raw counts across providers. Anthropic states that Claude 4.7+/Fable/Mythos use a newer tokenizer producing **approximately 30 percent more tokens** than earlier models, and instructs callers to recount against the target model ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)); OpenAI rounds `cached_tokens` down to a multiple of 128 (pre-5.6) and requires a 1,024-token minimum cacheable prefix ([prompt caching](https://platform.openai.com/docs/guides/prompt-caching)). **Rule: keep the canonical artifact as raw text and derive per-model counts with each provider's own counter — Anthropic's `count_tokens` is free and per-model — and attribute "context size" in the target model's tokens, never a number measured elsewhere.**

The measurable bloat signal, computed in-band from usage fields the vendors already send (Ch. 4):

- **Clean resume:** `cacheRead ≈` the previous turn's total processed input, with small `cacheCreation`.
- **Bloated re-seed:** `cacheRead ≈ 0` and `cacheCreation ≈` the full checkpoint size.

That delta is the number to put in the UI, and the one to alert on. It is the honest answer to "did switching cost me anything?", and it needs no extra request — consistent with the repo's existing refusal to poll for rate limits (`README.md`).

### 10.6 Budgeting the checkpoint

Precedents rather than invented numbers: Anthropic's sub-agents return "often 1,000–2,000 tokens"; compaction preserves architectural decisions, unresolved bugs and implementation details while discarding redundant tool outputs, and Claude Code keeps the five most recently accessed files ([Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Codex's compaction path keeps a handoff summary **plus up to 20,000 tokens of the most recent user messages**, and its summarisation prompt literally reads "Create a handoff summary for another LLM" with framing that tells the target to avoid duplicating work ([analysis](https://60ke.github.io/posts/openai-codex-context-compaction/) `[S]`). The widely-cited thresholds — 93% auto-compact, a 90% hard cap, a 70% manual trigger — are rules of thumb, not documented rules `[U]`.

Design target: **a structured 2,000–4,000-token handoff**, measured in the *target's* tokens, degrading in tiers (full checkpoint → tool results collapsed to previews + artifact paths → decisions and git state only), and never exceeding the number of tokens it replaces. Carry decisions, unresolved questions, touched files with diffstats, command results truncated to a preview plus a path, and the workspace's git state. Drop conventions, skill bodies, reasoning, and raw tool output.

### 10.7 Guardrails the harness enforces

1. **Resume before re-seed within a provider** — resume reuses a cached prefix at 0.1×; a fresh seed is cold and full price.
2. **Per-switch injection budget** — a hard cap (default ~4k tokens) measured with the target's counter, refusing to inject past it.
3. **Dedupe ledger** — key `(target session, item fingerprint)`, refuse anything already `injected`.
4. **Never trust the target to have deduped** — Codex cannot read injected items back; the ledger is authoritative.
5. **Cap carried tool results** — preview plus artifact path, mirroring Claude Code's disk offload rather than shipping a 30k-character `Bash` output into a new provider.
6. **Warn before an expensive switch** — estimate the checkpoint's cost and compare it with the `cacheRead` savings the user is giving up.
7. **Never inject reasoning the target cannot read** — no Anthropic thinking blocks into Codex, and never carry an item whose `encrypted_content` is `null`.
8. **Never re-execute a side-effecting tool** — replay is reporting only.

### 10.8 Changes to the store layer

`db.ts` currently has no event sourcing: `events(thread_id, seq, payload, created_at)` with a `PRIMARY KEY (thread_id, seq)`, plus a `schema_version` table and an ordered `steps[]` migration list (`db.ts:16-62`). Three concrete additions, all additive:

- **`injection_ledger`** as above (new table, new migration step).
- **`events` gains `provenance`, semantic-id and `payload_ref`/`payload_bytes` columns** (Ch. 3 §3.2). Note the existing single `payload` column already *is* the whole event JSON, so the full tool input/output lives inside that JSON (not in a second column of the same name); the blob table from Ch. 3 holds the large ones and `payload_ref` points at them.
- **Tighten `appendEvent`** (`db.ts:137-146`): it computes `MAX(seq) + 1` in a separate statement before inserting. With `PRIMARY KEY (thread_id, seq)` that lookup is an index seek, not an O(n) scan, and `node:sqlite` is synchronous, so inside the one main process there is no interleaving; the race is real only across connections (a second process or worker). Deltas are never persisted (Ch. 5 §5.1), so write rate does not change. Folding it into one `INSERT … SELECT COALESCE(MAX(seq),0)+1` statement (plus a `busy_timeout`) is cheap hardening, not a performance fix.

Retention is the last piece: the canonical log grows without bound by design (Ch. 3), so pruning must be a policy — keep full payloads for the last N turns per thread, replace older tool results with a preview plus a blob reference, and never delete the provenance.

### 本章新增来源清单

1. [Claude Code — How Claude remembers your project](https://code.claude.com/docs/en/memory) `[P]` — four-tier `CLAUDE.md`, `@import` (max 4 hops), auto-memory `MEMORY.md` (first 200 lines / 25 KB), 4 MiB skip, project-root re-injection after `/compact`.
2. [Claude Code — Prompt caching](https://code.claude.com/docs/en/prompt-caching) `[P]` — resume re-sends the whole conversation and reads the unchanged prefix from cache; per-model caches; TTL buckets.
3. [Anthropic — Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) `[P]` — `clear_tool_uses_20250919` (`trigger` 100k, `keep` 3, `clear_at_least`, `exclude_tools`, `clear_tool_inputs`), `clear_thinking_20251015`, `applied_edits`.
4. [Anthropic — Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) `[P]` — `compact_20260112`, ≥50k trigger, `compaction` block, caching-breakpoint advice.
5. [Anthropic — Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) `[P]` — free per-model `count_tokens`; newer tokenizer ≈30% more tokens.
6. [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) `[P]` — tool-result clearing as the safest compaction; keep/drop guidance; 1–2k-token sub-agent summaries.
7. [Lessons from building Claude Code: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) `[P]` — cache-safe forking; don't change models or tools mid-session.
8. [Codex — App server](https://developers.openai.com/codex/app-server/) `[P]` — `thread/resume`, `thread/inject_items`, `thread/compact/start`, `contextCompaction`.
9. [Codex — `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md) `[P]` — discovery, one file per directory, `project_doc_max_bytes` 32 KiB.
10. [Codex — Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) `[P]` — `model_auto_compact_token_limit(_scope)`, `compact_prompt`.
11. [AGENTS.md](https://agents.md) `[P]` — the shared cross-agent instruction format.
12. [OpenCode — Rules](https://opencode.ai/docs/rules/) `[P]` — `AGENTS.md`, `instructions` config, `CLAUDE.md` fallback, `OPENCODE_DISABLE_CLAUDE_CODE`.
13. [OpenCode — Plugins](https://opencode.ai/docs/plugins/) · [SDK](https://opencode.ai/docs/sdk) `[P]` — `experimental.session.compacting`, `session.summarize`, `revert`/`unrevert`.
14. [ACP v1 — Schema](https://agentclientprotocol.com/protocol/v1/schema) · [Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) `[P]` — no memory channel; `toolCallId`; `usage_update`.
15. [ACP v2 — Session setup](https://agentclientprotocol.com/protocol/v2/session-setup) `[P]` — replay reports, never re-executes.
16. [OpenAI — Prompt caching](https://platform.openai.com/docs/guides/prompt-caching) `[P]` — `cached_tokens` / `cache_write_tokens`, 1,024-token minimum, 128-token rounding.
17. [Codex `thread/inject_items` spike](https://github.com/chenxiangning/codemoss/blob/main/docs/research/spikes/2026-07-27-s1-codex-thread-inject-items.md) `[S]` — no dedup, caller-owned ids, rollout-only read-back (codex-cli 0.144.5).
18. [Codex CLI compaction analysis](https://60ke.github.io/posts/openai-codex-context-compaction/) `[S]` — `BodyAfterPrefix` scope, 20k-token retention, handoff-summary prompt.
19. Local repository (verified in-place, 2026-09): `src/main/db.ts:16-62,137-146`.
