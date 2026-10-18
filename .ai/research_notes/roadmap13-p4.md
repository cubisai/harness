# P4 — Context, memory and background spending: code map

Scope: read-only mapping. All citations are `path:line`. Where something is absent I say "not found" and name what I searched.

---

## P4.1 Background completions (model calls outside a user turn)

Places a model is called without a user typing in that turn:

1. **Memory extraction** (Codex/ACP agents without native memory): `createExtractor` runs a hidden one-shot after a turn. It picks `pickExtractorModel(driver.models(), delta.model)` and calls `driver.oneShot(...)` (`src/main/memory/extractor.ts:235`, `:239`), falling back once to the thread's own model (`:243`) if the cheap pick fails.
   - `pickExtractorModel`: cheapest-first name hints `["nano","mini","flash","lite","haiku","small","free","luna"]`, only within the thread model's provider; thread model kept if already cheap; lowest listed effort (`extractor.ts:30`, `:52-65`).
   - **Model picked** = a `oneShot` on the calling driver (same agent as the turn), not the dedicated background model below.
   - **Usage/cost recorded**: **no.** The extractor takes only the reply string; `oneShot` returns `Promise<string>` (`src/main/agents/types.ts:191`), and `createExtractor` has no db/budget dependency (`index.ts:996-1001` wires only `store`, `enabled`, `driverFor`). No `spend`/`spent` call exists in `extractor.ts` (searched `spend|cost|usage|budget` in that file: not found).
2. **Lesson draft** (self-improve S2): `backgroundShot(...)` on the project's *background* model (`src/main/learn/index.ts:270`).
   - `pickBackground`: explicit Settings pick (`backgroundByProject[projectId] ?? background`), else a native provider's cheap tier, else the thread agent's cheap model, else any agent's cheap model, else null (`src/main/learn/background.ts:45-65`; hint list `:22`).
   - `backgroundShot`: uses `driver.oneShot` when present (`background.ts:76-79`), else a plan-mode `runTurn` in a temp cwd with all tools denied (`:80-105`). Returns `{text, tokens}`; tokens are reported (`turn-end` input+output) or estimated at 4 chars/token (`:96`, `:110`, `:68`).
   - **Usage/cost recorded**: yes, tokens only — `deps.db.spend(projectId, day, tokens)` into `learn_budget` (`learn/index.ts:271`; `src/main/learn/db.ts:217-222`; table `src/main/db.ts:259-260`). No dollar cost is computed or stored for background work.
3. **Compaction summary** (automatic, mid-turn): `streamLlm(...)` on the turn's own route to summarise the head (`src/main/harness/driver.ts:251-268`); its usage is folded into the turn's usage (`:266`, `:445`).
4. **Handoff seed turn**: a checkpoint continuation runs a normal `driver.runTurn` with a synthetic prompt (`src/main/service.ts:474-512`).
5. **Titles**: **no model call** — `titleFrom` is a local first-line/60-char truncation (`src/main/service.ts:707`, `:1717-1724`). Searched `title` model calls: none.
6. **Lesson replay/verification**: `cachedReplay`/`saveReplay` exist (`learn/db.ts:200-208`) but have **no caller** in `src` (searched `saveReplay|cachedReplay`): not found.

**Budget/policy settings that exist:**
- `LearnSettings`: `enabledProjects`, `dailyTokens` (default 50,000), `background`, `backgroundByProject` (`src/shared/learn.ts:107-115`, `:117`).
- Enforced **only for lesson drafts**: `estimateTokens(prompt) * 2 > budgetLeft(projectId)` skips the draft (`learn/index.ts:146`, `:268`). Memory extraction has no cap.
- Sanitised on settings load/patch: clamp 1,000–5,000,000 tokens, capped project/override maps (`src/main/settings.ts:436-444`).
- `cache-policy.ts` is **prompt-cache** policy, not spend policy: it fingerprints the harness-supplied prefix and classifies cache misses (`src/main/cache-policy.ts:1-10`, `:116-131`); `COMPACT_AT`/`shouldCompact` are exported but have **no caller** in `src` (searched `shouldCompact|COMPACT_AT`).
- `LearnOverview` (with `dailyTokens`/`usedToday`/`background`) is declared (`src/shared/learn.ts:94-104`) but no IPC handler builds it; only `learn:scores` is wired (`index.ts:1015`) and the renderer calls `learnScores` (`src/renderer/src/store.ts:860`). A background-spend settings UI: not found.

**Tests that pin current behaviour:** `test/learn-capture.test.ts` (pickBackground ordering, backgroundShot token accounting, daily budget), `test/learn-scorecard.test.ts` (learn_budget per project/day, settings sanitise), `test/memory-extractor.test.ts` (extractor model pick, fallback, one-shot per debounce), `test/cache-policy.test.ts`.

---

## P4.2 Extractor dedupe and project vs global storage

**Create vs update decision:**
- The model chooses. The prompt tells it "When an index entry already covers a fact, prefer update over add." (`extractor.ts:83`) and lets only `{"ops":[]}` for nothing (`:84`).
- `parseOps` only validates: `update`/`delete` are dropped unless `existingFiles.has(file)` (`extractor.ts:124`, `:154-156`, `:163-166`); `add` has no duplicate check at all (`:145-152`). Cap 5 ops (`:137`).
- `applyOps`: `add` writes to `GLOBAL_SCOPE` when `type === "user"`, else the project (`extractor.ts:179-183`); `update` reads/writes **the project scope only** (`:185-193`); `delete` removes from the project only (`:196`).
- `existingFiles` = `store.list(projectId)` (`extractor.ts:245`), and the index shown to the model = `store.index(projectId)` (`:236`) — i.e. the **project's** `MEMORY.md`. **The extractor does not see or edit global notes.** (Contrast: the write tool below does.)
- The near-duplicate / same-name logic that exists is in the **write tool**, not the extractor: same lowercased name → update (`src/main/memory/tool.ts:190-194`); Jaccard(title+description) ≥ 0.7 → refuse and point at the file (`:195-197`); `update`/`delete` locate the note "this project first, then global" (`:203-206`).

**Paths and format:**
- Root `<userData>/memory/projects` (`index.ts:239`, `:442`); one folder per scope: `<root>/<projectId>/` (`store.ts:165-169`), global is the reserved id `"_global"` (`store.ts:23`, `:300`).
- One file per fact plus a `MEMORY.md` index, and a `.usage.json` sidecar (`store.ts:239-268`, `:219-237`).
- Frontmatter (Claude Code auto-memory format), LF: `---\nname: …\ndescription: <JSON-quoted>\nupdated: <YYYY-MM-DD>\nmetadata:\n  type: …\n---\n\n<body>` (`serializeFact`, `store.ts:96-99`); parser accepts old top-level `type:` and quoted/bare values (`parseFact`, `store.ts:66-90`). Filenames from `slugFor` (`store.ts:102-113`).

**Tests that pin current behaviour:** `test/memory-extractor.test.ts` (prefer-update is model-driven; parseOps file validation; user→global, project→project), `test/memory-store.test.ts` (format, GLOBAL_SCOPE folder, index rebuild), `test/memory-tool.test.ts` (same-name update, near-duplicate refusal, local-then-global locate), `test/memory-import.test.ts`, `test/memory-api.test.ts`.

---

## P4.3 Memory retrieval into the prompt

- `memoryPromptFor(projectId, threadId?, sessionKey?)` (`src/main/index.ts:457-466`): off → null; else `memory.ensure(...)`, `compute = () => memoryPrompt(store.blockIndex(projectId).text)`, and when a `threadId` is given the result is frozen through `memorySnapshots.get(...)` (`:462`).
- `blockIndex` (`src/main/memory/store.ts:299-338`): scopes are **global first, then project** (`:300`); header lines differ (`:314`); **ranking** = recency = `max(updated date, last-use timestamp)`, descending, ties by filename ascending (`:309-313`); **limits** per section `BLOCK_CAP = { global: 1200, project: 3600 }` (`store.ts:29`, `:316`), truncation line `- … N more (memory_read to list or search)` (`:326`, `:329-331`); input list capped by `INDEX_CAP = { lines: 200, chars: 4800 }` (`store.ts:26`).
- Wrapper adds the `<harness-memory>` instructions, including "Save preferences, corrections and facts the code doesn't show" and "Fix or delete a wrong note instead of adding one" (`src/main/memory/index.ts:11-14`).
- **"Correction" notion in memory selection: not found.** The only `correction` term in `src/main/memory` is that prompt sentence (`memory/index.ts:13`); the structured `correction` signal belongs to the learner (`src/shared/learn.ts:11-14`, `learn/index.ts:441-446`). No correction-weighted retrieval exists.
- **`memory_read` tool** (`src/main/memory/tool.ts:74-147`): with `file`, tries project then global (`:92`) and `touch`es usage (`:96`); with `query`, tokenises to words ≥2 chars, scores each note by how many query words appear (substring, lowercased) in `name + description + body`, sorts by score then filename, returns top 5 (`:103-119`); with neither, lists global then project, capped at 60 lines / 4,000 chars (`:121-141`). Default `query`/list scope order is `["global","project"]` (`:106`, `:122`).

**Tests that pin current behaviour:** `test/memory-store.test.ts` (blockIndex order, recency, caps, empty), `test/memory-tool.test.ts` (memoryPrompt overhead, read/lookup/query/caps), `test/harness-driver.test.ts` (memory enters the system prompt; frozen per session).

---

## P4.4 Pruning and compaction

**Prune** (`src/main/harness/context/prune.ts`):
- `PROTECT_TOKENS = 40_000` (newest recent messages never touched, `:12`, `:28`, `:46-50`), `MIN_SAVING = 20_000` (`:13`, `:64`).
- The newest tool message is always protected (`:34-40`, `:50`); `skill` results are never pruned (`:53`); already-pruned results skipped (`:53`); a result no longer than the marker is never counted (`:54-57`).
- **Dropped**: the result's `text` is replaced by `PRUNED_MARKER` and `imagePng` is dropped; other fields (e.g. `isError`, `name`, `callId`) survive (`:76-82`; test `harness-context-prune.test.ts:142-152`).
- Rewriting history strips signed thinking from the first cleared message on (`:86-87` → `binding.ts:21-37`).

**Does a saved-output reference survive pruning? No.** Long tool output is written to `<outputDir>/<callId>.txt` and the path is embedded **inside `r.text`** (`src/main/harness/tools/bound.ts:25-35`). Prune replaces the whole `text` with the marker (`prune.ts:81`) and `driver.shrink` calls `pruneToolOutputs(msgs)` with **no `keep` predicate** (`driver.ts:381`), so the path line is lost from the transcript. The file itself remains on disk (`bound.ts:29`).

**Compaction** (`src/main/harness/context/compact.ts`):
- `KEEP_RECENT_TOKENS = 8_000` (`:9`); `splitForCompaction` keeps the shortest suffix reaching that budget, at user turns or assistant steps after a tool batch, never cutting a tool-call from its results; an opening summary stays in the head (`:64-90`).
- `summaryPrompt` clips tool text to 2,000 chars with an "omitted from this transcript only" note (`:10`, `:145`, `:164-166`), lists touched files (≤50, `:19`, `:95-126`), and drops whole leading blocks until it fits `maxTokens` (`:205-208`).
- `compactedHistory` prepends the `<conversation-summary>` message and `unbindThinking`s the tail (`:223-227`).

**Trigger** (`src/main/harness/driver.ts`): overhead = system + tool defs (`:374`); `limit = contextSize > 0 ? max(floor(contextSize*0.75), contextSize-20_000) : null` (`:375`); `shrink` prunes first, then compacts if still over, refusing to auto-compact again until history passes `compactedAt + 20%` (`:377-391`); summary `maxTokens = contextSize*0.6` or 60,000 (`:248`). `cache-policy.ts`'s `COMPACT_AT`/`shouldCompact` (`:216-235`) are **not wired** into the driver (searched `shouldCompact`: only its own definition).

**Context-window resolution:**
- Native driver: `contextSize = provider.contextWindowOverride ?? entry.contextWindow` (`driver.ts:176`); the model list also reports `current()?.contextWindowOverride ?? m.contextWindow` (`:95`).
- Per-thread override passes through `TurnInput.contextWindow` (`service.ts:805`; type `agents/types.ts:67`) and, for Codex, becomes `model_context_window` (`agents/codex.ts:986-987`).
- Estimator: `CHARS_PER_TOKEN = 4`, flat `IMAGE_TOKENS = 1000`; `estimateText`/`estimateMessage`/`estimateMessages` (`src/main/harness/context/estimate.ts:8`, `:11`, `:13-40`). `compact.ts` keeps a private duplicate estimator (`:23-47`).

**Tests that pin current behaviour:** `test/harness-context-prune.test.ts`, `test/harness-context-compact.test.ts`, `test/harness-driver.test.ts` (auto-compact under a small window, prune “instead of compacting”, once-only, `/compact`), `test/cache-policy.test.ts`.

---

## P4.5 Memory-change delivery to a running session

- **Per-session freeze**: `MemorySnapshots.get(threadId, sessionKey, compute)` returns the stored block when `sessionKey` matches; recomputes and stores otherwise; `PENDING_SESSION` always recomputes, and the first real key adopts a pending block unchanged (`src/main/memory/snapshot.ts:16`, `:38-49`). Snapshots persist under `<root>/_snapshots/<threadId>.json` and are pruned for dead/stale (>30 days) threads (`:22`, `:65-77`, `:80-88`); startup prunes them (`index.ts:442-450`).
- `memoryPromptFor` routes through that freeze only when a `threadId` is present (`index.ts:462`).
- The native driver settles the session id **before** reading memory, so the block is frozen from the first turn (`harness/driver.ts:205`, `:221-229`). ACP/Claude and Codex pass the stored session id (`agents/claude.ts:443`; `agents/codex.ts:978-979`) and recompute only for a null id / failed resume (`codex.ts:1035`).
- `rekey()` exists (`snapshot.ts:52-57`) but has **no caller** in `src` (searched `rekey`): pending adoption happens via `get`, not `rekey`.
- **Stability within a binding**: yes — the same session key returns the byte-identical block (so a note written mid-session never changes the prompt the cache was built on; comment `index.ts:452-455`). A change reaches the session only when the session key changes (new/failed-resume session) or memory is off/on.
- **Prefix change path**: if the system prompt or tool list does change, `guardPrefix` compares `prefixKey(system, definitions)` to the session meta and, on mismatch, `unbindThinking(msgs)` from the start and re-records the key (`driver.ts:396-406`). `prefixKey` hashes system+tools (`binding.ts:40-42`); `unbindThinking` drops only Anthropic-protocol replay data (`binding.ts:14-15`, `:21-37`).

**Tests that pin current behaviour:** `test/memory-snapshot.test.ts` (same-key reuse, restart, key change recompute, pending→real adoption, rekey, prune), `test/harness-driver.test.ts:352-369` (“freezes the memory block for the life of an agent session”), `test/harness-context-binding.test.ts` (prefix unchanged keeps thinking; memory change drops it; prefixKey equality), `test/memory-api.test.ts`.

---

## Open questions

- No caller found for `LearnOverview`, lesson replay (`saveReplay`/`cachedReplay`), or `shouldCompact`/`COMPACT_AT`; whether these are intended for a later P4 phase is not determinable from the code alone.
- The memory extractor uses the *thread agent's* `oneShot`, whereas lesson drafting uses the dedicated *background* model; the two cheap-model hint lists differ (`extractor.ts:30` includes `"free"`, `background.ts:22` does not). Whether that divergence is intended is not documented.
- Memory-extraction token spend is neither capped nor recorded (only lesson drafts are); confirm that is intended.