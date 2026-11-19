# Creator Mode enhancement

**Project:** CubiQ · **Reviewed:** 2026-11-16 · **Revision:** 2, first-principles design · **Status:** proposal; implementation requires approval.

This document compares DeepSeek Harness with the current CubiQ source and proposes a clean Creator Mode plus a broader optimization roadmap. It distinguishes existing features, source-backed gaps, and improvements that still need measurements. Revision 2 replaces the earlier reuse-first recommendation: existing architecture is evidence of migration cost, not a constraint on the target design.

**Evidence boundary:** DeepSeek was inspected through its public documentation, configuration, source, and tests at commit `39163dd30f703a79079e2d2446545cff3c453738`. CubiQ was inspected in the current workspace. Neither application was benchmarked in this review. Proposed budgets are targets, not achieved results. Repository worker rules prohibited spawning research subagents, so exploration was performed directly. Application code, dependencies, and settings were not changed.

## 1. First-principles recommendation

**Build a small host-controlled capability core. Creator is a specialized agent preset over that core—not a new permission level, a visual-layout enum, or a prompt that edits internal configuration freely.**

The user outcome is: describe a capability, see a useful first result quickly, refine it, trust what it can access, install it durably, and remove or recover it without breaking the workspace. A successful implementation must deliver that entire lifecycle; a new mode label is not sufficient.

### 1.1 Requirements before implementation choices

| Requirement | Architectural consequence |
|---|---|
| Users want capabilities, not configuration syntax. | One typed operation/extension contract with previews and meaningful outcomes. |
| The model can misunderstand intent and external content can be hostile. | The host owns authorization and scope; neither prompts nor extension manifests can grant authority. |
| Useful creations should survive restart. | Versioned installation records, explicit activation and recoverable updates. |
| Users need a responsive application while tools/models run. | Bounded work, asynchronous I/O, lazy UI and cancellation propagated through owned operations. |
| Different engines expose different controls. | Adapters negotiate supported capabilities; no invented cross-engine safety guarantee. |
| More context/reasoning can increase both quality and cost. | Optimize verified task success under explicit time/token budgets, not token count alone. |
| The product must remain maintainable as capabilities grow. | Shared operation metadata generates validation, model discovery and UI descriptions; not parallel implementations per caller. |

Separate four concepts:

1. **Presentation:** conversation, canvas, preview or a future custom panel.
2. **Agent preset:** general coding, Creator or another specialized workflow.
3. **Authority:** project/scratch scope, permission mode and explicit capability grants.
4. **Task state:** objective, constraints, evidence, unfinished work and acceptance checks.

Creator changes the second concept. It does not implicitly change the others. DeepSeek's Creator preset is useful evidence for that separation; its Cordis implementation is not automatically our best implementation.

### 1.2 Target design and release boundary

- **Capability core:** typed operation registry, policy-checked invocation, deadlines/cancellation, structured outcomes and evidence. Implement only the primitives exercised by the first supported operations.
- **Extension lifecycle:** versioned manifests, staged validation, reviewed installation, revocation and recovery. Skills and connectors are the first implementations, not the permanent limit of the abstraction.
- **Creator preset:** compact instructions, on-demand capability/document discovery, and a focused creation/review workspace.
- **Agent controller improvements:** relevant context, explicit progress/verification state and bounded recovery/delegation. Host these outside persona text wherever they require deterministic behavior.
- **UI:** one coherent creation/review flow. Reuse an existing surface when it meets the interaction and performance requirements; replace it when measured usability or architectural problems justify doing so.

The first usable release supports **skills and MCP connector configurations**, with clear saved/active/failed/revoked states. Persistent sandboxed panels are a plausible next capability. Arbitrary main-process/renderer injection, a marketplace and replacement of the entire agent loop are not necessary to establish the core.

### 1.3 Architecture alternatives

These are reasoned trade-offs, not measured performance rankings.

| Option | Strength | Cost / failure risk | Decision |
|---|---|---|---|
| Mode toggle + reuse existing handlers directly | Small initial patch. | Policy, scope, evidence and activation remain scattered; UI and agent paths can diverge. | Insufficient as the target design. Useful only as an internal prototype. |
| Migrate the entire harness to Cordis | Mature composition and disposable-effect concepts; broad extensibility. | Changes boot, storage integration, transport ownership and application lifecycle; requires a substantial migration proof. | Keep as a real alternative, but not justified by the first supported capabilities. |
| Rewrite the whole product around a new framework | Maximum freedom to unify everything. | Large compatibility/reliability blast radius and delayed user value, without evidence every subsystem needs replacement. | Reject a wholesale rewrite; allow targeted replacement. |
| Small independent capability core with adapters | Central semantics, incremental migration, extensibility without exposing every internal object. | Requires disciplined operation contracts and adapter tests; some existing handlers must move or be replaced. | **Recommended.** |

Prefer the recommended core because it addresses the actual safety/lifecycle/consistency requirements with the narrowest useful architectural change—not merely because it resembles today's implementation. Revisit Cordis or another runtime if isolated executable plugins and hot-reload dependencies become a demonstrated requirement. New dependencies are acceptable when their value, failure modes and production cost are evaluated; “no new dependencies” is not a design principle.

The broader improvements in §8 remain separately reviewable work. Architectural freedom does not authorize overwriting user work, changing permissions or installing unreviewed code.

## 2. What DeepSeek Creator Mode actually does

### Current implementation

- Creator is the `cordis` agent preset in [the shipped preset configuration](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/cordis.patch.yml).
- Its persona adds one sentence: **“You help the user customize DeepSeek Harness itself.”** Detailed development instructions live in the on-demand `dsh-doc` skill, not a large always-loaded Creator prompt.
- Tools inspect the live Cordis environment. Plugin management is enabled when an editable profile exists. Standard also exposes plugin management under the same profile condition: Creator is not the exclusive owner of these capabilities.
- Packages and Loader patches install through the normal Plugin Manager. There is not a second generated-code lifecycle for the model to maintain.
- UI plugins contribute Host and Client artifacts. Registrations are lifecycle-owned and unwind when unloaded. Configuration HMR and package-code replacement are different: replacing installed package code can require a restart.
- Persistent profile mutation has an approval/full-access gate because it can load host-privileged code and affect other sessions. Selecting Creator is not itself authorization to install code.
- The [Creator persona E2E test](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/apps/web/tests/creator-persona.e2e.ts) checks that an ordinary request receives the customization intent without making tool calls. It does not prove Creator is faster than other modes.

### Ideas worth adopting

| DeepSeek pattern | CubiQ adaptation |
|---|---|
| Small persona; progressively loaded documentation | One short mode note and a compact skill router with focused references. |
| Runtime inspection before authoring | A redacted, versioned inventory of supported CubiQ operations and configuration shapes. |
| One manager owns persistence and activation | One extension lifecycle service with storage/runtime adapters; retain or replace existing stores according to their contract quality. |
| One operation, two callers | UI and agent requests reach the same validated service; authorization remains outside the agent's control. |
| Explicit extension lifecycle | Track proposal, installation, activation, failure, disablement, and recovery. |
| Stable prompt/tool catalogs | Freeze request-visible definitions during a turn and reconcile approved changes at a boundary. |
| Real workflow performance gates | Test cold/warm open, history paging, streaming while typing, cancellation, and memory separately. |

Do **not** copy its entire plugin tree, shipped tool roster, prompt text, or benchmark thresholds. Its architecture and measured workloads differ from ours.

### Cross-company frontier agent research (2025–2026)

| Lab / Ecosystem | Key agent harness mechanisms | CubiQ architectural takeaway |
|---|---|---|
| **DeepSeek** ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Cordis](https://github.com/cordiverse/cordis), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)) | Spatiotemporal plugin tree (`cordis.patch.yml`), 1-line Creator persona + `dsh-doc` progressive skill disclosure, `plugin_manager` shared operation boundary, disk KV prefix caching, and turn-local `reasoning_content` inside tool loops. | Keep Creator as a thin preset over a shared host capability/extension boundary; preserve prefix stability for high KV cache hit rates. |
| **Google DeepMind** ([ADK](https://adk.dev), [A2A Protocol](https://a2a-protocol.org), [A2UI](https://a2ui.org/), [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)) | Hierarchical workflow/subagent orchestration (ADK), Agent Cards for capability discovery (A2A), declarative JSON UI catalogs (`createSurface` / `updateDataModel` in A2UI), and mandatory `thought_signature` round-tripping on tool calls. | Use structured capability descriptors and declarative UI catalogs; preserve `extra_content.google.thought_signature` across native tool calls ([src/main/harness/llm/protocols/openai-chat.ts:31–39](src/main/harness/llm/protocols/openai-chat.ts#L31-L39)). |
| **Anthropic** ([Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), [Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [SEP-1865 MCP Apps](https://mcpui.dev/)) | Finite attention-budget discipline, 3-tier compaction (`MicroCompact` surgical tool-output clearing → `AutoCompact` → `/compact` + hot-tail), blast-radius subagents, signed thinking prefix binding, and `SEP-1865` (`ui://`) sandboxed MCP Apps. | Build on CubiQ's existing zero-token tool pruning ([src/main/harness/context/prune.ts:48–128](src/main/harness/context/prune.ts#L48-L128)) and prefix binding ([src/main/harness/context/binding.ts:21–42](src/main/harness/context/binding.ts#L21-L42)); adopt `SEP-1865` for Phase 4 sandboxed panels. |
| **OpenAI** ([Agents SDK](https://openai.github.io/openai-agents-python/), [Responses API](https://platform.openai.com/docs/guides/tools-tool-search), [Codex](https://developers.openai.com/codex)) | Stateless `reasoning.encrypted_content` replay, server/threshold compaction (`model_auto_compact_token_limit`), deferred `tool_search`, and Codex `app-server` `dynamicTools` + `exec` Code Mode. | Negotiate per-engine capabilities honestly ([src/main/agents/codex.ts:1106–1143](src/main/agents/codex.ts#L1106-L1143)) and keep host-owned operations inside CubiQ's capability core. |
| **Z.ai / Zhipu AI** ([GLM-4.6 / GLM-4.7 Thinking](https://docs.z.ai/guides/Capabilities/thinking), [GLM-4.5 ARC](https://z.ai/blog/glm-4.5)) | **Interleaved Thinking** (`Think → Act → Observe → Think`), **Preserved Thinking** (`clear_thinking: false` retaining `reasoning_content` across coding turns), AutoGLM planning-vs-grounding split, and Rumination self-critique loops. | Support opt-in preserved `reasoning_content` across turns where the provider benefits from it, and ground failure recovery in structured evidence rather than blind retries. |

### 2.4 Deep-dive by frontier AI lab: agent harness & context engineering lessons

1. **DeepSeek ([DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness), [Cordis Kernel](https://github.com/cordiverse/cordis), [Thinking Mode & Prefix Caching](https://api-docs.deepseek.com/guides/thinking_mode)):**
   - **Spatiotemporal plugin composition:** `dsh` treats every harness subsystem (model adapters, tool registries, session runners, UI slots) as a Cordis plugin that registers disposable effects. Unloading or disabling a plugin cleanly unwinds its registered tools, event listeners, and UI preview slots ([registry.ts](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts)).
   - **Router vs. Worker & Prefix Caching:** DeepSeek's API automatically caches shared prompt prefixes on disk from token 0 (delivering 90%–98% input token discounts). During a multi-step tool loop on DeepSeek R1 / V3.2 / V4, `reasoning_content` must be echoed back on assistant messages *within* the current user turn's tool loop so the model maintains its chain of thought across tool calls, then omitted on prior completed user turns so the prefix stays compact.

2. **Anthropic ([Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), [Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Claude Code / Agent SDK](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)):**
   - **Three-tier context compaction:** Claude Code structures context management into three distinct tiers:
     1. *Tier 1 — Surgical Tool-Output Clearing (`MicroCompact`):* Deterministically replaces old, bulky tool outputs (`Read`, `Bash`, `Grep`) with compact markers while keeping recent turns intact—requiring **zero LLM inference calls**. CubiQ already implements this pattern in [src/main/harness/context/prune.ts:48–128](src/main/harness/context/prune.ts#L48-L128) (`pruneToolOutputs`), including disk spill-file pointers (`savedMarker`).
     2. *Tier 2 — Threshold `AutoCompact`:* Automatically triggers summarization when the context window reaches 75%–80% capacity ([src/main/harness/driver.ts:456–485](src/main/harness/driver.ts#L456-L485)).
     3. *Tier 3 — Full Semantic Compaction with Hot-Tail & Active-File Re-grounding:* Summarizes older turns into a structured template while preserving root instructions (`CLAUDE.md` / `AGENTS.md`), frozen session memory, a verbatim **hot tail** (`KEEP_RECENT_TOKENS = 8_000` in [src/main/harness/context/compact.ts:9, 64–90](src/main/harness/context/compact.ts#L64-L90)), and explicit `touchedFiles` tracking ([compact.ts:95–126](src/main/harness/context/compact.ts#L95-L126)).
   - **Prefix-bound signed thinking:** Anthropic binds each signed `thinking` and `redacted_thinking` block to the exact cumulative prefix (`Tools → System → Messages`). Any mutation to earlier messages or tool schemas requires stripping replay signatures from the mutation point forward ([src/main/harness/context/binding.ts:21–42](src/main/harness/context/binding.ts#L21-L42)) to prevent `400` replay errors.
   - **Subagents as blast-radius boundaries:** High-volume exploratory searches run in isolated read-only subagent contexts ([src/main/harness/subagent.ts:24–33, 83–191](src/main/harness/subagent.ts#L83-L191)), returning only distilled `path:line` findings (`SUBAGENT_RESULT_CHARS = 20_000`) so the parent thread's context window is not polluted.

3. **Google DeepMind ([Agent Development Kit (ADK)](https://adk.dev), [A2A Protocol](https://a2a-protocol.org), [A2UI](https://a2ui.org/), [Gemini Thought Signatures](https://ai.google.dev/gemini-api/docs/function-calling)):**
   - **ADK & Interactions API:** Separates deterministic workflow orchestration (`SequentialAgent`, `ParallelAgent`, `LoopAgent`) from model-directed routing, while the stateful Interactions API (`previous_interaction_id`) manages multi-turn trajectory state server-side.
   - **Mandatory `thought_signature` on Function Calling:** Gemini 3 and Gemini 4 thinking models attach an encrypted `thought_signature` (`extra_content.google.thought_signature` on OpenAI-compatible streams) to tool-call parts. If the client harness strips `extra_content` when sending the assistant's `tool_calls` message back alongside tool results, Gemini rejects the turn with `400 Invalid Argument`. Fixing [src/main/harness/llm/protocols/openai-chat.ts:31–39, 112–123](src/main/harness/llm/protocols/openai-chat.ts#L31-L39) to round-trip `extra_content` is essential for Gemini 3/4 compatibility in CubiQ's native loop.
   - **A2A & A2UI:** `A2A` standardizes capability discovery via JSON Agent Cards, while `A2UI` separates declarative UI component catalogs (`createSurface` / `updateComponents`) from reactive data models (`updateDataModel`).

4. **OpenAI ([Agents SDK](https://openai.github.io/openai-agents-python/), [Responses API](https://platform.openai.com/docs/guides/tools-tool-search), [Codex App-Server](https://developers.openai.com/codex)):**
   - **Stateless encrypted reasoning & threshold compaction:** In stateless Responses API calls (`store: false`), `include: ["reasoning.encrypted_content"]` ([src/main/harness/llm/protocols/openai-responses.ts:49–55, 122–127](src/main/harness/llm/protocols/openai-responses.ts#L49-L55)) preserves reasoning continuity across tool steps without server-side state retention, while `prompt_cache_key` stabilizes prefix routing.
   - **Codex `app-server` integration:** Supports per-thread TOML subagent role generation (`codexTeamRoles` in [src/main/agents/codex.ts:140–159](src/main/agents/codex.ts#L140-L159)), client-executed `dynamicTools` on `thread/start` ([codex.ts:1138–1141](src/main/agents/codex.ts#L1138-L1141)), and scoped `model_auto_compact_token_limit` ([src/main/cache-policy.ts:251–257](src/main/cache-policy.ts#L251-L257)).

5. **Z.ai / Zhipu AI ([GLM-4.5 / 4.6 / 4.7 ARC](https://z.ai/blog/glm-4.5), [Interleaved & Preserved Thinking](https://docs.z.ai/guides/Capabilities/thinking)):**
   - **Interleaved vs. Preserved Thinking:** GLM-4.6/4.7 executes *Interleaved Thinking* before and between every tool call (`Think → Tool Call → Observe → Think`), and introduces *Preserved Thinking* (`thinking: { type: "enabled", clear_thinking: false }`), where historical `reasoning_content` blocks are retained across multi-turn coding sessions rather than stripped at turn boundaries—preventing coding-agent amnesia and improving prefix cache reuse.
   - **AutoGLM & Rumination loops:** AutoGLM separates high-level reflective task planning from low-level DOM/GUI grounding, while `GLM-Z1-Rumination` uses RL-trained self-critique when a command or test fails. This directly aligns with CubiQ's opt-in `nudges` (`REPEAT_FAIL_NOTE` and `UNBACKED_PASS_NOTE` in [src/main/harness/loop.ts:88–98, 248–253, 338–347](src/main/harness/loop.ts#L88-L98)) and background self-improvement pipeline ([src/main/learn/index.ts:1–72](src/main/learn/index.ts#L1-L72)).

## 3. Comparison with CubiQ

| Area | DeepSeek Harness | CubiQ today | Recommendation |
|---|---|---|---|
| Core architecture | Cordis plugin tree; core services are replaceable. | Electron main/preload/React renderer; typed `AgentDriver` and `HarnessTool` interfaces. | Introduce a shared host-controlled capability core; migrate existing operations behind it incrementally. |
| Creator workflow | Customization-oriented preset, documentation skill, inspection and management tools. | Chat and Design presentation/thread paths, plus expert personas; no explicit Creator preset. | Separate workflow preset from presentation and permission state. |
| Agent choice | Configurable model adapters and agent presets. | Claude SDK, Codex, ACP agents, and a native provider loop. | Preserve user model choice; report engine capability differences honestly. |
| Skills | On-demand skill catalog and documentation references. | Precedence-aware discovery, cached catalogs, per-engine delivery, mode filtering. | Reuse and extend mode scoping. |
| Connectors | MCP connections can be installed as persistent bundles. | Global/project MCP stores, vault, gateway, pooling, schema validation, tool search. | Use or replace those implementations behind consistent authorization, cancellation and activation contracts. |
| UI extensions | Live Client slots and lifecycle-managed plugins. | Built-in components, GenUI replies, artifact previews, Design canvas. | Reuse these first; sandboxed custom panels later if needed. |
| Persistence | Profile composition and installed bundles. | Local SQLite threads/events, skill folders, MCP configuration, artifact versions. | Keep data compatible, but add versioned installation/evidence state where current formats cannot represent it. |
| Prompt efficiency | Small Creator persona; documentation loaded when needed. | Stable guides, cache diagnostics, lazy tool discovery and bounded context. | Preserve ordinary-thread overhead and measure Creator's increment. |
| Reliability | Scoped approvals, lifecycle cleanup and durable session semantics. | Permissions, history repair, checks, evidence notices, watchdogs and managed shells. | Strengthen specific gaps; do not duplicate working machinery. |
| Visual creation | Can author a plugin displayed in the harness. | Mature Design mode with editing, variants, comments, exports and handoff. | Leave Design intact. Creator can propose an extension, not replace its canvas. |

### Local evidence and integration traps

- [src/shared/types.ts:463](src/shared/types.ts#L463), [501–502](src/shared/types.ts#L501-L502): `ThreadKind` is currently `chat | design` and determines whether a canvas opens. Creator is a workflow preset, so extending this presentation discriminator is not the recommended domain model.
- [src/main/db.ts:875](src/main/db.ts#L875), [src/main/db.ts:1179](src/main/db.ts#L1179), and [src/main/index.ts:2038](src/main/index.ts#L2038): existing kind conversion/import/creation is two-way. Introduce and persist preset identity separately, including import/export/resume; do not silently map it through these branches.
- [src/main/service.ts:283–297](src/main/service.ts#L283-L297): thread creation already supports an isolated folder for the built-in Chats project. Design alone receives forced Full permission; Creator must not inherit that branch.
- [src/main/guide.ts:69–119](src/main/guide.ts#L69-L119): guides are read through an mtime cache and assembled from bundled, user, and project layers.
- [src/main/skills/sources.ts:43–124](src/main/skills/sources.ts#L43-L124): existing discovery/cache/filtering can support Creator without another skill registry. Current filtering understands only Design-only skills.
- [src/main/index.ts:447–468](src/main/index.ts#L447-L468): generated skill delivery keys currently distinguish cwd and Design. Include the resolved preset/catalog revision to prevent delivery collisions across workflows.
- [src/main/index.ts:653–788](src/main/index.ts#L653-L788): tool composition and transport adapters are already centralized; all delivery paths need consistent Creator scoping.
- [src/main/index.ts:1688–1727](src/main/index.ts#L1688-L1727): skill creation and MCP mutations currently live in UI IPC handlers. They must move behind the same operation boundary as agent callers; extracting a function alone is not an authorization contract.
- [src/main/agents/types.ts:34–42](src/main/agents/types.ts#L34-L42) and [src/main/harness/tools/types.ts:54–67](src/main/harness/tools/types.ts#L54-L67): app/native tools describe policy differently. Scheduling effect is explicitly not permission. Normalize descriptors at the boundary without trusting extension-provided safety labels.
- [src/main/mcp/servers.ts:123–303](src/main/mcp/servers.ts#L123-L303): reuse persistence, secret handling and scope precedence rather than let agents edit raw app configuration.
- [src/renderer/src/App.tsx:40–41](src/renderer/src/App.tsx#L40-L41): the Design canvas is already lazily loaded. Creator should not mount it.
- [src/renderer/src/sections.ts:29–55](src/renderer/src/sections.ts#L29-L55), [src/renderer/src/components/PaneRail.tsx:8–20](src/renderer/src/components/PaneRail.tsx#L8-L20), and [src/renderer/src/App.tsx:110–115](src/renderer/src/App.tsx#L110-L115): `inboxModel` and `ModeToggle` currently filter visible sidebar threads by binary `ThreadKind` (`if (kind && !live && threadKind(t) !== kind) continue`). Storing Creator as `agentPreset: "creator"` while keeping `kind: "chat"` requires updating `inboxModel` and `useStore` to filter by a 3-way workspace mode (`chat | design | creator`) so Creator threads and ordinary Chat threads do not mix in the sidebar.
- [src/main/preview/host.ts:14–19](src/main/preview/host.ts#L14-L19): Office previews already have a 25 MiB input cap, 10-second timeout, bounded cache and lazy utility process. Preserve this behavior.
- [src/main/design/kit-install.ts:397–529](src/main/design/kit-install.ts#L397-L529): kit installation demonstrates staging, validation, hashing and atomic activation. It is kit-specific and deletes an older version; it is not already a general extension/rollback manager.
- [src/main/browser/tools.ts:33–58](src/main/browser/tools.ts#L33-L58) and [src/main/db.ts:79–83](src/main/db.ts#L79-L83), [600–700](src/main/db.ts#L600-L700): `TargetLock` already provides promise-chained mutation serialization with per-thread active-turn ownership, and `Store.writeBlob` / `readBlob` already provides a content-addressed SHA-256 `blobs` store with automatic 64 KiB `payload_ref` offloading and `pruneBlobs()` garbage collection. Reuse both primitives in the capability core and extension lifecycle manager.

### 3.1 Multi-driver & subsystem architecture matrix in CubiQ

| Dimension | Claude SDK ([src/main/agents/claude.ts](src/main/agents/claude.ts)) | Codex App-Server ([src/main/agents/codex.ts](src/main/agents/codex.ts)) | ACP Driver ([src/main/agents/acp/driver.ts](src/main/agents/acp/driver.ts)) | Native Harness ([src/main/harness/driver.ts](src/main/harness/driver.ts)) |
|---|---|---|---|---|
| **Tool & MCP delivery** | In-process SDK MCP server `"cubiq"` ([claude.ts:109–131](src/main/agents/claude.ts#L109-L131)); user MCP servers passed via `forClaude(servers)` ([claude.ts:134–136](src/main/agents/claude.ts#L134-L136)); `run_code`, `todowrite`, shells, and `design_*` marked `{ alwaysLoad: true }`. | Loopback HTTP MCP (`?p=&d=&c=&s=`) + top-level client `dynamicTools` on Codex 0.159+ ([codex.ts:1106–1141](src/main/agents/codex.ts#L1106-L1141)); user servers in `threadConfig.mcp_servers`. | Loopback HTTP MCP (`/mcp`, `/mcp-skills`, `/mcp-routed`) with URL flags ([acp/driver.ts:987–1012](src/main/agents/acp/driver.ts#L987-L1012)); routes user MCP servers behind `search_tools` / `call_mcp_tool` when `mcpRouted` is true. | In-process `LoopTool[]` ([driver.ts:355–412](src/main/harness/driver.ts#L355-L412)); `withBrowserOnDemand` collapses `autoAllow` browser tools; `deps.mcpTools(projectId)` adds `search_tools` / `call_mcp_tool`. |
| **Skills delivery** | Generated plugin directory (`ensurePlugin` in `harness-plugin/<skillsKey>`) skipping `~/.claude/skills` and `<cwd>/.claude/skills` ([index.ts:458–471](src/main/index.ts#L458-L471)). | Extra skills root directory (`harness-skills/<key>`) skipping `.agents/skills` and Codex-covered plugins ([index.ts:803–815](src/main/index.ts#L803-L815)). | Either `skillsDirEnv` extra root or `/mcp-skills` `skill` tool depending on `capabilities.skillsDelivery` ([index.ts:776–778](src/main/index.ts#L776-L778)). | In-process `skillLoop` tool (`skillTool`) built per `(cwd, design, threadId)` ([driver.ts:357–358](src/main/harness/driver.ts#L357-L358)). |
| **Prefix stability & memory freeze** | `systemAppend` ordered stably (`guide`, `TODO_HINT`, `expert`, frozen `memoryPromptFor`, `CODE_HINT`); mid-session memory changes arrive via `memoryUpdateFor` ([claude.ts:589](src/main/agents/claude.ts#L589), [index.ts:527–559](src/main/index.ts#L527-L559)). | Memoizes `signature = JSON.stringify(threadConfig)` ([codex.ts:1145–1165](src/main/agents/codex.ts#L1145-L1165)); freezes initial `sentMemory` per session and sends `memoryUpdateFor` deltas. | Memoizes `mcpSignature` ([acp/driver.ts:1078–1093](src/main/agents/acp/driver.ts#L1078-L1093)); sends `guide`, `expert`, and `memory` only on first turn (`guidePending`, [acp/driver.ts:1359–1372](src/main/agents/acp/driver.ts#L1359-L1372)), currently dropping later `memoryUpdateFor` deltas. | Hashes `(system, definitions)` via `prefixKey` ([binding.ts:40–42](src/main/harness/context/binding.ts#L40-L42)); calls `unbindThinking` when prefix changes ([driver.ts:490–500](src/main/harness/driver.ts#L490-L500)). |
| **Compaction** | SDK `/compact` + `"compact_boundary"` event listener ([claude.ts:916–925](src/main/agents/claude.ts#L916-L925)). | RPC `thread/compact/start` + `"thread/compacted"` notification ([codex.ts:720, 1351–1371](src/main/agents/codex.ts#L1351-L1371)). | `/compact` via `session/prompt` when `capabilities.manualCompact` is true ([acp/driver.ts:1399–1417](src/main/agents/acp/driver.ts#L1399-L1417)). | Two-stage `shrink`: zero-token `pruneToolOutputs` ([prune.ts:48–128](src/main/harness/context/prune.ts#L48-L128)) then LLM `splitForCompaction` + `summaryPrompt` ([compact.ts:64–228](src/main/harness/context/compact.ts#L64-L228), [driver.ts:458–485](src/main/harness/driver.ts#L458-L485)). |
| **Subagents & teams** | SDK `options.agents` with `disallowedTools: ["Skill"]` and `parent_tool_use_id` routing ([claude.ts:626–633, 944](src/main/agents/claude.ts#L626-L633)). | Per-thread TOML roles (`codexTeamRoles`) + `TurnState.children` tracking ([codex.ts:140–159, 530–566](src/main/agents/codex.ts#L140-L159)). | OpenCode `task` / `subagent_type` mapped to `Agent` rows ([acp/driver.ts:1682–1685](src/main/agents/acp/driver.ts#L1682-L1685)). | `createTaskTool` (`task`) running isolated `runLoop` over `read`/`glob`/`grep` (+ `team_*` tools and per-member `routeFor` in team threads) ([subagent.ts:83–191](src/main/harness/subagent.ts#L83-L191)). |
| **Permission gates** | `SDK_MODE` (`default`, `acceptEdits`, `plan`, `bypassPermissions`) + `canUseTool` (`ExitPlanMode`, `AskUserQuestion`) + `PreToolUse` guard hook ([claude.ts:170–175, 636–675](src/main/agents/claude.ts#L170-L175)). | `codexPolicy` (`approvalPolicy` + `sandbox`) + RPC `commandExecutionRequest` / `fileChangeRequest` interception + `guardScript` ([codex.ts:170–185, 840–955](src/main/agents/codex.ts#L170-L185)). | `pickPermission` + `decidePluginAsk` over ACP permission notifications + OpenCode guard plugin ([acp/driver.ts:200–236](src/main/agents/acp/driver.ts#L200-L236)). | `decide(mode, tool.access, outside)` ([permissions.ts:11–23](src/main/harness/permissions.ts#L11-L23)) + `fenceWrite`/`fenceCommand` in Design threads ([driver.ts:430–451](src/main/harness/driver.ts#L430-L451)). |

## 4. Proposed user experience

### Entry and layout

- Add **Creator** beside the existing Chat and Design choices. Do not rename Chat to Code as unrelated cleanup.
- Replace the narrow/collapsed sidebar's two-way toggle with an accessible three-option menu using the existing menu component.
- Selecting Creator selects/starts a thread with the Creator preset and a conversation-oriented default presentation. It does not silently mutate a running session's persona or permission state.
- Use one transcript/Composer and a lazy capability preview/review surface. Existing components are implementation candidates, not immutable boundaries. Add an editor only if direct editing proves important enough to justify its bundle, accessibility and maintenance cost; do not ship a second editor merely for visual parity.
- Empty-state actions: **Create a skill**, **Add a connector**, **Improve CubiQ**. They insert a concise prompt rather than immediately install or execute anything.
- With no project, explicitly start a Creator thread in the existing Chats scratch area. Project-scoped installation needs a real selected project; scratch/global capability installation needs an explicit global-scope choice.
- “Improve CubiQ” asks the user to choose its source checkout. Never patch the packaged application, infer a writable installation path, or treat the current unrelated project as CubiQ source.

### Creation flow

```text
User request
  → inspect supported capabilities / load relevant documentation
  → author a useful first draft in an isolated scope, if its permissions allow
  → validate, exercise allowed checks and submit a structured proposal
  → show scope, file/config diff, permissions, and activation impact
  → user approves installation
  → install through shared services
  → activate at a safe catalog boundary
  → verify the capability's actual use and report saved state separately from active state
```

Use one compact review card, not a wizard. Show name/version, Project or Global, relevant permissions, preview/diff, and **Install** / **Reject**. Errors stay visible with a retry action. The Library remains the place to view, disable, or revert installed capabilities.

## 5. Target architecture and data flow

```text
Presentation: conversation / canvas / capability preview
                 │
Agent preset + task context → engine adapter → capability discovery
                 │                              │
                 └──────── requested operation ─┘
                                │
             HOST: validate → authorize → schedule → invoke
                                │
           tool/MCP executor OR extension lifecycle manager
                                │
                   approved storage/runtime adapter
                                │
                 structured outcome + evidence + events
```

The host controls the capabilities it mediates. An external engine's native shell/filesystem tools are not automatically inside this boundary; see §5.6. Do not claim a single universal kernel magically confines every engine or MCP process.

### 5.1 Separate preset identity from presentation

Add a versioned `agentPreset` identity to a thread, independent of the existing presentation-oriented `kind`. Initial presets are `general` and `creator`; existing threads resolve to the general preset. A practical storage migration adds `preset_id` and `preset_revision` columns, with import/export and session-binding support. Do not expand `ThreadKind` merely to encode a new agent purpose.

Resolve the preset to an immutable session definition: persona, eligible skill/capability catalog, default view and optional task policy. It cannot grant permission. Carry the resolved preset/context through `TurnInput`, `SeedRequest`, Claude, Codex, ACP and the native provider driver. UI mode selection maps to presentation + preset without leaking that combination into every backend branch.

Persist the referenced definition revision. If an imported/resumed preset is unavailable or incompatible, show an explicit notice and require a compatible choice; do not silently load different instructions or grant its capabilities. A deliberate preset switch reconciles at a boundary or starts a new engine binding when necessary.

Use a short Creator note plus on-demand documentation. Generate public operation names, schemas and permission descriptions from the capability registry so skill text cannot quietly drift from executable APIs. Human-authored procedural references stay separate. Suggested router/reference budgets remain 2,000/8,000 characters, with a measured reason for exceptions rather than blind truncation.

Preserve native-skill deduplication and private expert skills when they satisfy the new catalog contract. Key delivery by resolved preset revision and relevant catalog revision as well as workspace/presentation. Ordinary threads receive no unsolicited Creator guidance.

### 5.2 One operation descriptor and invocation boundary

An operation descriptor supplies:

- Stable namespaced ID, descriptor version, input/output schemas and short discoverability text.
- Host-owned authorization requirements and scope resolver. Requested permissions in a manifest are declarations, not grants.
- Scheduling effect and ownership/conflict key, distinct from authorization. “Read-only” metadata from a third-party server is not enough to auto-allow it.
- Deadline, cancellation support and bounded output policy.
- Retry/idempotency semantics and whether a failed or timed-out outcome can be partial/unknown.
- Executor and structured evidence hooks.

UI IPC, native-loop calls and MCP/engine adapters invoke the same boundary. Resolve caller/thread/project identity authoritatively, validate inputs, check current authority, reserve the appropriate execution resource, propagate Stop/deadline, then publish a typed outcome. User-only approval operations cannot be invoked through a model-facing adapter.

Useful operation outcomes are `succeeded`, `failed`, `cancelled`, `partial` and `unknown`, with duration, safe output, operation identity and provenance. A timeout cannot prove an external side effect did not happen. Retry only when the operation is safe or an idempotency/reconciliation contract establishes the previous outcome.

Maintain stable request-visible catalog snapshots for efficient inference. **Check permission/revocation live on every invocation**, even while an old descriptor remains in that snapshot. Cache stability must never delay revocation.

### 5.3 Extension lifecycle, not Creator-specific installation hacks

Proposed ownership, to be split only where implementation needs it:

| Module boundary | Responsibility |
|---|---|
| `src/main/capabilities/registry.ts` | Versioned public operation descriptors and bounded discovery snapshots. |
| `src/main/capabilities/invoke.ts` | Validation, current policy, scheduling, cancellation and typed outcome/evidence. |
| `src/main/extensions/manifest.ts` | Supported versioned extension payloads and containment checks. |
| `src/main/extensions/manager.ts` | Staging, reviewed installation, activation, revocation, update and recovery through adapters. |
| Creator adapters/guidance | Thin preset-specific discovery/proposal tools and procedural references. No separate installer. |

These paths are proposed, not existing APIs. Keep the core small; do not prebuild unused provider factories, plugin dependency graphs or a general-purpose event framework.

The first manifest has common identity, version, host compatibility, scope, explicit file/content references, expected-current revision, requested permissions and digest. Its payload union initially supports:

- **Skill:** guidance and bounded inert reference/template files. Skill instructions still require trust; installation does not execute scripts or bypass later tool policy.
- **Connector:** validated transport configuration and vault/environment secret references. A local stdio command is executable host code, not harmless JSON.

Later payloads can add a preset/resource pack or sandboxed panel with a tested adapter and explicit compatibility rules. Do not ship unused kinds or arbitrary JavaScript fields in the first manifest.

The agent can inspect and submit a validated proposal, but cannot approve installation. Start with compact `creator_inspect` / `creator_propose` adapters. The installer consumes a host-recorded approval tied to exact scope, digest, destination and grant request, regardless of whether a UI or later authorized tool initiated the request. Installation and test execution may share one clearly scoped user review when all effects are disclosed; avoid redundant prompts that do not change authority.

Plan mode permits inspection and the existing plan-review flow, not workspace writes or persistent installation/proposal mutation. Enforce this in the host boundary, not only in guide text.

### 5.4 Persistence and recovery

Preserve user data compatibility, not every internal storage API. Existing skill/MCP/vault stores can serve as adapters where they support validation, revision checks and recovery. Replace or refactor handlers that cannot meet those semantics; do not maintain both an old unsafe path and a new guarded path for the same mutation.

Persist installation/revision/operation records in a transactional host store, with immutable payload content or content-addressed references. Journal before applying; revalidate the reviewed digest/revision; publish activation after staging succeeds. Serialize conflicting scope mutations and deduplicate repeated approval/Install requests.

Filesystem, vault and subprocess effects cannot be made atomic merely by putting a SQLite row in a transaction. Use explicit preparation/commit/reconciliation states, scoped compensating actions and restart recovery. Store no plaintext secret backups. Secret-bearing rollback needs vault-owned recovery or explicit credential re-entry.

Retain one usable previous revision for a recoverable update, subject to a bounded storage policy. Reject a rollback that would overwrite external edits. An installation record must distinguish saved configuration, active runtime, revoked authority and verified usability.

### 5.5 Catalog activation versus authority revocation

- New definitions and persona/catalog changes become visible at a safe turn boundary. Some engines need a deliberate session rebuild; disclose that cost.
- A disabled/revoked capability immediately denies new invocations and cancels affected owned work where supported. Do not wait for the next turn to withdraw permission.
- Scope impact is explicit: Project versus Global, including other affected sessions.
- State can be staged, saved, awaiting sign-in, active, failed, revoked or pending-restart. A config write is not evidence that a connector works.
- Verification executes only within an existing or newly approved grant. OAuth/credentials remain user-controlled.
- Cleanup releases only resources owned by that installation, respecting concurrent shared-client leases. Uninstalling must not kill another project's request or erase unrelated files.

### 5.6 Engine and runtime guarantees

Normalize harness-owned operations across engines, but negotiate what each engine actually supports: plan enforcement, per-call interception, cancellation, live schema changes, structured events and session seeding. Missing guarantees must be visible. A Creator installation operation can stay fully host-controlled even when the external engine's general shell is not.

Native tools provided by an external engine may access the host according to that engine's own sandbox/policy. A spawned MCP server can also act outside a tool request. **Process separation is fault containment, not a security sandbox.** Require explicit executable-code trust or real OS-level confinement; otherwise describe the capability as unsandboxed and restrict supported workflows rather than claiming least privilege was enforced.

Use the native provider loop as the first fully instrumented reference implementation, and adapter contract tests for Claude/Codex/ACP. Do not replace users' preferred engines just to make the abstraction appear uniform.

### 5.7 Concrete TypeScript contracts and SQLite schema additions

```ts
export type AgentPresetId = "general" | "creator";
export type WorkspaceMode = "chat" | "design" | "creator";

/** Authoritative operation contract registered in src/main/capabilities/registry.ts. */
export interface OperationDescriptor<In = Record<string, unknown>, Out = unknown> {
  id: string;
  version: number;
  summary: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Permission class evaluated by permissions.ts; never inferred from third-party annotations. */
  access: "read" | "edit" | "shell" | "web" | "install-review";
  /** Scheduling behavior used by loop.ts, code-broker.ts, and TargetLock. */
  scheduling: { effect: "read" | "mutate"; conflictKey?: (args: In) => string };
  timeoutMs: number;
  idempotent: boolean;
}

/** Staged Creator proposal backed by Store.writeBlob (src/main/db.ts:640) content-addressed digests. */
export interface ExtensionProposal {
  proposalId: string;
  threadId: string;
  scope: { kind: "project"; projectId: string } | { kind: "global" };
  expectedBaseRevision: string | null;
  manifest:
    | {
        kind: "skill";
        name: string;
        description: string;
        mode?: "all" | "design" | "creator";
        files: { relPath: string; sha256: string; bytes: number }[];
      }
    | {
        kind: "connector";
        name: string;
        spec: McpServerSpec;
        envRefs: string[];
      }
    | {
        kind: "panel";
        name: string;
        /** SEP-1865 MCP Apps resource URI (ui://<server>/<panel>), mounted in an opaque-origin sandboxed iframe. */
        resourceUri: `ui://${string}`;
        allowedOperations: string[];
      };
  digest: string;
  status: "staged" | "approved" | "installed" | "active" | "rejected" | "failed" | "revoked";
}
```

In [src/main/db.ts:99–150](src/main/db.ts#L99-L150), the additive SQLite migration adds:

```sql
ALTER TABLE threads ADD COLUMN preset_id TEXT NOT NULL DEFAULT 'general';
ALTER TABLE threads ADD COLUMN preset_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS extension_installs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,           -- 'global' | 'project:<id>'
  kind TEXT NOT NULL,            -- 'skill' | 'connector' | 'panel'
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,          -- sha256 in blobs table
  prev_digest TEXT,              -- previous active revision for safe revert
  state TEXT NOT NULL,           -- 'staged' | 'saved' | 'active' | 'failed' | 'revoked'
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, kind, name)
);
```

And in [src/renderer/src/sections.ts:29–55](src/renderer/src/sections.ts#L29-L55), `workspaceModeOf(thread)` resolves `thread.kind === "design" ? "design" : thread.agentPreset === "creator" ? "creator" : "chat"`, allowing `inboxModel` and `ModeToggle` ([src/renderer/src/components/PaneRail.tsx:8–20](src/renderer/src/components/PaneRail.tsx#L8-L20)) to filter Chat, Design, and Creator threads cleanly without overloading `ThreadKind`.

## 6. Security and lifecycle

1. **Preset is not authority.** Creator retains the user's chosen permission mode, with Plan available. Installation review is still required in v1, even for a Full-access thread. Explicitly authorized scope is independent of a model's persona or confidence.
2. **Installation approval is user-only.** No tool, GenUI action, imported skill, replayed message or external page can authorize itself.
3. **Main validates identity and scope.** Resolve project/thread destinations from authoritative records, not model-supplied absolute paths. Validate the IPC sender as well as tool context; an iframe/browser page must not reach installer IPC.
4. **No arbitrary main-process or renderer imports.** Skill content is instructional, not inherently safe. MCP commands can run host-privileged code. Separate integrity (what bytes were approved), provenance (where they came from) and authority (what they may do); a content hash or signature establishes neither safety nor an OS sandbox.
5. **Contain and bound drafts.** Check real paths, symlinks, archive entries if archives are later supported, file count, total bytes, and review digest before installing. Reject unknown schema versions and reserved IDs.
6. **No hidden downloads or setup scripts.** A local draft install is local. Package download, network connection and subprocess execution require disclosed authorization; one explicit scoped review can cover the listed effects without repetitive permission prompts.
7. **Keep secrets in the vault.** Inventory, tool results, previews, logs, events and recovery records contain only redacted descriptors.
8. **Deny by default; revoke immediately.** Approving one installation does not change the thread's permission mode, disable a guard or approve unrelated later calls. Unknown operations/grants are denied. Capability revocation takes effect at invocation time even if catalog text remains cached for the running turn.
9. **Recover from partial failure.** Journal before applying; validate/stage before publishing; compensate or report partial state when skill/MCP/vault operations cannot share one transaction. Test interruption and restart at each stage.
10. **Do not overwrite user work.** Detect name/revision collisions and external edits. A revert fails safely on conflicts and offers a diff; it never discards unrelated changes.

Suggested starting v1 limits, to validate during implementation: 64 files and 2 MiB total per local skill draft; 128 KiB per guidance file; 64 KiB per connector proposal. These are new proposed limits, not existing CubiQ constants.

Optional custom panels later must use an opaque-origin sandbox with no Node, preload, credential access or unrestricted IPC, aligning with the emerging **[SEP-1865 (MCP Apps / MCP-UI)](https://mcpui.dev/)** standard (`_meta.ui.resourceUri` pointing to a `ui://` resource hydrated by MCP `structuredContent` over a narrow JSON-RPC `postMessage` bridge) rather than inventing a proprietary panel protocol. The host renders grants, approval controls and trusted status outside the panel so generated content cannot impersonate authorization. Any action bridge needs an allowlisted schema, authenticated frame identity and authoritative scope checks. Choose an existing GenUI/artifact/Design surface when it meets the task; add a persistent panel when its lifecycle and interaction requirements warrant one.

## 7. Performance strategy and acceptance criteria

### Minimize critical-path work, not architecture change

- Opening Creator needs no model call, connector probe or background worker. Any new framework/editor/runtime must justify its measured cold/warm and maintenance cost; avoid an eager dependency just to display a mode choice.
- Lazy-load the Creator review/detail surface. Keep its unopened state out of the renderer's heavy dependency graph.
- Ordinary Chat/Design threads receive zero Creator-specific instruction/catalog/tool additions.
- Start Creator with one short note, compact catalog summaries and a small management surface. Minimize required round trips, not the number of tools at any cost: two tools are an initial design, not an inviolable cap. Generate discoverable operation schemas and fetch detailed documentation/inventory on demand.
- Cache inventory by approved configuration revision. Publish bounded immutable snapshots and subscribe only while the relevant surface is open.
- Keep or replace transport pooling, preview workers and transcript windowing according to measured behavior. Correct resource leases and cancellation matter more than preserving a particular class. Do not eagerly probe every connector when the mode opens.
- Preserve event ordering: batched visual deltas must flush before their durable terminal event. Mode switching must not remount a running Composer/transcript unnecessarily.

### Proposed gates

Calibrate on a recorded reference machine and a fixed built-app fixture before enforcing timing gates in CI.

| Metric | Initial target / invariant |
|---|---|
| Ordinary-thread context | Byte-for-byte unchanged Creator-related prefix and tool/catalog contents. |
| Creator note + catalog summary | At most 150 estimated tokens, excluding requested documentation. |
| Creator management schemas | At most 600 estimated tokens total; report actual serialized size. |
| Warm mode selection to editable Composer | p95 ≤150 ms with the shell already loaded; exclude model/network time. |
| Unopened Creator dependency cost | No eager heavy renderer import; record any incremental dependency/build/startup cost and justify it. |
| Local bounded proposal validation | p95 ≤100 ms on the reference fixture; isolate filesystem/worker time from painting. |
| Connector cancellation | UI settles within 250 ms of Stop; pending request cancelled where supported; owned child cleanup ≤2 s in the fixture. |
| Streaming while typing | p95 input-to-next-paint ≤100 ms; no Creator-induced main-thread task >50 ms in the bounded fixture. |
| Long session | Exercise 250 settled turns plus active output, history paging, and mode switching; compare DOM/heap and open latency against baseline. |
| Lifecycle soak | 20 open/close and install/disable/revert cycles; no leftover owned process/listener/watch; post-GC heap delta ≤10% after warm-up on the fixed fixture. |
| Prompt cache / revocation | Zero unexplained Creator-induced prefix changes in deterministic tests; revocation is immediate despite frozen discovery text. Report real provider cache data separately. |

Use at least 30 warm interaction samples for p95. Use multiple fresh processes for cold/heap tests and report raw results. Do not compare DeepSeek's published endpoint times with ours as if they used the same hardware and observer.

These numerical targets are provisional engineering hypotheses. Set supported reference hardware/workloads and calibrate before making them release promises. Also require no unexplained regression in ordinary-task correctness or end-to-end completion time. Improve **cost per verified successful task**, not just cost per model request; a cheap retry loop can be more expensive than one stronger request.

Measure latency as separate components: **local preparation → provider first output → visible reply → completed tools/checks**. A faster renderer does not make a remote model think faster; token savings do not establish task-quality gains.

## 8. Broader harness enhancement roadmap

“Smarter” means more grounded correct completions at a reasonable token/time cost—not longer prompts, universally higher reasoning, or more subagents. Keep working mechanisms because they satisfy a requirement; replace mechanisms whose contracts prevent correctness, observability or efficient execution. A stronger architecture is not necessarily a larger one.

### 8.1 Source-backed optimization candidates

These code paths are confirmed by inspection. Their frequency, user impact and performance gain remain unmeasured; add focused reproduction/profiling before treating them as production defects.

| Priority | Finding and evidence | Proposed enhancement | Proof required |
|---|---|---|---|
| P0 | App/native tool metadata has different policy shapes; the native `other` category is permitted before mode checks: [src/main/harness/permissions.ts:11–17](src/main/harness/permissions.ts#L11-L17). This is a contract-design concern, not evidence every current `other` tool is unsafe. | Authoritative operation descriptors; explicitly classify trusted control-plane actions; deny unknown operations/privilege requests instead of treating an unclassified category as safe. | A newly registered/unclassified mutation cannot execute in Plan or gain access merely by claiming a read-only effect. Approval actions stay user-only. |
| P0 | MCP router accepts `ctx`, but listing/call operations do not forward its signal: [src/main/mcp/router.ts:244–246](src/main/mcp/router.ts#L244-L246), [310](src/main/mcp/router.ts#L310). The pool has timeouts but no caller signal: [61–80](src/main/mcp/router.ts#L61-L80). | Carry turn cancellation through discovery, connection and calls; track in-flight usage so idle sweeping cannot close an active call. Handle shared-client cancellation without killing unrelated calls. | Stop a slow tool during connect/list/call; preserve another session's concurrent request; no late result or leaked child. |
| P0 | Checks keep all stdout/stderr in `output`, then trim only at completion: [src/main/check.ts:61–92](src/main/check.ts#L61-L92). | Bounded rolling tail; stream optional full logs to a size-capped file; explicit truncation and cleanup. | Feed a large synthetic log; memory stays bounded, final failure lines and exit/timeout behavior remain correct. |
| P0 | Service turn-evidence tracking checks `event.name === "Edit"`: [src/main/service.ts:1008–1012](src/main/service.ts#L1008-L1012), while the Native Harness's `writeTool` emits `displayName: "Write"` ([src/main/harness/tools/write.ts:13](src/main/harness/tools/write.ts#L13), [src/main/harness/loop.ts:283](src/main/harness/loop.ts#L283)) without passing through `canonicalTool` ([src/shared/tools.ts:17–21](src/shared/tools.ts#L17-L21)). | Normalize `event.name` via `canonicalTool(event.name) === "Edit"` (or emit canonical display names in `loop.ts`) so file creations/overwrites in the Native Harness are recorded in `editIds` and `editDiffs`. | A Native Harness turn that creates or overwrites a test or source file via `writeTool` triggers `turnEvidence` and `learner.afterTurn` `changed` tracking identically to `editTool`. |
| P0 | `openai-chat.ts` drops `extra_content` (`thought_signature`) on tool calls and replays `reasoning_content` on every historical assistant turn: [src/main/harness/llm/protocols/openai-chat.ts:30–39](src/main/harness/llm/protocols/openai-chat.ts#L30-L39), [112–123](src/main/harness/llm/protocols/openai-chat.ts#L112-L123). | Preserve opaque tool-call `extra_content` (required by Google Gemini 3/4 `thought_signature` to avoid `400 Invalid Argument`), and scope `reasoning_content` replay to the active turn's tool loop by default while supporting opt-in multi-turn preserved thinking (`clear_thinking: false` for Z.ai GLM-4.7). | Multi-step tool calls on Gemini 3/4 over OpenAI-compatible endpoints succeed with `thought_signature` intact; DeepSeek and GLM-4.7 tool loops each receive their expected `reasoning_content` shape. |
| P1 | Streaming visibility calls `trim()` on accumulated item text: [src/renderer/src/live.ts:86–104](src/renderer/src/live.ts#L86-L104). DeepSeek documents a comparable incremental-visibility optimization. | Cache whether an item has visible text; update from incoming deltas, recompute on replacement/tail truncation and settlement. | Ordinary and leading-whitespace text/reasoning fixtures; unchanged first-visible behavior and fewer scanned characters. |
| P1 | Compaction repeatedly slices and estimates suffixes: [src/main/harness/context/compact.ts:79–89](src/main/harness/context/compact.ts#L79-L89); transcript fitting repeatedly rebuilds joined text: [190–216](src/main/harness/context/compact.ts#L190-L216). | Precompute message/block costs and suffix totals; select boundaries without repeatedly reprocessing the whole transcript. | Same selected head/tail and summary text across golden fixtures, with near-linear preparation scaling. |
| P1 | App-level tool fingerprint covers names, descriptions and top-level input keys, not complete nested schemas: [src/main/cache-policy.ts:34–56](src/main/cache-policy.ts#L34-L56). Native prefix binding separately hashes full definitions: [src/main/harness/context/binding.ts:39–42](src/main/harness/context/binding.ts#L39-L42). | Generate complete descriptors once; distinguish a full behavioral/authority revision from the exact model-visible prefix fingerprint. Memoize unchanged inputs; keep permission checks live. | Nested schemas change both applicable hashes; a host-only executor/policy revision changes behavior identity without falsely claiming the serialized model prefix changed. Bound thinking remains safe. |
| P1 | Native exploration uses the lead's route/request by default: [src/main/harness/driver.ts:326–365](src/main/harness/driver.ts#L326-L365). Child loops have a step/result cap but no parent-style context `prepare`: [src/main/harness/subagent.ts:128–170](src/main/harness/subagent.ts#L128-L170). | Optional explicitly configured small-model exploration; token/wall limits and bounded structured reports; preserve user model lock and read-only permissions. | Deep exploration completes without overflowing; parent receives evidence/uncertainty; combined cost is reported and bounded. |
| P1 | The native base prompt recommends background shell `&`: [src/main/harness/context/system.ts:31](src/main/harness/context/system.ts#L31), while the bundled guide requires managed `shell_start`: [resources/CUBIQ.md:10](resources/CUBIQ.md#L10). | Remove contradictory server guidance; route to managed shells wherever offered, with truthful fallback for unsupported engines. | Model behavior fixture starts one managed server and cleans it up; no duplicate unmanaged process. |
| P1 | Evidence notices rely on textual claims and command-name matching: [src/main/evidence.ts:51–68](src/main/evidence.ts#L51-L68). | Add a structured evidence ledger: actual command/tool outcome, cwd, exit code and revision/digest checked. Show “not run”, “failed”, “passed” and “stale” distinctly. | `echo tests pass`, a failed check, or a check before later edits cannot establish a verified completion. |
| P1 | Automation budget evaluation happens after collected turn totals: [src/main/automations/runner.ts:233–247](src/main/automations/runner.ts#L233-L247); result publication still follows an over-budget verdict. | For supported engines, enforce soft token/cost/time budgets during execution; disclose unknown-price limits and already-in-flight spending. Explicitly decide whether an over-budget result may still be delivered. Keep install approval user-only in unattended runs. | Overspend pauses further work; delivery policy is tested with no duplicate delivery on resume; unknown costs never masquerade as a hard dollar cap. |
| P1 | ACP driver only injects `<harness-memory>` on the first turn when `l.guidePending === true`: [src/main/agents/acp/driver.ts:1359–1372](src/main/agents/acp/driver.ts#L1359-L1372), dropping `memoryUpdateFor` deltas on resumed turns. | Keep initial memory frozen in the session prefix while appending `memoryUpdateFor(projectId, threadId)` deltas on later turns, matching Claude and Codex. | A memory note written mid-session reaches subsequent ACP turns without invalidating the initial session prefix. |
| P1 | Per-thread / per-session tool and state maps are not fully evicted on thread deletion: [src/main/index.ts:2100–2108](src/main/index.ts#L2100-L2108) only deletes `shellToolLists` and `teamToolLists`, leaving `designToolLists` (line 579), `designThreadTools` (line 629), `documentToolLists` (line 683), `threadToolLists` (line 713), `codeStateBySession` ([src/main/harness/driver.ts:101](src/main/harness/driver.ts#L101)) and `codeServer` maps ([src/main/code-mode.ts:37, 83–85](src/main/code-mode.ts#L37)). | Centralize thread/session disposal hooks so deleting a thread or project evicts all per-thread tool caches and Code Mode state maps. | Repeated create/delete cycles leave zero retained per-thread entries across `index.ts`, `driver.ts` and `code-mode.ts`. |
| P2 | Skill stamping scans folders and SKILL mtimes on lookups: [src/main/skills/sources.ts:23–54](src/main/skills/sources.ts#L23-L54). Native root instruction files are synchronously read by [src/main/harness/context/files.ts:13–29](src/main/harness/context/files.ts#L13-L29). | Profile large catalogs first; consider scoped mtime/revision caches and debounced invalidation while retaining external-edit discovery. | 1/100/1000-skill fixtures; edited/deleted skills and instructions appear correctly without stale delivery. |
| P2 | Library children are statically imported despite conditional tab rendering: [src/renderer/src/components/Library.tsx:8–14](src/renderer/src/components/Library.tsx#L8-L14). Transcript windowing already exists: [src/renderer/src/components/ThreadView.tsx:163–215](src/renderer/src/components/ThreadView.tsx#L163-L215). | Inspect production chunks, then lazy-load expensive tab/detail modules and cache derived closed-turn data only where traces justify it. | Smaller unopened-path JS/parse cost without changing keyboard focus, errors, streaming or history anchors. |

### 8.2 Agent intelligence and task quality

Move deterministic control out of prompts. The model chooses useful investigative/creative actions; host code owns limits, permissions, result reconciliation, objective state and evidence validity. Do not ask the model to remember invariants that the runtime can enforce.

Maintain a small versioned task record containing objective, user constraints, authorized scope, relevant evidence, open work and acceptance checks. It is **not private chain-of-thought** and must not attempt to extract hidden model reasoning. Record observations as facts with provenance, distinguish hypotheses from verified results, and preserve unanswered questions/constraints across compaction and handoff.

Use a simple task progression: investigate → propose when necessary → execute → verify → done/partial/blocked. Simple informational replies can skip planning/execution; do not force a state machine's ceremony into every user exchange. “Done” means the requested scope was fulfilled with its verification status stated. If an essential criterion remains unmet, record partial/blocked status and the limitation; reporting a limitation honestly does not make the task a verified success. The model stopping tool calls is not completion evidence.

Assemble a budgeted task context from applicable instructions, current constraints, top-ranked evidence and fresh required memory. Keep stable behavior instructions separate from changing task data. Retrieve missing evidence when needed rather than sending the entire repository, every skill and every memory note. Cache by identity/content revision; do not cache stale conclusions as instructions.

| Area | Preserve today | Next improvement | Guardrail |
|---|---|---|---|
| Grounding | Read-before-edit tools, project instructions and managed browser tools. | Small task context packet: objective, user constraints, relevant paths, local instruction scope, validation command. Discover nested instructions before editing their subtree. | Never treat repository/web/tool data as permission to override higher-priority rules. |
| Planning | Existing Plan mode and approval cards. | Durable concise success criteria and structured work state for multi-file/high-risk work; replace prompt-only state tracking when it loses constraints. Skip ceremony for simple questions. | No hidden implementation before approval; no repetitive “planning” turns or stored private reasoning. |
| Retrieval | Existing glob/grep and [BM25 ranking](src/main/search/bm25.ts). | Add optional repository-symbol/dependency retrieval only after lexical retrieval is evaluated; return top-k evidence with paths and freshness. | No always-on full-repo indexing or embedding service in the MVP. |
| Tool selection | MCP `search_tools`, schema validation and browser-on-demand routing. | Evaluate compact searchable tool catalogs, exact-name/schema caching and fewer unnecessary discovery calls. | Search is not authorization; unknown tools remain conservative mutations. |
| Failure recovery | Repeated-call detection, bounded retries, overflow/image recovery and watchdogs. | Stable argument canonicalization, failure categories and one targeted corrective hint; distinguish failed repeated calls from valid repeated reads after change. | Never retry side-effecting work after a partial success without idempotency evidence. |
| Effort/model use | Per-thread user selection and effort controls. | Opt-in Auto policy chosen by expected task success/cost: inexpensive lookups may use low effort; complex reasoning or a demonstrated failure may escalate with a visible reason/budget. Do not assume the cheapest model is the best explorer. | Manual model/effort stays locked; availability, data policy and provider capability are checked. |
| Delegation | Read-only native explore children and expert-team routes. | When project policy permits: at most 2–3 independent, budgeted research children, non-overlapping scope and structured citations. | Honor no-delegation project rules; no recursive spawning, concurrent overlapping edits, or unverified child “done” claims. |
| Completion | Project checks and evidence notices. | Require real evidence for a verified badge, and stop optional refinement once the user's acceptance criteria pass. | Do not weaken tests or fabricate a green result to finish faster. |

Delegate only when independent scope and expected quality/critical-path benefit outweigh extra model calls, duplicated context and integration cost. Reserve a total parent/child budget first; do not spend the full lead budget again for every child. A stronger single investigator can be better than three inexpensive investigators with overlapping scope. Every child claim remains a hypothesis until evidence is validated by the integrating task.

### 8.3 Memory, learning, experts and automations

- **Memory:** treat retained information as typed data: user preference, project fact, correction or tentative lesson—not one undifferentiated bag of instructions. Existing [src/main/memory/store.ts:33–50](src/main/memory/store.ts#L33-L50) already caps index/prompt content; this is not an unbounded-memory problem. Keep scope/correction behavior where correct; add source digest, confidence/provenance, expiration/revalidation and conflict resolution. Retrieved notes cannot grant authority or override higher-priority policy. Send task-specific retrieval as appended context, not a constantly reordered system prefix.
- **Self-improve:** use opt-in, evaluated learning of guidance, not uncontrolled self-modification. [src/main/learn/index.ts:1–6](src/main/learn/index.ts#L1-L6) already describes cheap scoring, bounded background drafts and verified lessons; adapt or replace its pipeline if verified promotion/retirement cannot be represented reliably. Require independent replay/holdout evidence, track degradation and retain poisoning defenses. Learning never grants capabilities or mutates global policy. This improves guidance; it does not train model weights.
- **Experts:** use the existing persona/private-skill/team system. Add creator-oriented presets only after their narrow role proves useful; avoid long overlapping personas or automatically summoning a team for every request.
- **Automations:** preserve existing delivery reconciliation/idempotency and permission choices. Add runtime budget visibility and a preview of external effects. A schedule's authorization does not approve installing new global capabilities.
- **Notifications/usage:** expose slow preparation, retry waits, expected capability-update cache breaks and unknown cost explicitly. Keep routine progress compact rather than showing a new dashboard by default.

### 8.4 Design, artifacts and broader extensibility

- **Design:** preserve the current studio, local references, selection, variants, conflicts and exports. Improve measured reload/bridge or selection bottlenecks in their own change set. Creator does not load the canvas unless a user deliberately opens a Design thread.
- **Artifacts:** make generated output a revisioned deliverable with source/provenance and verification status, not just “the last matching file written.” Existing Preview/Source/Diff/version and utility-process parsing are useful adapters. Add coalesced parsing or a different renderer when requirements justify it; preserve explicit input/time/cache and process ownership contracts.
- **GenUI:** use existing structured reply blocks for simple calculators, charts, choices and forms before introducing persistent UI plugins. Installation approval must never be a model-defined GenUI action.
- **Resource packs:** use one extension lifecycle contract with per-kind validation/runtime adapters. Kit staging and expert import containment offer reusable primitives, not a ready-made generic installer. Migrate them only when the shared lifecycle provides clear value; do not prematurely refactor every resource path.
- **Plugin lifecycle, later:** use the versioned extension contract as the seam for sandboxed panels and other justified capabilities. If executable Host plugins are necessary, compare an established lifecycle/runtime framework against a custom solution using dependency/isolation/reload requirements. Do not expose every internal CubiQ object as public API or assume an in-process plugin has least privilege.
- **Source editing:** continue using existing change review, worktrees and project checks. Any source checkout workflow is distinct from installing a persistent skill/connector in a running app.

### 8.5 Measure “smarter” honestly

Extend the existing [bench/run.ts](bench/run.ts) and [evals/run.ts](evals/run.ts), rather than introduce a parallel evaluation framework. Add representative cases for:

1. Create a reusable skill and invoke it after restart.
2. Add a connector with an environment-secret reference; reach its tool only after approval.
3. Reject a path-escaping or post-review-modified draft with no installation.
4. Inspect the harness and answer a question without installing anything.
5. Fix a multi-file bug using relevant evidence, without weakening tests.
6. Resume after compaction with user constraints and pending work intact.
7. Correct/retrieve a stale memory note and resist poisoned external guidance.
8. Stop a slow MCP operation; retry a provider failure without duplicating side effects.
9. Complete a long-history task while the Composer remains responsive.
10. Use optional read-only delegation only when policy permits, with a bounded total budget.

Report task pass rate, first-pass correctness, unnecessary tool calls, repeat failures, context loss, verification honesty, total tokens/cost, time to first useful result, final completion time and denied-action correctness.

Use matched agent/model/settings and paired trials; pilot at least 5 trials per task/model and expand when variance is high. Hold validation tasks out of prompt/lesson optimization. Report uncertainty and failures—not a single favorable run or a “smartness score” with no definition. Live runs consume provider quota and need separate approval; they were not executed for this proposal.

### 8.6 Code Mode: expand useful scripting through a typed runtime

The follow-up [Code Mode enhancement](enhancement-code-mode.md) compares our implementation with current Anthropic programmatic tool calling/tool search/input examples and Cloudflare's durable runtime. The strongest direction is local typed execution with progressive discovery, complete result schemas, explicit inspect/act profiles, upstream data/work budgets and a shared host authorization/scheduling boundary.

Harmless probes reproduced four gaps: script timeout leaves host work active; the broker runs serial-marked mutations concurrently; cwd-relative resolution permits an outside-cwd read; concurrent successful state snapshots lose a write. Enforce configured scope/grants rather than equating cwd with confinement. Fix cancellation, effect ordering and state commit before expanding script effects or adding reusable recipes.

Script deterministic composition, aggregation, joins and filtering aggressively where it saves verified end-to-end work. Keep direct calls for simple operations and model judgment for interpretation. Anthropic's hosted PTC is not the same as local `run_code`; its current caller/container/schema/data-retention restrictions require an optional explicit adapter, not an incidental provider switch.

### 8.7 GenUI: typed results become trusted, stateful components

The follow-up [GenUI enhancement](enhancement-genui.md) reviews the user-linked AI SDK UI guide, typed tool/data parts, lifecycle reconciliation and approval protections. Keep a cross-engine legacy fence adapter, but add a structured path: **tool/Code Mode data → host validation/provenance → stable widget state → trusted React component → origin-bound user action**. The model should not retype a dataset simply to draw it.

Probes reproduced acceptance of an unclosed final widget fence and clipping that changes an actual choice answer. Prioritize inert incomplete widgets, unchanged action values, stable origin/revision IDs, acknowledgment, idempotency and remount-safe consumed state. Then add bounded composition, accurate units/precision/source coverage and incremental streaming/large-table performance.

Adopt the AI SDK's useful patterns; assess an SDK adapter/migration on its actual all-engine maintenance and compatibility benefit. Its current RSC documentation recommends AI SDK UI for production. No arbitrary executable UI or model-generated permission decisions belong in normal replies.

**Follow-up verification:** 153 existing tests across 12 Code Mode/GenUI files passed; six separate harmless probes exposed the four Code Mode and two GenUI gaps above. Passing that baseline does not mean the new gaps are fixed. See [the focused implementation plan](.ai/plans/code-mode-genui-2026-11-16.md).

## 9. Implementation phases and affected files

### Phase 0 — Baseline and focused reproductions

Capture current request prefixes/tool schemas, production chunk boundaries, long-thread UI behavior and the source-backed reproduction fixtures. Define reference hardware, workload, quality outcomes and costs. Map which operations each engine can actually mediate. Record the boundary requirements before selecting an implementation; a baseline is not an obligation to preserve a defective behavior.

### Phase 1 — Capability foundation and critical reliability

- Define complete operation descriptors, invocation context/outcomes and deny-by-default policy for the first Creator/MCP operations. Do not migrate every existing tool before delivering a vertical slice.
- Add shared host invocation and adapter contract tests; move the selected UI/agent operations behind that boundary without leaving a bypass path.
- Correct cancellation propagation/resource leases and bounded check logging in independently reviewable changes.
- Add evidence/installation record primitives needed by the first operations, not a universal workflow platform.

Likely integration points: [src/main/agents/types.ts](src/main/agents/types.ts), [src/main/harness/tools/types.ts](src/main/harness/tools/types.ts), [src/main/mcp/router.ts](src/main/mcp/router.ts), [src/main/check.ts](src/main/check.ts), [src/main/index.ts](src/main/index.ts), native-loop/MCP transport adapters, and the new `capabilities/` boundary.

**Exit:** selected operations have consistent validation, identity, permission, cancellation and typed outcomes across supported callers. Unknown/revoked operations are denied, Stop settles owned work, large logs stay bounded, and ordinary tasks retain correct behavior.

### Phase 2 — Complete Creator vertical slice: usable MVP

- Persist `agentPreset` identity/revision separately from presentation; support creation, restart, export/import, branching, handoff and per-engine resolution.
- Implement the first extension manifest/lifecycle adapters, bounded discovery, draft validation, host-recorded review and exact-digest approval.
- Ship Creator guidance and a fast conversational workspace with lazy preview/review and clear Project/Global impact.
- Demonstrate a skill and a connector from natural-language request through actual use, disablement and recovery—not merely a prompt label or a saved configuration.

Likely integrations: [src/shared/types.ts](src/shared/types.ts), [src/main/db.ts](src/main/db.ts), [src/main/service.ts](src/main/service.ts), [src/main/guide.ts](src/main/guide.ts), [src/main/skills/sources.ts](src/main/skills/sources.ts), affected driver/catalog callbacks, [src/main/mcp/servers.ts](src/main/mcp/servers.ts), vault/gateway, and new `extensions/` modules. UI/bridge: [src/renderer/src/components/Sidebar.tsx](src/renderer/src/components/Sidebar.tsx), [src/renderer/src/components/PaneRail.tsx](src/renderer/src/components/PaneRail.tsx), [src/renderer/src/App.tsx](src/renderer/src/App.tsx), [src/renderer/src/store.ts](src/renderer/src/store.ts), [src/renderer/src/sections.ts](src/renderer/src/sections.ts), [src/preload/index.ts](src/preload/index.ts), mocks and focused review/Library surfaces. Retain or replace components behind those integration points based on the target contracts.

**Exit:** both creation journeys work after restart under the chosen engine's disclosed guarantees. Rejection, post-review changes, revocation, conflicting edits, unavailable credentials and partial failure produce truthful recoverable state. Ordinary threads receive no Creator-specific context or unexpected persona change.

### Phase 3 — Quality and efficiency controller

Introduce structured task/evidence state, accurate behavioral/prefix revisions, measured context/streaming improvements and parent/child budgets as independent batches. Evaluate context retrieval, instruction scope, memory freshness, bounded recovery and opt-in effort/delegation policies on held-out cases. Replace prompt-only or duplicated mechanisms where the runtime can enforce the invariant reliably.

**Exit:** paired evaluation supports more correct verified completions or lower time/cost at comparable quality. Preserve user model locks, live revocation, event ordering and valid history; reject “optimizations” that conceal failure or lower safety.

### Phase 4 — Sandboxed capability panels, if justified

Add one tested panel payload/runtime adapter to the extension lifecycle, rather than unrestricted React injection. Prove offline preview, origin isolation, narrow authenticated actions, trusted host-rendered approval, version compatibility and unload cleanup. If the desired widget is adequately served by a structured reply or artifact, do not add persistent panel machinery for it.

**Exit:** a generated useful panel can be created, revised, installed, used, revoked and unloaded without accessing unrelated app/host state or adding eager work to ordinary sessions.

### Phase 5 — Broader extension/runtime requirements

Consider declarative presets/resource packs and executable plugin support only against concrete product requirements. Re-evaluate Cordis or another established runtime if dependency composition, safe process isolation and lifecycle ownership exceed the small core's intended scope. A framework migration must include data/adapter compatibility, failure recovery and a measured transition plan, not aesthetic similarity to DeepSeek.

**Execution discipline:** implementation begins only after explicit scope approval. Split phases into small reviewable batches, generally no more than about five target files plus focused tests per batch. Targeted architectural replacement and justified dependencies are allowed design choices; unrelated cleanup, unreviewed dependency upgrades, permission changes, AGENTS.md changes, commits or pushes are not authorized by this proposal. Preserve unfamiliar local work.

## 10. Verification and rollout

### Automated

- Add focused tests for preset/presentation separation, preset revision persistence, catalog isolation, supported driver/transport paths, schema validation, sender/scope identity, digest/revision conflicts, cancellation, immediate revocation, journal recovery and vault-safe revert.
- Add snapshots/invariants for unchanged ordinary Creator-specific prefixes, stable model-visible definitions, boundary-only catalog activation, immediate authority revocation and explicit session rebuild causes. Distinguish host behavioral revision from exact serialized-prefix identity.
- Add fault injection at each install stage, multiple windows/scopes, duplicate clicks, rejection, restart and disablement.
- Exercise long histories, whitespace-heavy streaming, large check logs, connector timeout/cancellation, nested schema changes and constrained child context.

After each approved code phase, run the project's actual checks from [package.json:25–31](package.json#L25-L31):

```bash
bun run typecheck
bun run test
bun run design:check
bun run build
```

Use focused tests during iteration; the complete suite remains required before claiming a phase passed. The current worker's no-git/no-delegation rules still apply to how checks are executed; do not invoke a live benchmark runner that calls prohibited commands without resolving that execution constraint first.

### Real app

Follow [DESIGN.md §7.3–7.6, §7.8 and §9](DESIGN.md) and [docs/design/quality-checklist.md](docs/design/quality-checklist.md):

- Ink Flat surfaces, existing tokens, compact controls and one Composer row.
- Light/dark/system, 900px width with a side panel, and no horizontal overflow.
- Keyboard menu navigation, accessible names, visible focus, Escape/focus return.
- Loading, empty, selected, disabled, rejected, conflict and retry states.
- Reduced motion; macOS and Windows chrome/insets.
- Real Electron app screenshots and interaction evidence, not only `preview:ui` mocks.

Mark untested visual/platform items `needs-human-look`. The initial Creator review did not run a code test suite or the real app. The later Code Mode/GenUI follow-up ran the 153-test targeted suite recorded in §8.6–8.7; full-suite, typecheck/build and real-app/platform verification remain unperformed.

### Rollout

Make Creator explicitly user-selected. Deliver the Phase 1 foundation and Phase 2 vertical slice with narrowly tested migrations. General correctness fixes may improve other modes; persona, scope, default authority and automatic model policies must not change incidentally. Give experimental intelligence policies independent toggles/quality gates. Preserve installed data when disabling a feature; recovery is a scoped service operation, never a destructive repository reset.

## 11. Selected design and implementation approval

The following decisions use the user's delegated architectural judgment; they are recommendations with rationale, not a request to decide every implementation detail again:

1. **Domain model:** Creator is an agent preset, independent of presentation and authority.
2. **Core:** one small host-controlled operation contract and invocation path, with incremental adapters. Reuse is conditional; targeted replacement is allowed.
3. **MVP:** complete skill + connector lifecycles, not a mode-toggle-only release. Leave a tested seam for additional extension kinds without shipping an unused plugin platform.
4. **Authority:** user-controlled scoped installation approval, live deny-by-default checks and immediate revocation. Never infer safety from a signature, process boundary or server-declared read-only annotation.
5. **Activation:** stable model-visible catalog snapshots at safe boundaries; separate live authority checks. Session rebuilds and unsandboxed engine/runtime limits are disclosed.
6. **Intelligence:** structured task/evidence state, relevant fresh context and measured recovery/model policies. Manual model/effort remains authoritative; additional reasoning/delegation must earn its cost.
7. **Architecture freedom:** compare frameworks/dependencies when requirements justify them; do not preserve a defective handler because it already exists or rewrite a working subsystem without a benefit.
8. **Delivery:** prioritize boundary/reliability and a usable vertical slice, then quality/efficiency, then panels or broader runtime support.

Implementation approval should confirm the phase/batch scope and live provider budget. The document revision is not a claim that these mechanisms have already been built or benchmarked.

**Suggested order: baseline → capability core + critical reliability → complete Creator vertical slice → quality/evidence/context improvements → evaluated intelligence policies → justified panels/runtime breadth.**

## 12. DeepSeek and frontier lab references

All DeepSeek implementation links below are pinned to the reviewed commit; they describe that version, not a permanent promise about `master`.

1. [DeepSeek Harness repository / README](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/README.md).
2. [DeepSeek Harness architecture: profiles, bundles, service seams and lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/docs/architecture.md).
3. [DeepSeek Creator preset (`cordis.patch.yml`)](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/presets/cordis.patch.yml).
4. [Web bundle: Creator persona, skill loading and cache effects](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/bundle/web-app/README.md).
5. [Creator persona E2E test](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/apps/web/tests/creator-persona.e2e.ts).
6. [Packaged dsh-doc skill and reference router](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/preset/agent-preset/skills/dsh-doc/SKILL.md).
7. [Implemented persistent plugin-management decision](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/.agents/notes/implemented/architecture/2026-09-16-creator-persistent-plugin-management.md). Historical decision; current preset/source controls present behavior.
8. [Archived progressive skill-disclosure decision](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/.agents/notes/archived/architecture/2026-09-21-creator-skills-progressive-disclosure.md). Explains the design motivation; old skill names are not the current API.
9. [One operation shared by user actions and agent tools](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/preset/agent-preset/skills/dsh-doc/references/user-actions.md).
10. [Frontend workflow performance policy and incremental visibility evidence](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md). Its endpoint measurements are not CubiQ benchmarks.
11. [Disposable document-preview registry](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts).
12. [Cordis framework: spatiotemporal composability](https://github.com/cordiverse/cordis) and [DeepSeek Thinking Mode & tool calls guide](https://api-docs.deepseek.com/guides/thinking_mode).
13. [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) and [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
14. [Anthropic: Advanced Tool Use (Programmatic Tool Calling, Tool Search, Input Examples)](https://www.anthropic.com/engineering/advanced-tool-use).
15. [Google DeepMind: Agent Development Kit (ADK)](https://adk.dev), [Agent2Agent (A2A) Protocol](https://a2a-protocol.org), [A2UI Declarative Generative UI](https://a2ui.org/), and [Gemini Function Calling & Thought Signatures](https://ai.google.dev/gemini-api/docs/function-calling).
16. [OpenAI: Agents SDK](https://openai.github.io/openai-agents-python/), [Responses API Tool Search](https://platform.openai.com/docs/guides/tools-tool-search), and [Codex developer documentation](https://developers.openai.com/codex).
17. [Z.ai (Zhipu AI): GLM-4.6 / GLM-4.7 Interleaved & Preserved Thinking guide](https://docs.z.ai/guides/Capabilities/thinking) and [GLM-4.5 ARC foundation model](https://z.ai/blog/glm-4.5).
18. [Model Context Protocol (MCP): structuredContent and outputSchema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) and [MCP Apps Extension (SEP-1865 / MCP-UI)](https://mcpui.dev/).
