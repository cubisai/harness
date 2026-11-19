# Code Mode enhancement

**Reviewed:** 2026-11-16 · **Status:** researched proposal, not implemented.

Here, Code Mode means CubiQ's `run_code` programmable tool runtime—not the application's coding/chat view. This proposal complements [enhancement-creator-mode.md](enhancement-creator-mode.md) and [enhancement-genui.md](enhancement-genui.md). Public API facts were checked against current documentation; published vendor gains are not CubiQ benchmarks.

## 1. Recommendation

**Make Code Mode a typed, bounded, observable programmable-tools runtime. Script as much deterministic work as is useful, but never confuse a successful JavaScript program with a correct task, or script eligibility with permission.**

Use scripts for discovery, dependent calls, joins, filtering, aggregation, pagination, batching and repeatable transformations. Keep the model involved when new evidence changes the interpretation, when judgment is needed, or when the next effect has not been authorized. A single lookup can still be a direct tool call; forcing every task through code creates unnecessary compilation, discovery and error-recovery overhead.

Keep a local executor as the default for desktop/private/cross-engine work. Start by hardening QuickJS behind an executor boundary; move its evaluation and expensive serialization off Electron main. Compare alternative runtimes only if measurements or missing capabilities justify replacement. Anthropic-hosted PTC is an optional provider-specific adapter, not a replacement for local scripting or a feature that every external agent automatically inherits.

**Priority:** correctness and cancellation → typed tool results/catalogs → broader authorized composition → durable recipes and typed GenUI outputs → measured routing/optimization.

## 2. Anthropic, frontier labs and internet findings

### 2.1 Adopt the principles, not old launch snippets

| Source | Relevant principle | CubiQ decision |
|---|---|---|
| Anthropic: [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) | Tool search, programmatic calls and input examples address different bottlenecks. | Combine compact discovery, script composition and focused examples; do not solve parameter errors by increasing a persona prompt. |
| Anthropic: [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) | Intermediate results can flow between tools without being copied through the model. Typed APIs and progressive disclosure reduce context overhead. | Preserve structured data inside execution; return compact evidence and answers. Model-hidden does not mean private from every service. |
| Current Anthropic [PTC documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) | Hosted code calls custom tools asynchronously; tool results go to code, then the final result reaches the model. | Optional hosted adapter must handle caller/container/continuation semantics explicitly. A local `run_code` is a custom client tool, not this server feature. |
| Current Anthropic [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) | Deferred schemas enter model context on demand, but the API still receives the full catalog. | Distinguish request bytes from model tokens. Local discovery can avoid both a full model catalog and unnecessary remote discovery. |
| Anthropic [tool definitions/examples](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) | Precise descriptions, schemas, output contracts and a few realistic examples improve correct use. | Generate declarations/examples from authoritative descriptors, preserving runtime validation and domain constraints. |
| Cloudflare [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) and [durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/) | TypeScript `.d.ts` discovery, RPC connector methods, SQLite-journaled calls, approvals and reusable snippets belong to a host-controlled execution lifecycle. | Borrow durable execution/recipe concepts over CubiQ's existing local `node:sqlite` store ([src/main/db.ts:33–95](src/main/db.ts#L33-L95)); do not migrate a desktop app to Durable Objects merely to reuse the example. |
| MCP [structuredContent & outputSchema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) | Tools declare `outputSchema` and return machine-readable `structuredContent` alongside LLM-facing `content` text. | Preserve `result.structuredContent` and `tool.outputSchema` in `McpClientPool.callTool` ([src/main/mcp/router.ts:61–77](src/main/mcp/router.ts#L61-L77)) and `McpToolInfo` ([src/main/mcp/servers.ts:419–423](src/main/mcp/servers.ts#L419-L423)) so scripts consume typed JSON instead of scraping text. |
| OpenAI [Codex app-server / Code Mode](https://developers.openai.com/codex) and [Responses tool search](https://platform.openai.com/docs/guides/tools-tool-search) | Codex 0.159+ supports top-level client `dynamicTools` and its own `exec` Code Mode; OpenCode v2 provides `execute`. | Prefer direct top-level `dynamicTools` ([src/main/agents/codex.ts:1138–1141](src/main/agents/codex.ts#L1138-L1141)) or typed MCP primitives over nested sandbox-in-sandbox string escaping ([src/main/code-hint.ts:7–11](src/main/code-hint.ts#L7-L11)). |
| Google DeepMind [Gemini function calling & code execution](https://ai.google.dev/gemini-api/docs/function-calling) and [ADK](https://adk.dev) | Iterative sandboxed code execution and multi-step tool loops require preserving model `thought_signature` metadata across tool turns. | Keep `run_code` engine-agnostic while round-tripping provider `thought_signature` / `extra_content` in the native loop ([src/main/harness/llm/protocols/openai-chat.ts:31–39](src/main/harness/llm/protocols/openai-chat.ts#L31-L39)). |
| DeepSeek [thinking mode tool calls](https://api-docs.deepseek.com/guides/thinking_mode) and Z.ai [GLM-4.6 / GLM-4.7 interleaved & preserved thinking](https://docs.z.ai/guides/Capabilities/thinking) | Reasoning models interleave `<think>` steps between tool calls (`Think → Act → Observe → Think`) and rely on prefix cache stability. | Return compact, completeness-annotated JSON from `run_code` so interleaved reasoning steps do not bloat context or invalidate prefix caches. |

### 2.2 Current hosted-PTC constraints matter

As reviewed, Anthropic documents PTC as stable and requires `code_execution_20260120` or a later supported version. The 2025 launch blog's beta header/model examples are historical, not current integration instructions.

- `allowed_callers` guides calling form; **the current docs explicitly say it is not a hard security boundary**. Enforce caller/permission policy in our host.
- Tools exposed to hosted Python are async functions taking one argument dictionary and returning result text. Document/parse JSON deliberately; do not assume the provider returns our local typed objects.
- Pending PTC continuations require the container ID, unchanged tool definitions and result-only response messages. Preserve this shape in history rather than synthesizing ordinary chat turns.
- Current restrictions include `strict: true` tools, recursive schema references, and direct use of tools from the hosted MCP connector. Local MCP wrappers exposed as custom client tools are a different integration path and require our own validation/authorization.
- Model/platform/tool-version support must be negotiated and tested; never advertise generic support based only on a model family name.
- Current hosted code-execution data handling is not zero-data-retention eligible and can retain container data for up to 30 days. Intermediate data omitted from model context still reaches the hosted execution environment. Local/private execution and hosted execution need separate explicit choices.

Published figures such as the 2025 blog's 37% token reduction describe Anthropic's workloads. They motivate evaluation, not a promised speedup or accuracy gain for CubiQ.

### 2.3 Frontier AI lab deep-dive: programmable tool calling across companies (2025–2026)

1. **Anthropic ([Programmatic Tool Calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [Tool Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)):**
   - **Mechanism:** Separates three orthogonal primitives: (a) **Tool Search** (`defer_loading: true`, regex/BM25 lookup) so 50–100+ tool schemas do not occupy the initial prompt prefix; (b) **Programmatic Tool Calling** (`code_execution_20260120` + `allowed_callers: ["code_execution_20260120"]`) where Python code loops over tool calls and filters intermediate outputs before returning `stdout` to the model; and (c) **Input Examples** (`input_examples` on tool schemas) to teach parameter combinations without bloating system instructions.
   - **CubiQ application:** CubiQ already implements in-sandbox BM25 `searchTools` and `describeTool` ([src/main/harness/tools/code.ts:221–242](src/main/harness/tools/code.ts#L221-L242)) plus app-level MCP `search_tools` ([src/main/mcp/router.ts:235–272](src/main/mcp/router.ts#L235-L272)). What is missing is unified return-type schemas (`outputSchema`), structured MCP payloads (`structuredContent`), and canonical input examples generated from authoritative descriptors.

2. **Cloudflare ([Code Mode](https://developers.cloudflare.com/agents/tools/codemode/), [Durable Runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/), [API Reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)):**
   - **Mechanism:** Generates TypeScript `.d.ts` ambient declarations (`declare const codemode: { ... }`) from JSON Schemas, executes model-authored JS/TS inside isolated V8 workers (`DynamicWorkerExecutor`), intercepts connector calls over RPC, and records every call, result digest, and pending human approval in a Durable Object SQLite journal so runs can hibernate during approval waits and replay deterministically on resume.
   - **CubiQ application:** CubiQ's `toTsDeclaration` ([src/main/harness/tools/ts-decl.ts:10–15](src/main/harness/tools/ts-decl.ts#L10-L15)) and QuickJS runtime ([src/main/harness/tools/code.ts:89–112](src/main/harness/tools/code.ts#L89-L112)) follow the same TypeScript-declaration + sandboxed-JS pattern locally. Instead of Cloudflare Durable Objects, CubiQ can journal script tool calls and approval checkpoints in its existing local `node:sqlite` store ([src/main/db.ts:33–95](src/main/db.ts#L33-L95)) and offload large intermediate payloads to its existing content-addressed `blobs` directory ([src/main/db.ts:600–650](src/main/db.ts#L600-L650)).

3. **OpenAI ([Codex App-Server & `exec`](https://developers.openai.com/codex), [Responses API Tool Search](https://platform.openai.com/docs/guides/tools-tool-search), [Agents SDK](https://openai.github.io/openai-agents-python/)):**
   - **Mechanism:** In the Responses API, `tool_search` defers large MCP/function namespaces on demand, while stateless sessions preserve reasoning across tool turns via `include: ["reasoning.encrypted_content"]` ([src/main/harness/llm/protocols/openai-responses.ts:53](src/main/harness/llm/protocols/openai-responses.ts#L53)). In Codex (`0.159+`), `thread/start` accepts client-executed `dynamicTools` alongside MCP servers, and Codex's own `features.code_mode` (`exec`) lets the model write scripts that call MCP tools inside Codex's sandbox.
   - **CubiQ application:** CubiQ supports three Codex paths ([src/main/agents/codex.ts:1135–1143](src/main/agents/codex.ts#L1135-L1143)): (1) `CUBIQ_CODEX_EXEC_MODE=1` enabling Codex's native `exec` with `CODE_HINT_CODEX_EXEC`, (2) top-level client `dynamicTools: [dynamicToolSpec(runCode)]`, and (3) deferred MCP `run_code` with `CODE_HINT_DEFERRED`. However, instructing Codex `exec` or OpenCode v2 `execute` to string-escape a JavaScript program inside another JavaScript call (`return await tools.mcp__cubiq__run_code({ code: "<script>" })` in [src/main/code-hint.ts:7–11](src/main/code-hint.ts#L7-L11)) creates a fragile double-sandbox hop. When an external engine already runs its own code sandbox, exposing typed read/search MCP primitives directly to that sandbox should be benchmarked against nested `run_code`.

4. **Google DeepMind ([Gemini Function Calling & Code Execution](https://ai.google.dev/gemini-api/docs/function-calling), [ADK](https://adk.dev), [Interactions API](https://ai.google.dev/gemini-api/docs/thinking)):**
   - **Mechanism:** Gemini 2.5, 3, and 4 combine iterative sandboxed code execution with structured function calling. Crucially, Gemini 3/4 thinking models attach an encrypted **`thought_signature`** (`extra_content.google.thought_signature` on OpenAI-compatible streams) to every function/tool call part and require the exact signature to be echoed back with the tool result on the next turn; omitting it causes a `400 Invalid Argument` failure.
   - **CubiQ application:** In CubiQ's native OpenAI-compatible protocol adapter ([src/main/harness/llm/protocols/openai-chat.ts:31–39, 112–123](src/main/harness/llm/protocols/openai-chat.ts#L31-L39)), `tool_calls` streaming and replay currently keep only `{ id, name, arguments }` and strip `extra_content`. Preserving opaque provider metadata on `ToolCallPart` is required so Gemini 3/4 models can chain `run_code` and follow-up tool calls without breaking mid-turn.

5. **DeepSeek ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)) & Z.ai / Zhipu AI ([GLM-4.6 / GLM-4.7 Thinking Mode](https://docs.z.ai/guides/Capabilities/thinking), [GLM-4.5 ARC](https://z.ai/blog/glm-4.5)):**
   - **Mechanism:** Both DeepSeek (R1 / V3.2 / V4) and Z.ai (GLM-4.5 / 4.6 / 4.7) use **Interleaved Thinking** (`Think → Tool Call → Observe Output → Think → Next Action`), where the model reasons over intermediate tool outputs before deciding the next step. DeepSeek requires `reasoning_content` to be replayed on assistant messages *within* the active turn's tool loop (and dropped on prior completed user turns so prefix caching stays compact), whereas Z.ai GLM-4.7 introduces **Preserved Thinking** (`clear_thinking: false`), retaining unmodified `reasoning_content` across multi-turn coding sessions to prevent logical amnesia and maximize prefix cache hits.
   - **CubiQ application:** Because interleaved thinking models reason after every tool return, collapsing 5–15 exploratory `read`/`grep`/`glob` round-trips into one `run_code` call saves not only tool-output tokens, but also 5–15 intermediate `<think>` generation steps. At the protocol layer, [src/main/harness/llm/protocols/openai-chat.ts:30–38](src/main/harness/llm/protocols/openai-chat.ts#L30-L38) should scope `reasoning_content` replay to the active turn by default while supporting opt-in multi-turn preserved thinking for GLM-4.7.

6. **Model Context Protocol ([`outputSchema` & `structuredContent`](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content)):**
   - **Mechanism:** The 2025–2026 MCP specification adds `outputSchema` to tool definitions and `structuredContent` (a typed JSON object/value matching `outputSchema`) to `CallToolResult`, distinct from `content` (text/media blocks formatted for LLM prose consumption).
   - **CubiQ application:** Today, [src/main/mcp/router.ts:74–77](src/main/mcp/router.ts#L74-L77) reads only `result.content` (joining text blocks and replacing non-text with `[type content omitted]`) and [src/main/mcp/servers.ts:419–423](src/main/mcp/servers.ts#L419-L423) stores only `{ name, description, inputSchema }`. Preserving `outputSchema` in `McpToolInfo` (and rendering it via `toTsDeclaration` in `describeTool`) and returning `result.structuredContent` as `ToolResult.data` inside `run_code` lets scripts compute over exact typed MCP responses without fragile regex/text parsing.

## 3. Current implementation and verified gaps

### 3.1 What already works

- [src/main/harness/tools/code.ts:15–20](src/main/harness/tools/code.ts#L15-L20): a fresh QuickJS runtime with a default 30-second limit, 64 MiB VM memory limit, bounded staged JSON state, and no direct filesystem/network/process/module globals.
- [code.ts:178–195](src/main/harness/tools/code.ts#L178-L195): JSON values already cross the VM bridge using cached QuickJS JSON parsing rather than only per-property FFI. Do not reopen the obsolete optimization as if it were still missing.
- [code.ts:210–242](src/main/harness/tools/code.ts#L210-L242): `ALL_TOOLS`, BM25-backed `searchTools` and generated `describeTool` declarations.
- [code.ts:299–365](src/main/harness/tools/code.ts#L299-L365): chained tool calls, tolerant `readMany`, JSON results, and normal JavaScript loops/conditionals/promises.
- Current read/glob/grep already use asynchronous file I/O, paging, common argument aliases and expanded ignore rules. Console levels, path helpers, error line numbers and empty-return hints already exist.
- Native Code Mode uses the driver's per-call authorizer and can reach mutation-capable tools: [src/main/harness/driver.ts:395–412](src/main/harness/driver.ts#L395-L412).
- MCP-delivered Code Mode intentionally exposes only filtered read tools, with a read-only outer tool: [src/main/code-mode.ts:74–135](src/main/code-mode.ts#L74-L135). The identical name does not currently mean identical capability/permission behavior.
- Existing host primitives already cover two key building blocks: `TargetLock` ([src/main/browser/tools.ts:33–58](src/main/browser/tools.ts#L33-L58)) serializes mutations via a promise chain with per-thread active-turn ownership, and `Store.writeBlob` / `readBlob` ([src/main/db.ts:79–83](src/main/db.ts#L79-L83), [600–700](src/main/db.ts#L600-L700)) already offloads `tool-use` and `tool-result` payloads larger than 64 KiB into a content-addressed SHA-256 `blobs` store with automatic `pruneBlobs()` garbage collection.

### 3.2 Reproduced with harmless local probes

The probe used fake in-memory mutations and a harmless sibling file inside repository scratch space; it did not execute shell commands, call a provider, read credentials or change live app state. Results: [.ai/tmp/code-mode-genui-review/probe-results.json](.ai/tmp/code-mode-genui-review/probe-results.json).

| Priority | Reproduced finding | Evidence / consequence |
|---|---|---|
| P0 | A script reports timeout while its host call continues with an un-aborted signal. | Probe: `hostSignalAborted=false`, `hostCompletedAfterScriptReturn=true`. [code.ts:109–127](src/main/harness/tools/code.ts#L109-L127), [517–536](src/main/harness/tools/code.ts#L517-L536) race script completion but do not create a deadline signal for broker work. |
| P0 | Calls for a tool marked `parallel:false` execute concurrently inside the broker. | Probe observed 2 concurrent fake mutations. [code-broker.ts:74–92](src/main/harness/tools/code-broker.ts#L74-L92) limits total concurrency but does not apply effect/resource ordering. |
| P0 | Relative paths can read outside the supplied cwd. | `tools.read('../outside-project.txt')` returned the harmless marker. [paths.ts:16–21](src/main/harness/tools/paths.ts#L16-L21) marks an outside path but does not itself deny it. Cwd resolution is not confinement. Configured grants may intentionally allow other roots; documentation and enforcement must agree. |
| P1 | Concurrent successful scripts can lose a successful state write. | Probe: both runs succeeded, final keys were only `a`, and `b` was lost. [code.ts:108](src/main/harness/tools/code.ts#L108), [143–145](src/main/harness/tools/code.ts#L143-L145) copy and replace a shared Map without revision conflict detection. |

### 3.3 Additional source-backed gaps, not yet impact-benchmarked

- **Typed data loss (MCP `structuredContent` & `outputSchema` ignored):** [src/main/mcp/router.ts:61–77](src/main/mcp/router.ts#L61-L77) flattens `result.content` to text, omits non-text content, and ignores `result.structuredContent`; [src/main/mcp/servers.ts:419–423](src/main/mcp/servers.ts#L419-L423) omits `tool.outputSchema`; [appLoopTool:638–644](src/main/harness/driver.ts#L638-L644) returns bounded text rather than an optional typed payload. Scripts may end up parsing truncated presentation text instead of authoritative data.
- **Native/MCP mismatch & `search_tools` dead end:** native scripts can perform guarded effects; MCP scripts cannot call the generic mutation-classified MCP dispatcher. In [src/main/index.ts:757–761](src/main/index.ts#L757-L761) and [src/main/code-mode.ts:74–75, 96](src/main/code-mode.ts#L74-L98), `codeServer` passes `routedTools(pid)` through `readsOnly`, which keeps `search_tools` (`effect: "read"`, [src/main/mcp/router.ts:243](src/main/mcp/router.ts#L243))—whose description instructs *"Call this before call_mcp_tool"*—while stripping `call_mcp_tool` (`effect: "mutate"`, [src/main/mcp/router.ts:283](src/main/mcp/router.ts#L283)). Expanding MCP script calls needs per-operation policy, not flipping `call_mcp_tool`'s `effect` to read or leaving a dead-end discovery tool.
- **`withBrowserOnDemand` tool-surface divergence:** for engines without native `toolSearch` (including the native harness loop), [src/main/index.ts:736–740](src/main/index.ts#L736-L740) wraps `turnTools` with `withBrowserOnDemand` ([src/main/browser/on-demand.ts:80–89](src/main/browser/on-demand.ts#L80-L89)), collapsing `browser_snapshot`, `browser_logs`, etc. into `browser_tools` (`effect: "read"`) and `browser_call` (`effect: "mutate"`). Consequently, native `run_code` ([src/main/harness/driver.ts:355, 409](src/main/harness/driver.ts#L355-L409)) does not expose `tools.browser_snapshot` directly, whereas MCP `run_code` ([src/main/index.ts:760](src/main/index.ts#L760)) bypasses `withBrowserOnDemand` and exposes `tools.browser_snapshot` while hiding `browser_tools`/`browser_call`. Unwrap `withBrowserOnDemand` inside `run_code`'s inner `scriptable` catalog so both surfaces expose the same direct tool bindings.
- **Un-awaited host promises outlive QuickJS return and commit state early:** in [src/main/harness/tools/code.ts:124–159](src/main/harness/tools/code.ts#L124-L159) and [275–296](src/main/harness/tools/code.ts#L275-L296), `pending` tracks `QuickJSDeferredPromise` handles only to `.dispose()` them in `finally`. If a script invokes a tool without `await` and returns, `context.resolvePromise(promise)` settles immediately, `o.state` commits at lines 143–146, and the host `o.broker` call continues running asynchronously in the background after `run_code` has already returned.
- **Guidance mismatch:** [code.ts:500–507](src/main/harness/tools/code.ts#L500-L507) says state-changing tools are unavailable after a missing-method error, even though the native script set can expose them through authorization. Generate descriptions/errors from the actual execution profile rather than imposing a false universal read-only contract.
- **No uniform schema contract:** [ts-decl.ts](src/main/harness/tools/ts-decl.ts) handles a useful subset but not full references/intersections/dictionary semantics; TypeScript descriptions are not type-checking. App argument validation can strip unknown keys, while native aliases/coercions differ. Validate canonical arguments after explicit normalization.
- **Host work is not VM work:** VM memory/time limits do not bound Node-side logs, queued promises, host result buffers, schema serialization or synchronous fallback regex work. [code.ts:199–203](src/main/harness/tools/code.ts#L199-L203) accumulates console output; error output does not pass through the successful result's bound path.
- **A result limit is not a scan budget:** [read.ts:59–86](src/main/harness/tools/read.ts#L59-L86) reads a whole file before applying a requested window/size check; [glob.ts:137–156](src/main/harness/tools/glob.ts#L137-L156) collects/stats all matches before limiting; ripgrep output is fully buffered before shaping. Fix upstream work, not only final text length.
- **Search completeness is implicit:** grep can cut content lines at 4,000 characters, omit some fallback files and return limited arrays with no typed completeness metadata. A script must not report an exhaustive answer from a bounded sample.
- **Audit suppression:** after 40 calls, the broker stops emitting individual child rows: [code-broker.ts:63–85](src/main/harness/tools/code-broker.ts#L63-L85). UI folding should not erase the underlying record of effects.
- **Attribution/cleanup & per-thread map leaks:** the first traced MCP child may still wait for parent discovery ([src/main/code-mode.ts:108–110](src/main/code-mode.ts#L108-L110)); request identity should replace polling. Furthermore, `codeStateBySession` ([src/main/harness/driver.ts:101](src/main/harness/driver.ts#L101)), `fixed` ([src/main/code-mode.ts:37](src/main/code-mode.ts#L37)), and `states`, `reads`, `tools` ([src/main/code-mode.ts:83–85](src/main/code-mode.ts#L83-L85)) are never evicted when `deleteThread` or `deleteProject` runs ([src/main/service.ts:325–350](src/main/service.ts#L325-L350), [src/main/index.ts:2100–2108](src/main/index.ts#L2100-L2108)).
- **Uptake & nested-sandbox double hops:** native mode hides direct read/glob/grep ([src/main/harness/driver.ts:412, 564](src/main/harness/driver.ts#L412)) and hints broadly encourage scripting. Meanwhile, [src/main/code-hint.ts:7–11](src/main/code-hint.ts#L7-L11) instructs OpenCode v2 (`execute`) and Codex (`exec`) to run JS inside their own sandbox that passes string-escaped JS into `run_code`. Evaluate hybrid direct-plus-script routing and direct typed MCP calls against double-sandbox string escaping rather than counting high script usage as success.

### 3.4 Multi-driver Code Mode architecture matrix in CubiQ

| Dimension | Native Harness ([src/main/harness/driver.ts](src/main/harness/driver.ts)) | Claude SDK ([src/main/agents/claude.ts](src/main/agents/claude.ts)) | Codex App-Server ([src/main/agents/codex.ts](src/main/agents/codex.ts)) | ACP / OpenCode ([src/main/agents/acp/driver.ts](src/main/agents/acp/driver.ts)) |
|---|---|---|---|---|
| **Outer tool registration** | In-process `createCodeTool` (`run_code`) added to `tools`; `LOOK_TOOLS` (`read`, `glob`, `grep`) hidden from outer model ([driver.ts:400–412](src/main/harness/driver.ts#L400-L412)). | In-process SDK MCP server (`mcp__cubiq__run_code`) via `codeServer.tool(threadId)` with `{ alwaysLoad: true }` ([claude.ts:123, 590](src/main/agents/claude.ts#L123)). | 3 modes: `CUBIQ_CODEX_EXEC_MODE=1` (`features.code_mode`), 0.159+ client `dynamicTools: [dynamicToolSpec(runCode)]`, or HTTP MCP `?c=<threadId>` ([codex.ts:1135–1143](src/main/agents/codex.ts#L1135-L1143)). | OpenCode v2 uses native `execute` + `OWN_CODE_MODE_HINT` (unless `CUBIQ_CODE_MODE=1` plugin lifts `run_code` top-level); other ACP agents use HTTP MCP `?c=<threadId>` ([acp/driver.ts:143–155, 1006–1008](src/main/agents/acp/driver.ts#L143-L155)). |
| **Inner scriptable catalog (`tools.*`)** | Full `scriptable` array (native `read`/`glob`/`grep`/`edit`/`write`/`apply_patch`/`bash`, `withBrowserOnDemand` pair, app tools, MCP router) excluding `EXCLUDED` ([code.ts:13](src/main/harness/tools/code.ts#L13), [driver.ts:409](src/main/harness/driver.ts#L409)). | Read-only subset via `createCodeServer`: native `read`/`glob`/`grep` + `appTools(threadId).filter(readsOnly)` (unwrapped browser reads + `search_tools`, no `call_mcp_tool`) ([code-mode.ts:74–98](src/main/code-mode.ts#L74-L98)). | Same `createCodeServer` read-only subset as Claude ([index.ts:751–767](src/main/index.ts#L751-L767)). | Same `createCodeServer` read-only subset as Claude ([index.ts:751–767](src/main/index.ts#L751-L767)). |
| **Authorization & `access`** | Outer `run_code` has `access: "edit"`, `parallel: false`; every inner call passes through `driver.ts:430–451` `authorize(tool, args, summary)`. | Outer `run_code` has `autoAllow: true`, `effect: "read"`; inner broker has no `authorize` callback because only `readsOnly` tools are exposed ([code-mode.ts:118](src/main/code-mode.ts#L118)). | Same as Claude (`autoAllow: true`, read-only inner broker). | Same as Claude (`autoAllow: true`, read-only inner broker). |
| **Parent-row attribution (`parentOf`)** | Direct: `call.id` is already the `run_code` `toolUseId` in `runLoop` ([code.ts:109](src/main/harness/tools/code.ts#L109)). | Polls `service.scriptParent(threadId, code)` up to `PARENT_WAIT_MS = 2000` ms on first child emission ([code-mode.ts:33, 108–110](src/main/code-mode.ts#L108-L110)). | Direct `ctx.parentId` when invoked via client `dynamicToolCall` ([codex.ts:51](src/main/agents/codex.ts#L51), [code-mode.ts:110](src/main/code-mode.ts#L110)); 2 s poll when invoked over HTTP MCP. | Polls `service.scriptParent(threadId, code)` up to 2 s ([code-mode.ts:108–110](src/main/code-mode.ts#L108-L110)); OpenCode v2 `execute` steps parsed via `scriptSteps` ([acp/driver.ts:1590–1604](src/main/agents/acp/driver.ts#L1590-L1604)). |
| **Session state (`store` / `load`)** | `codeStateBySession` `Map<sid, Map<string, string>>` ([driver.ts:101, 398](src/main/harness/driver.ts#L398)). | `states` `Map<threadId, Map<string, string>>` ([code-mode.ts:83, 111](src/main/code-mode.ts#L83)). | Shared `codeServer` `states` keyed by `threadId`. | Shared `codeServer` `states` keyed by `threadId`. |

## 4. Target architecture

```text
Intent + explicit scope + execution profile
  → discover exact operations + typed returns + examples
  → parse/normalize code; preflight before effects
  → isolated local executor
  → host broker: validate + authorize + budget + schedule
  → typed results / paged result references
  → script computes compact answer + evidence + optional UI descriptor
  → validate result, record outcome, commit versioned state
```

Use the Creator proposal's capability boundary, not a second Code Mode-only permission system. Share operation identity, schemas, grants, effect ordering, cancellation and evidence across direct/script/UI callers. Keep executor choice separate from agent choice and permission state.

### Execution profiles

- **Inspect:** host-approved non-mutating operations under the configured read roots/data/network grants. A read label alone does not make a remote operation trusted. Plan mode can use this profile.
- **Act:** explicitly script-eligible operations under ordinary per-call authorization, ordered by effect and resource key. No automatic permission elevation and no speculative parallel effects.
- **Excluded:** approval/grant operations, recursive agent/script spawning, destructive unreviewed work and raw arbitrary module/network access. Keep general shell execution separate until its own containment/approval design is justified.

Expose the same logical profiles and error/outcome contract through native, Claude/Codex/MCP and ACP adapters where supported. An unsupported engine/profile is visible and falls back to direct permitted calls, not a hidden reduction in enforcement. Preserve `off` behavior and existing chosen settings; this proposal does not change fresh/legacy install defaults.

## 5. Script capabilities and accuracy

### 5.1 Typed catalogs and preflight

Create canonical descriptors with input schema, output schema, exact binding name, effect, grants, timeout/idempotency policy and examples. Generate declarations/docs from these descriptors and validate them against fixtures. Use exact namespaced/bracket-access bindings when names are not identifiers; do not silently sanitize distinct tool names into the same API.

Support short discovery summaries and on-demand schemas/examples. Keep top-used primitives easy to reach. A fixed two-tool interface is not the goal: save total discovery/inference work without losing correctness. Cache indexes/declarations by catalog revision, not by mutable current descriptions alone.

Before effects, parse a recognized code body and reject unsupported syntax/imports. Normalize only supported wrappers/fences, with line mappings; do not guess a different program. Add optional semantic JS/TS preflight against selected operations/results if its accuracy gain justifies the compiler cost. Host input/output validation remains mandatory even when preflight succeeds. Unknown or recursive schemas degrade explicitly, never to invented fields.

### 5.2 Structured results, not presentation parsing

Use a versioned result envelope: status, typed data or scoped data reference, safe diagnostics, source/evidence references and completeness. Preserve numbers, identifiers, units, timestamps and structured MCP content. Large/private results stay in a local host store with bounded reads/queries; scripts operate on pages or opaque handles rather than repeatedly stringify entire datasets.

For searches, report the requested scope/window, truncation, skipped files/lines, continuation and whether counts are exact or lower bounds. Do not silently turn a capped result into `total` or a line clipped for UI into authoritative source content. Keep display clipping separate from tool data.

Useful bounded helpers include map-with-concurrency, tolerant batches, paged iteration, grouping/joins, deterministic sorting and explicit result projection. Add helpers demonstrated by real tasks, not an unrestricted package manager or hundreds of overlapping convenience functions. Domain math should preserve exact identifiers/monetary units and handle precision deliberately.

### 5.3 A useful script today

This uses existing APIs and **does not claim exhaustive coverage**:

```js
const paths = await tools.glob({ pattern: "src/**/*.ts", limit: 60 });
const files = await tools.readMany(paths, { offset: 1, limit: 200 });
const failed = files.filter(file => file.error);
const hits = files.flatMap(file => typeof file.content === "string"
  ? file.content.split("\n").flatMap((line, index) =>
      /TODO|FIXME/.test(line)
        ? [{ path: file.path, line: index + 1, text: line }]
        : [])
  : []);
return {
  coverage: "Up to 60 matching files, first 200 lines each; not exhaustive",
  selectedFiles: paths.length,
  errors: failed.map(file => ({ path: file.path, error: file.error })),
  findings: hits.slice(0, 30),
  findingsOmitted: Math.max(0, hits.length - 30),
};
```

The stronger v2 contract adds machine-readable completeness and revision-backed evidence so correctness no longer depends on a handwritten coverage sentence.

### 5.4 Concrete v2 TypeScript contracts

```ts
/** Versioned completeness metadata attached to search/read/MCP tool results inside Code Mode. */
export interface ResultCompleteness {
  exhaustive: boolean;
  returnedCount: number;
  /** Exact total when known, or lower bound when `exhaustive === false`. */
  totalCount?: number;
  skippedFiles?: number;
  clippedLines?: number;
  nextCursor?: { offset?: number; limit?: number; token?: string };
}

/** Content-addressed reference to a large payload stored via Store.writeBlob (src/main/db.ts:640). */
export interface BlobDataRef {
  kind: "blob-ref";
  sha256: string;
  bytes: number;
  schemaVersion: 1;
  preview?: unknown;
}

/** Canonical broker result returned to QuickJS and recorded in the execution journal. */
export interface BrokerCallEnvelope<T = unknown> {
  status: "succeeded" | "failed" | "cancelled" | "denied" | "partial";
  operationId: string;
  toolUseId: string;
  data?: T | BlobDataRef;
  text: string;
  completeness?: ResultCompleteness;
  diagnostics?: string[];
  revision?: number;
}
```

In `code.ts` and `code-broker.ts`, the CM0/CM1 runtime upgrade enforces four concrete invariants:

1. **Run-owned `AbortController`:** `createCodeTool.run` creates `const runAbort = new AbortController()`, links `call.signal` and the `timeoutMs` timer to `runAbort.abort()`, and passes `runAbort.signal` into `install()` and `o.broker(...)` so timeout immediately aborts in-flight `read`/`glob`/`grep`/MCP calls.
2. **Awaiting or cancelling un-awaited host work:** `install()` tracks every host `Promise` spawned by `defer()` in an `inFlightHost: Set<Promise<void>>`. Before `run_code` commits `o.state` or returns success, if `inFlightHost.size > 0`, it aborts/settles those dangling promises and marks the run error/partial rather than silently leaking background calls after `context.dispose()`.
3. **Keyed serial scheduling (`TargetLock` generalization):** `createCodeBroker` checks `runsInParallel(tool)` ([src/main/harness/loop.ts:92](src/main/harness/loop.ts#L92)). Independent reads (`parallel: true`) acquire a slot from the `MAX_IN_FLIGHT` semaphore, while serial/mutating calls (`parallel: false`) chain through a keyed lock (generalized from `TargetLock` in [src/main/browser/tools.ts:33–58](src/main/browser/tools.ts#L33-L58)) and re-check `signal.aborted` upon acquiring the lock.
4. **Revision-checked state commits:** `SessionCodeState` pairs `Map<string, string>` with a monotonic `revision: number` (or serializes stateful scripts per session) so two concurrent scripts cannot blindly `o.state.clear()` and overwrite one another's committed keys.

## 6. Safety, performance and lifecycle

1. **One execution owns its work.** Combine user/turn/deadline cancellation into a run-owned signal passed to every broker call. Cancel/remove queued requests, check abort/revocation again after acquiring a slot, and prevent late execution after timeout or approval expiry.
2. **Effects are ordered.** Permit bounded parallel independent reads; serialize mutations by operation/resource scope. Concurrency limits alone are not safe scheduling. Do not automatically retry unknown/partial effects.
3. **Structured concurrency.** Do not report completed success while un-awaited effectful calls remain. Reject or explicitly settle/cancel owned pending calls; report partial/unknown if external effects cannot be reconciled. State rollback is not rollback of tool side effects.
4. **Scope is host-owned.** Enforce allowed realpath roots and explicit outside-root grants, including symlinks. Account for installed skill documentation/expert resources that legitimately need read access. Never equate cwd with an authorization fence.
5. **Bound every layer.** Limit source/argument bytes, total calls, queue depth, concurrent work, result bytes, log bytes, stored values, retained results, CPU/active runtime and overall lifetime. Move VM evaluation/expensive marshalling off main; worker separation adds fault containment, not automatic OS confinement.
6. **Atomic state commit.** Serialize stateful runs per binding or use revision-checked commits with conflicts; do not replace a shared Map blindly. Treat prior results as revisioned observations, not forever-fresh cache. Add cleanup on thread/binding deletion and bounded expiry.
7. **Complete audit, compact UI.** Record operation IDs, input/result digests or redacted references, effects, approvals and outcomes for every call. Show a folded summary after the UI row budget; never stop recording later effects.
8. **Privacy follows data flow.** Keep credentials out of scripts. Filter/redact output before it reaches model, UI/log export or other tools; define allowed source-to-destination flows for opaque sensitive handles. “Not in model context” does not prove local-only handling.
9. **Human waits are not compute.** Approval waits release execution resources and retain a bounded pending ticket. A denied/expired/stopped script must not execute later. Durable resume requires code/catalog revisions and recorded-call replay; do not promise transparent arbitrary-VM snapshots.

For durable replay, completed operations return recorded results. Nondeterministic work needs recorded steps or restrictions, and resumable effects should be sequential until stable concurrent call identity is proven. Compensating actions are explicit and may fail; rollback cannot be promised for every connector.

## 7. GenUI integration

**Compute once; render the same data.** Code Mode returns typed data/evidence, and a host-approved presentation mapping attaches a versioned widget descriptor or data reference. The renderer chooses a trusted React component. The model supplies short interpretation; it does not retype every row to manufacture `ui:` text.

Scripts may request presentation, but cannot issue approval tokens, register arbitrary React/HTML/JS, or authorize a widget action. UI event identity links thread, execution, result revision and operation provenance. User actions return through the same host capability boundary. See [enhancement-genui.md](enhancement-genui.md) for persistent widget/action states and streaming.

## 8. Delivery and verification

### Proposed implementation batches

| Batch | Deliverable | Main areas |
|---|---|---|
| CM0 | Cancellation, queue removal, serial effect scheduling, state conflict protection; regression probes become tests. | `code.ts`, `code-broker.ts`, `code-mode.ts`, focused tests. |
| CM1 | Canonical schemas/returns, consistent caller/profile policy, strict normalization, error/completeness envelopes. | capability descriptors, `ts-decl.ts`, native/app adapters, MCP router, read/search tools. |
| CM2 | Isolated executor, bounded host logs/results/scanning, scalable discovery and structured result references. | executor boundary, worker/process host, broker, result store; no renderer compiler bundle. |
| CM3 | Checked reusable recipes, versioned checkpoints, safe approval pause/resume and explicit compensations. | execution journal, state/recipe store, approval/lifecycle adapters. |
| CM4 | Typed script-result GenUI mapping and evaluated direct-versus-script routing. | shared result/UI DTOs, renderer adapters, matched task evals. |

Split each batch into small reviewed change sets. No application code is changed by this research; implementation requires explicit phase approval. Do not overwrite the older optimization plan or assume its historical findings are still present.

### Acceptance

- Timeouts/Stop/denial cause no new queued work to start; late effects are reconciled or explicitly unknown.
- Parallel independent reads work, but declared serial/conflicting mutations never overlap.
- Concurrent successful state updates cannot disappear silently.
- Native/MCP/ACP contracts are explicit; outside-root reads occur only under configured grants.
- Invalid arguments/results are caught with useful diagnostics; type examples and runtime schemas agree.
- Large bounded searches/logs use bounded host memory and report incomplete coverage honestly.
- All calls remain auditable; no secrets in model-visible results or persistent exports.
- Evaluate a small lookup, dependent read chain, 10k-record aggregation, paged search, malformed script, partial batch, guarded effect, denial, timeout, state race and typed UI result across supported engines.
- Use matched models/settings and report task correctness, inference rounds, returned tokens, host/runtime latency, first useful result, total completion time and total cost. Uptake alone is not a quality metric; published vendor percentages are not release gates.

**Verification completed:** the targeted existing Code Mode/GenUI suite passed **153 tests across 12 files** in **32.61 seconds**. The separate local probes reproduced four Code Mode gaps not covered by that passing baseline. See [the verification record](.ai/tmp/code-mode-genui-review/verification.md). Real provider benchmarks, the full suite, application typecheck/build and live Electron verification were not performed for this proposal.

## 9. Sources

1. [Anthropic advanced tool use — published 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use).
2. [Anthropic code execution with MCP — published 2025-11-04](https://www.anthropic.com/engineering/code-execution-with-mcp).
3. [Current programmatic tool calling API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).
4. [Current tool search API](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
5. [Current tool definitions/input examples](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).
6. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
7. [Cloudflare Code Mode overview](https://developers.cloudflare.com/agents/tools/codemode/).
8. [Cloudflare durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/).
9. [Cloudflare API reference: replay, structured results, snippets and executor contracts](https://developers.cloudflare.com/agents/tools/codemode/api-reference/).
10. [Model Context Protocol (MCP) specification: structuredContent and outputSchema](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content).
11. [OpenAI Responses API & Tool Search guide](https://platform.openai.com/docs/guides/tools-tool-search) and [OpenAI Codex developer documentation](https://developers.openai.com/codex).
12. [Google Gemini API: Function calling & thought signatures](https://ai.google.dev/gemini-api/docs/function-calling) and [Google Agent Development Kit (ADK)](https://adk.dev).
13. [DeepSeek API: Thinking mode & tool calls](https://api-docs.deepseek.com/guides/thinking_mode).
14. [Z.ai (Zhipu AI): GLM-4.6 / GLM-4.7 Interleaved & Preserved Thinking guide](https://docs.z.ai/guides/Capabilities/thinking).
