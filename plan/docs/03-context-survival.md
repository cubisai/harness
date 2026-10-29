## 3. Context Survival Across Model and Agent Switches: Thread/Session Identity, Handoff Seeding via `thread/inject_items` and `noReply`, and Honest Degradation Contracts

**Thesis.** Context cannot be made portable — it can only be *re-seeded*. The harness's job is therefore not to promise continuity, but to (1) own a durable, replayable transcript, (2) keep every provider's session cursor alive in parallel, (3) seed a new session through the best available native channel, and (4) tell the user precisely what did not make it across.

### 3.1 Two layers: canonical thread vs. disposable provider session

There are two distinct identities in play today, and the code conflates them. The durable layer is the canonical `threads` / `events` pair in `src/main/db.ts` (SQLite via `node:sqlite`), append-only and fully owned by us. The disposable layer is the opaque provider cursor, which `src/shared/types.ts` models as a single `sessionId: string | null` on `Thread`. That single field is the root defect: a thread can remember **one** provider's cursor at a time. `updateThread()` in `src/main/service.ts` nulls `sessionId` when the agent changes, and `send()` re-emits the same notice when `sessionId === null`. Switch Codex → Claude → Codex and the original Codex cursor is discarded even though the rollout still exists on disk under `~/.codex/sessions/**` ([Codex app-server](https://developers.openai.com/codex/app-server/)) `[P]`.

The fix is to replace `sessionId` with a bindings map on `Thread`:

```ts
type ProviderKey = string; // `${agent}:${instanceId}` — two OpenCode servers, two Codex workspaces
interface SessionBinding {
  provider: "claude" | "codex" | "acp";
  instanceId: string;              // ACP agent id, OpenCode baseUrl, Codex serviceName
  resumeCursor: string | null;     // opaque: session id / threadId / acp sessionId
  status: "active" | "stale" | "lost" | "rolled-back";
  cwd: string; configDir?: string; // cursor scope
  lastSeenAt: number; lastSeq: number;
  runtime?: unknown;               // provider-private payload (model, effort, mcp roots)
}
```

Migration: add a `bindings` JSON column to `threads`; keep `sessionId` as a read-only projection of `bindings[currentKey]` for one release, then drop it. `cwd`/`configDir` must be recorded because Claude's cursor is filesystem-scoped — transcripts live at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` ([Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)) `[P]` — and Codex rollouts live under `~/.codex/sessions/**` `[P]`.

### 3.2 Fix the event log before seeding anything

Replay is impossible if the log only contains summaries. Today `tool-use` stores `{toolUseId, name, summary}` and `tool-result` stores `{toolUseId, isError, summary}` — the arguments and outputs are thrown away. Extend `ThreadEvent`:

- `payload` — full tool input / tool result; `summary` retained as a UI-only projection.
- Stable semantic ids: `messageId`, `turnId`, `itemId`, `parentId`, alongside the existing `seq`.
- `provenance: { agent, model, provider, instanceId }` on **every** event.

Provenance is not bookkeeping — it is load-bearing. Anthropic drops thinking blocks the receiving model cannot read and enforces a prefix check against the block's `signature`; whether a block survives a switch depends entirely on which model produced it ([Anthropic preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)) `[P]`. Without per-event provenance the seeder cannot decide what to replay.

Storage caps: inline `payload` up to a threshold (e.g. 64 KB); above it write to a blob file (`blobs/<sha256>`) and store `{blobRef, bytes, truncated: true, preview}` in new `payload_ref` / `payload_bytes` columns. Events stay append-only; blobs are content-addressed and deduplicated.

### 3.3 The three switch cases

**(a) Same agent, same model — native resume.** Claude `resume` / `continue: true`; Codex `thread/resume` (schema: `threadId` required, everything else optional) ([protocol schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json)) `[P]`; ACP `session/resume`, optionally with `replayFrom: {type:"start"}` for full history replay ([ACP v2 session setup](https://agentclientprotocol.com/protocol/v2/session-setup.md)) `[P]`. Cursors survive process exit because they are files. Two caveats: ACP agents "are not required to persist every inserted user message," so replay may be partial — the canonical log, not ACP replay, remains the source of truth `[P]`; and a stale cursor must mark the binding `lost`, emit an `error`/`notice`, and fall through to case (c).

**(b) Same agent, different model.**

| Driver | Mechanism | Grade |
|---|---|---|
| Codex | `thread/resume` with `model` (+`modelProvider`); if it differs from the rollout, Codex emits a warning and applies a one-time model-switch instruction | `[P]` |
| OpenCode | per-message `model: {providerID, modelID}` on `session.prompt` — no new session | `[P]` |
| ACP | `session/set_config_option` with the `model` `configId` (category `model`) — in place, no new session | `[P]` |
| Claude | `setModel()` mid-session — but the installed SDK documents it as "only available in streaming input mode" (`sdk.d.ts:2750-2755`), and this repo's driver runs one `query()` per turn with a string prompt, so it is unreachable without a driver refactor; the per-turn path is `{resume, model}`, whose combination is **undocumented** | `[U]` |
| agy-acp | `--model` at spawn → new session + seeding | `[S]` |

A single `applyModel(target)` returns `{mode: "in-place" | "new-session" | "unsupported", reason}`; `new-session` and `unsupported` both route to (c). For Claude `[U]`, the verification harness is cheap: start a session on model A, capture `session_id`, resume with `model: B`, assert no error and read the effective model from the init `SystemMessage` / `SDKResultMessage`.

**(c) Cross-agent — export, checkpoint, seed.** Pipeline: export canonical events → build a structured handoff checkpoint → seed the new session.

Checkpoint contents: goal and decisions made; files touched (path + diffstat); commands run with exit codes and truncated outputs; open questions; artifact blob refs; workspace git state (`HEAD` sha, branch, dirty file list); provenance header. Budget: target `min(25% of destination window, ~8k tokens)`, measured with the destination tokenizer — tokens never transfer across tokenizers. (Ch. 10 §10.6–10.7 tightens this, with sources, to a 2,000–4,000-token target and a ~4k hard cap; that later figure governs.) Degrade in tiers: full checkpoint → tool-result payloads collapsed to `summary` → decisions + git state only.

Seeding channels, best first:

- **Codex — `thread/inject_items`** with `{threadId, items}`, where `items` is "raw Responses API items to append to the thread's model-visible history" and the call does **not** start a user turn ([schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json), [docs](https://developers.openai.com/codex/app-server/)) `[P]`. This is the closest thing to lossless: we emit real `function_call` / `function_call_output`-shaped items instead of prose, so tool history keeps its native shape. What we must *not* fabricate is reasoning items we never possessed.
- **OpenCode — `session.prompt({ noReply: true })`**, which returns a `UserMessage` and injects context "without triggering AI response"; the same call accepts per-message `model` ([OpenCode SDK](https://opencode.ai/docs/sdk/)) `[P]`. **Reachability caveat:** this repo drives OpenCode as a built-in **ACP** agent (`src/main/agents/registry.ts:34-40` — `opencode acp`), and the HTTP SDK is *not* the ACP wire format. The channel therefore requires a native OpenCode driver that does not exist today; **as shipped, OpenCode takes the ACP synthetic-first-message path below.** Treat `noReply` as a future upgrade, not an available mechanism.
- **Claude — no injection API exists.** Fall back to a synthetic first user message carrying the checkpoint; `systemPrompt: {type:"preset", preset:"claude_code", append: …}` may carry at most a short provenance header on the *new* session's first request — never the checkpoint a second time (that double-bills it and breaks the budget), and never on a resume (Ch. 4 §4.3c). Three hard constraints: a custom string *replaces* the default entirely and loses default tools, safety and environment context, so always use preset + `append` ([modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)) `[P]`; the system prompt is recorded on a session's first request and reused until compaction, so a later `append` is invisible on resume unless `snapshot: false`, which in turn forbids cache reuse for that request `[P]`; and because `append` lands in the system block, it sits ahead of messages in the `tools → system → messages` invalidation hierarchy ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) `[P]` — use `excludeDynamicSections: true` to keep it cacheable. See Chapter 4.
- **ACP — no client→agent injection at all.** `session/resume` and `session/load` replay *from* the agent to the client, and neither `session/new` nor `session/resume` accepts a model `[P]`. The only channel is a synthetic first `session/prompt`.

Under every channel: **never re-execute side-effecting tools.** Carry the recorded result with provenance ("produced by Codex, not re-run here").

### 3.4 Honest degradation contract

| Survives | Does not survive |
|---|---|
| Visible user/assistant text | Hidden/encrypted reasoning — unreadable thinking blocks are dropped, not rejected, and are lost for good only if the harness itself strips them ([preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)) `[P]` |
| Decisions, file diffs, command results | Prompt cache — isolated per organization and per workspace ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) `[P]` |
| Blob artifacts, git snapshot | Approvals / allow-always / cwd trust / credentials |
| Provenance metadata | Tokenizer state, native tool ids, system prompt and built-in tool set |

UI: before switching, show a confirm card generated from that table ("Codex → Claude: your last 14 tool outputs carry over; reasoning, cache and approvals do not"). After switching, persist a `notice` event carrying provenance plus the loss report — replacing today's single hard-coded line in `updateThread()`/`send()`. This is consistent with the market: no shipping product performs live cross-agent context migration; Zed's imported threads are archive entries reopened by their own agent ([Zed external agents](https://zed.dev/docs/ai/external-agents)) `[S]`, Vibe Kanban's follow-up only works within one executor ([Vibe Kanban](https://deepwiki.com/BloopAI/vibe-kanban/3.1-executor-architecture-and-configuration)) `[S]`, and Codex's own `externalAgentConfig/import` moves configuration and session *artifacts*, not a live handoff channel `[P]`.

### 3.5 Trust reset and rollback

On any agent switch, reset permission mode, allow-always rules, additional workspace roots and credentials; re-declare `cwd` explicitly on resume `[P]`. Prior approvals are retained as *evidence*, never as authorization. Before the switch, drop a git checkpoint (`harness-handoff/<seq>`); refuse to proceed on a dirty worktree unless the user commits or stashes.

Rollback must coordinate both layers. Workspace: `git checkout` the checkpoint. Provider session: Claude `forkSession` with `resume` produces a new id while the original stays untouched — it branches history, not the filesystem `[P]`; Codex `thread/fork` supports `lastTurnId`, `ephemeral`, `excludeTurns` and a `model` override `[P]`; ACP `session/fork` is still an RFD proposal rather than a stable method ([ACP RFD](https://agentclientprotocol.com/rfds/session-fork.md)) `[P]`, so when it is unavailable the driver must return an explicit `unsupported` error and offer "new session + seeding" rather than silently succeeding. Record `rolledBackFrom` on the binding for audit.

**Summary.** Canonical log in SQLite is the only truly portable asset; provider cursors are parallel, per-instance, and must all be retained; seeding is per-provider and degrades — Codex `thread/inject_items` ≈ lossless, OpenCode `noReply` ≈ clean *only if* a native driver is added (through ACP today it takes the prose path), Claude/ACP ≈ prose-in-a-first-message with real cache costs. Ship the loss report in the UI and in the thread, not in a footnote.

### 本章新增来源清单

1. [Codex App Server — Threads / resume / inject_items / fork](https://developers.openai.com/codex/app-server/) — `thread/resume` 接受与 `thread/start` 相同的配置覆盖（含 model）；`thread/inject_items` 追加原始 Responses items 且不启动 user turn；`thread/fork` 支持 `lastTurnId`/`ephemeral`/`excludeTurns`。`[P]`
2. [Codex app-server protocol v2 JSON schema](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.v2.schemas.json) — `ThreadInjectItemsParams = {threadId, items}`；`ThreadResumeParams`/`ThreadForkParams` 含 `model` + `modelProvider`；`ExternalAgentConfigMigrationItemType` 枚举含 `SESSIONS`。`[P]`
3. [OpenCode SDK — Sessions](https://opencode.ai/docs/sdk/) — `session.prompt` body 支持 per-message `model: {providerID, modelID}` 与 `noReply: true`（返回 UserMessage，仅注入上下文）。`[P]`
4. [Claude Agent SDK — Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions) — `resume` / `continue` / `forkSession`；session id 与 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 存储路径；未说明 resume 时能否改模型 `[U]`。`[P]`
5. [Claude Agent SDK — Configuration](https://code.claude.com/docs/en/agent-sdk/configuration) — `model`、`fallbackModel`、`setModel()`、`permissionMode`/`allowedTools`、`cwd` 无 setter。`[P]`
6. [Claude Agent SDK — Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) — preset+`append`（加性）vs 自定义字符串（整体替换）；系统提示词在会话首个请求被录制、`snapshot:false` 的代价、`excludeDynamicSections`、`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`。`[P]`
7. [ACP v2 — Session Setup](https://agentclientprotocol.com/protocol/v2/session-setup.md) — `session/resume` + `replayFrom:{type:"start"}` 为 agent→client 回放；`session/new`/`session/resume` 不接受 model；agent 不保证保留所有 user message。`[P]`
8. [ACP v2 — Session Config Options](https://agentclientprotocol.com/protocol/v2/session-config-options) — `session/set_config_option` 可就地改 model（`category:"model"`），无需新会话。`[P]`
9. [ACP RFD — Forking of existing sessions](https://agentclientprotocol.com/rfds/session-fork.md) — `session/fork` 仍为提案，agent 可对不支持的 fork 返回错误。`[P]`
10. [Anthropic — Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) — thinking block 靠 `signature` 回放；跨模型不可读则被丢弃而非报错；"推理永久丢失仅当 harness 自己剥离了这些 block"。`[P]`
11. [Anthropic — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — 缓存按组织/工作区隔离，从不跨组织共享；失效层级 `tools → system → messages`；dropped thinking block 导致该位置之后的缓存前缀改变。`[P]`
12. [Vibe Kanban — Executor architecture](https://deepwiki.com/BloopAI/vibe-kanban/3.1-executor-architecture-and-configuration) — follow-up 仅对同一 executor 生效，不支持跨 executor 交接。`[S]`
