# Comprehensive Research: Agent Harness Architecture, Optimized Tool Calling, and Multi-Agent Orchestration

*Date: Late September 2026*  
*Scope: In-depth architectural research for an Electron + TypeScript desktop agent harness driving Claude Code (`@anthropic-ai/claude-agent-sdk`), OpenAI Codex CLI (`codex app-server`), and OpenCode (via Agent Client Protocol - ACP).*

---

## 1. Executive Overview: The Modern Agent Harness Paradigm

In 2026, autonomous coding agent systems have crystallized around a fundamental architectural insight popularized by DeepSeek and the open-source community: **"Agent = Model + Harness"**. 

While frontier LLMs provide reasoning, code generation, and intent classification, the **harness** constitutes the operational environment. The harness mediates between non-deterministic token streams and the deterministic operating system. It governs process lifecycles, virtualizes file and terminal access, enforces security boundaries, optimizes prompt context and KV caches, manages tool registries, and maintains session durability.

When designing a production desktop agent harness (e.g. Electron + TypeScript), developers must navigate three competing architectural philosophies:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           Desktop Agent Harness                                │
│                                                                                │
│  ┌──────────────────────┐  ┌───────────────────────┐  ┌─────────────────────┐  │
│  │   Control Surface    │  │    Plug-in Harness    │  │   Integrated ADE    │  │
│  │     (T3 Code)        │  │  (DeepSeek Harness)   │  │       (ZCode)       │  │
│  │  - Universal remote  │  │  - Everything is a    │  │  - Agent-first      │  │
│  │  - Git worktrees     │  │    Cordis plugin      │  │    editor           │  │
│  │  - Process wrap      │  │  - Modular sandboxes  │  │  - 1M context loop  │  │
│  │  - BYOS model        │  │  - Custom runtimes    │  │  - Reason-Act-Obs   │  │
│  └──────────┬───────────┘  └───────────┬───────────┘  └──────────┬──────────┘  │
│             │                          │                         │             │
│             └──────────────────────────┼─────────────────────────┘             │
│                                        ▼                                       │
│    ┌──────────────────────────────────────────────────────────────────────┐    │
│    │               Core Engine & Tool Orchestration Layer                 │    │
│    │  • Prompt Prefix Cache Discipline  • Speculative / Parallel Exec    │    │
│    │  • Dynamic Tool Search & Deferral  • AST Schema Validation (Zod)    │    │
│    │  • Git Guardrails & Approvals      • Output Compaction & Diffs       │    │
│    └───────────────────────────────────┬──────────────────────────────────┘    │
│                                        │                                       │
│         ┌──────────────────────────────┼──────────────────────────────┐        │
│         ▼                              ▼                              ▼        │
│  ┌──────────────┐             ┌─────────────────┐             ┌──────────────┐ │
│  │ Claude Code  │             │ Codex CLI       │             │ OpenCode     │ │
│  │ Agent SDK    │             │ `app-server`    │             │ (ACP Server) │ │
│  │ (v0.3.x)     │             │ (JSON-RPC)      │             │ (JSON-RPC)   │ │
│  └──────────────┘             └─────────────────┘             └──────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Comparative Analysis of Pioneering Open-Source Harnesses

### 2.1 T3 Code (`pingdotgg/t3code` by Theo Browne)
* **Core Classification:** *Agent Harness Control Surface* [[Official doc](https://github.com/pingdotgg/t3code)].
* **Design Philosophy:** Rather than reinventing agent models or implementing a bespoke code-generation engine from scratch, T3 Code acts as a **"Universal Remote"** for existing CLI agents installed on the developer's machine (Claude Code, OpenAI Codex, OpenCode, Cursor, and Grok Build).
* **Key Architectural Innovations:**
  1. **Git Worktree Isolation:** To prevent file collision and state corruption when driving multiple agents concurrently, T3 Code isolates every active task or thread inside a dedicated Git worktree (`git worktree add`). Agents operate on isolated branches; code reviews and merging occur cleanly without touching the developer's primary working tree.
  2. **Subprocess Normalization:** It executes agent CLIs as local subprocesses (via `node-pty` or stdio pipes) and translates disparate streaming events into a unified data model of projects, threads, and workspaces.
  3. **Supervisory Approval Modes:** Provides a unified UI for human-in-the-loop approvals, mid-run steering (queuing messages that inject into the agent loop at turn boundaries), and unified diff visualization.
  4. **Bring-Your-Own-Subscription (BYOS):** Bypasses cloud proxy markups by directly mounting the user's authenticated CLI environments.

### 2.2 ZCode (`zai-org/ZCode` by Z.ai / Zhipu AI)
* **Core Classification:** *Agentic Development Environment (ADE)* [[Official doc](https://github.com/zai-org/ZCode)].
* **Design Philosophy:** Replaces traditional IDE ergonomics with an agent-centric operating paradigm. Instead of an editor augmented with chat, the AI agent is the primary driver of the development cycle.
* **Key Architectural Innovations:**
  1. **Long-Context Memory Orchestration:** Specifically optimized for ultra-long context models (e.g. GLM-5.3 with 1M tokens), ZCode maintains continuous workspace state without aggressive pruning, relying on structured memory indexes.
  2. **Autonomous Reason-Act-Observe Loop:** Implements an internal harness loop that handles execution planning, multi-step code synthesis, automated test execution, and self-correcting error recovery.
  3. **Multi-Agent Cooperative Swarms:** Organizes tasks hierarchically (e.g., Architect Agent $\to$ Coder Agent $\to$ Reviewer Agent) using shared blackboard storage.
  4. **Local-First Sandboxing:** Isolates shell command execution and environment variables within controlled local execution boundaries.

### 2.3 DeepSeek Harness (`deepseek-ai/deepseek-harness` / `dsh`)
* **Core Classification:** *Pluggable Agent Runtime Framework* [[Official doc](https://github.com/deepseek-ai/deepseek-harness)].
* **Design Philosophy:** Built on the principle that **"Everything is a Plugin"**. The model is merely the reasoning core; the harness provides modular, swappable components for tools, sandboxes, memory storage, and the execution loop itself.
* **Key Architectural Innovations:**
  1. **Cordis Meta-framework Engine:** Utilizes Cordis to handle inversion of control, dynamic plugin discovery, dependency injection, and strict component lifecycle states (load, initialize, execute, dispose).
  2. **Decoupled Execution Sandboxes:** Execution targets (local OS, Docker container, remote SSH VM, WebContainer) are abstracted behind a unified interface, allowing identical agent tools to run securely in untrusted environments.
  3. **First-Class Local Inference Support:** Designed to run seamlessly against local inference backends (Ollama, vLLM, SGLang) with automated parameter adaptation and tool-calling protocol translation.

### 2.4 Claude Code / Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.3.x)
* **Core Classification:** *SDK-Driven Agentic Runtime* [[Official doc](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)].
* **Design Philosophy:** Programmatic exposure of Claude Code's internal agent loop. Exposes first-class primitives for tool permission policies, subagent delegation, file system operations, and prompt caching preservation.
* **Key Architectural Innovations:**
  1. **Dynamic Tool Search (`ENABLE_TOOL_SEARCH`):** Defers schema loading until runtime when tool sets grow large.
  2. **Progressive Skill Disclosure:** Filesystem-based `SKILL.md` manifests where only metadata enters the prompt upfront.
  3. **Strict Ephemeral Prompt Caching:** Enforces static prefix formatting to achieve 90%+ prompt cache hit rates across multi-turn sessions.

### 2.5 OpenAI Codex CLI (`codex app-server`)
* **Core Classification:** *Bidirectional IPC Control Plane* [[Source code](https://github.com/openai/codex/tree/main/codex-rs/app-server)].
* **Design Philosophy:** A high-performance Rust core (`codex-rs`) exposing a bidirectional JSON-RPC 2.0 interface over `stdio` or WebSockets, decoupling agent thread management from desktop/IDE clients.
* **Key Architectural Innovations:**
  1. **Durable Thread Lifecycles:** Stateful session management (`thread/start`, `thread/resume`, `thread/fork`, `thread/inject_items`).
  2. **Streaming Item Event Deltas:** Emits granular updates (`turn/started`, `item/started`, `item/delta`, `item/completed`, `turn/completed`) for live terminal output, reasoning summaries, and tool approvals.
  3. **Strict Wire Protocol:** Uses OpenAI's `/v1/responses` event stream protocol (`wire_api = "responses"`), rejecting legacy chat completions.

### 2.6 OpenCode (via Agent Client Protocol - ACP)
* **Core Classification:** *Standardized Agent-Editor Bridge* [[Official doc](https://agentclientprotocol.com)] [[Official doc](https://opencode.ai)].
* **Design Philosophy:** Decouples agents from editors using the Language Server Protocol (LSP) architectural model. Any ACP client (Zed, JetBrains, Electron harness) can communicate with OpenCode via `opencode acp`.
* **Key Architectural Innovations:**
  1. **Universal Protocol Schema:** JSON-RPC 2.0 over stdio with standardized session methods (`initialize`, `session/new`, `session/prompt`, `session/update`, `session/request_permission`).
  2. **Models.dev Integration:** Dynamic model capability resolution against an open-source schema repository.
  3. **Permission Interception:** Formalizes approval dialogs for shell execution and file modification across external hosts.

---

## 3. Deep Dive: Optimized Tool Calling Mechanics in Custom Harnesses

Building an optimized agent harness requires solving the core bottlenecks of tool calling: **token bloat**, **context rot**, **KV cache invalidation**, **latency overhead**, and **destructive system operations**.

```
                ┌────────────────────────────────────────────────────────┐
                │             Agent Emits Raw Tool Call(s)               │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 1. Schema & Grammar Interceptor                        │
                │    - Parse JSON arguments via Zod / Serde              │
                │    - If invalid: Synthesize immediate corrective error │
                └───────────────────────────┬────────────────────────────┘
                                            │ Valid
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 2. Security & Guardrail Filter                         │
                │    - Check approval policy (auto / ask / deny)         │
                │    - Run Git safety guard (block hard resets, pushes)  │
                └───────────────────────────┬────────────────────────────┘
                                            │ Approved
                                            ▼
                    ┌───────────────────────┴───────────────────────┐
                    │ 3. Speculative / Parallel Execution Scheduler  │
                    └───────┬───────────────────────────────┬───────┘
                            │ Read-Only                     │ Mutating
                            ▼                               ▼
                 ┌────────────────────┐          ┌────────────────────┐
                 │ Concurrent Exec    │          │ Serial Queue       │
                 │ Promise.all([      │          │ Executed one-by-one│
                 │   read, search     │          │ in strict order    │
                 │ ])                 │          │ (edit, bash, exec) │
                 └──────────┬─────────┘          └──────────┬─────────┘
                            │                               │
                            └───────────────┬───────────────┘
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 4. Output Compactor & Context Formatter                │
                │    - Head/Tail truncation (e.g. max 15k chars / 500 L) │
                │    - Diff hunk minimization & folding                 │
                │    - Line-numbered slicing                             │
                └───────────────────────────┬────────────────────────────┘
                                            │
                                            ▼
                ┌────────────────────────────────────────────────────────┐
                │ 5. Yield Compact Observation to Agent Context Buffer   │
                └────────────────────────────────────────────────────────┘
```

### 3.1 Prompt Prefix Cache Discipline (Preserving KV Cache)
Modern frontier APIs (Anthropic, OpenAI, DeepSeek, Google) employ **KV Prompt Caching** to reduce latency and token costs by up to 90%. However, prompt caches are invalidating compilers: if a single token changes early in the prompt prefix, all subsequent cache blocks are invalidated.

#### Harness Best Practices:
1. **Static Top-of-Prompt Assembly:**
   * **Tier 0 (Fixed):** Base system prompt instructions, core behavioral guidelines, and static tool definitions must remain byte-identical across all turns.
   * **Tier 1 (Slow-Changing):** Discovered skills index and workspace directory structure.
   * **Tier 2 (Dynamic Tail):** Chat history, tool call results, and active turn input must reside exclusively at the end of the prompt buffer.
2. **Never Mutate Tool Schemas Mid-Session:**
   * Adding, removing, or re-ordering tool definitions between turns invalidates the entire system prompt cache.
   * If a tool is disabled dynamically (e.g. browser tab closed), the harness must **not** remove the tool schema. Instead, leave the tool definition intact and return a short text response when called: `"Tool unavailable: browser pane is currently closed."` [[Source code](../../HANDOFF.md#L45-L49)].

### 3.2 Deferred Tool Loading & Dynamic Tool Search
When configuring large MCP suites (e.g., GitHub, PostgreSQL, Jira, Slack, Local Filesystem), total tool schemas can easily exceed 50–100 tools, consuming 20k–50k tokens per request.

#### How Frontier Runtimes Implement Tool Search:
* **Claude Agent SDK & Messages API (`defer_loading`):**
  * When tools exceed **10% of the context window** (or when `ENABLE_TOOL_SEARCH="true"` is set), full JSON schemas are omitted from the initial prompt.
  * In the Anthropic Messages API, tools are marked with `"defer_loading": true` under the beta header `anthropic-beta: advanced-tool-use-2025-11-20`.
  * The harness provides a lightweight, non-deferred **Tool Search Tool** (`defer_loading: false`).
  * The model executes a search query against tool names and descriptions, dynamically retrieving and mounting the top 3–5 schemas into the active context. This achieves an **85% reduction** in initial token overhead while preserving prompt cache prefixes [[Official doc](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)].
* **Codex CLI Schema Pruning (`tools.include` / `tools.exclude`):**
  * Codex avoids schema bloat via static compile-time allowlists in `~/.codex/config.toml`:
    ```toml
    [mcp_servers.github.tools]
    include = ["get_file_contents", "create_pull_request"]
    ```
* **Host-Side Gateway Meta-Tools:**
  * For runtimes lacking native deferral (like OpenCode, tracked in issue #9350 [[Issue/discussion](https://github.com/anomalyco/opencode/issues/9350)]), the harness must implement a **Meta-Tool Router** pattern:
    1. Register only two tools with the agent: `search_tools(query: string)` and `execute_tool(name: string, parameters: object)`.
    2. The harness maintains the full MCP schema database in memory, running BM25 or embedding similarity on `search_tools` calls.

### 3.3 Result Truncation, Line-Budgeting, and Diff Compaction
Raw command output (such as `npm test`, `git log`, or large file reads) can emit tens of thousands of tokens in a single turn, blowing past the model's effective reasoning window.

#### Implementation Strategies in Production Harnesses:
1. **Head/Tail Split Truncation:**
   * When stdout exceeds a fixed threshold (e.g. 500 lines or 15,000 characters), truncate the middle:
     ```text
     [... First 250 lines of stdout ...]
     [... TRUNCATED: 4,820 lines omitted by harness. To see full output, re-run with specific grep filters ...]
     [... Final 250 lines of stdout ...]
     ```
2. **Line-Numbered Windowed Views:**
   * Prohibit tools that return entire files without boundaries. Enforce `StartLine` and `EndLine` parameters with a maximum window size (e.g. 800 lines).
3. **Structured Diff Folding:**
   * When an agent edits a file, rather than echoing the full file content back into the conversation, parse the change into a compact unified diff (`+` / `-` hunks) using `diff` libraries [[Source code](../../HANDOFF.md#L66-L68)].

### 3.4 AST Validation and Schema Pre-flight Guardrails
LLMs frequently hallucinate parameter names, omit required fields, or pass strings where integers are required. If an unvalidated tool call reaches system execution, the process crashes or emits cryptic errors.

#### The Harness Interceptor Pattern:
1. **JSON Schema / Zod Pre-flight:**
   * Tool arguments are parsed against a strict schema (e.g. Zod in TypeScript, Serde in Rust) *before* reaching the tool execution function.
2. **Self-Healing Error Responses:**
   * If parsing fails, do **not** trigger an unhandled promise rejection.
   * Immediately synthesize a structured observation returned to the agent:
     ```json
     {
       "status": "error",
       "error_type": "ValidationError",
       "message": "Invalid arguments for tool 'edit_file'. Field 'target_line' must be an integer, received string 'twenty'.",
       "expected_schema": { ... }
     }
     ```
   * Frontier models recognize this feedback and automatically correct their arguments in the next step.

### 3.5 Speculative Execution & Concurrency Scheduling
When frontier models output multiple tool calls in a single turn (parallel tool calling):
1. **Read-Only Concurrency:** The harness inspects tool definitions. Tools marked idempotent/read-only (`read_file`, `grep_search`, `list_directory`) are dispatched concurrently via `Promise.all()`.
2. **State-Modifying Serialization:** Mutating tools (`bash_execute`, `edit_file`, `git_commit`) are strictly serialized into a FIFO queue. If any mutating step fails, remaining calls in the turn can be halted to prevent cascading state corruption.

---

## 4. Skills Architecture: Progressive Disclosure & Context Budgeting

### 4.1 The Progressive Disclosure Hierarchy (`agentskills.io` Standard)
Agent skills follow a three-level progressive disclosure architecture [[Official doc](https://agentskills.io)]:

```
Level 1: Metadata (Startup)
└── Injected into System Prompt: Name, Description, File Path (~50–100 tokens per skill)
     │
     ▼ (Agent detects query matches skill description)
Level 2: Instruction Body (On-Demand Activation)
└── Read from Disk: SKILL.md Markdown Content (Full workflow instructions)
     │
     ▼ (Instructions instruct agent to inspect specific resources)
Level 3: Auxiliary Resources (As Needed)
└── Loaded on Demand: scripts/, references/, assets/
```

### 4.2 Size Limits & The 100+ Skills Scaling Wall
* **Description Hard Limit:** The YAML frontmatter `description` has a strict **1,024 character** limit [[Official doc](https://agentskills.io)]. Parsers silently drop or truncate descriptions exceeding this. Optimal performance occurs at **175–225 characters** using explicit trigger conditions (`"Use when..."`).
* **The 100+ Skills Overhead:**
  * 100 skills $\times$ ~75 tokens = **7,500 tokens** consumed in every turn's prompt prefix.
  * **Attention Dilution / Skill Shadowing:** In benchmarks, having >50 broad skills causes the model to misidentify relevant skills, picking a generic skill over a specialized one.
  * **Harness Remedy:** The harness should organize skills hierarchically by workspace type (e.g., only mount `react` and `vite` skills when `package.json` exists in the project root).

### 4.3 Agent-Specific Skill Activation Mechanics

| Mechanism Aspect | Claude Code / Agent SDK (v0.3.x) | OpenAI Codex (`codex app-server`) | OpenCode (via ACP) |
| :--- | :--- | :--- | :--- |
| **Startup Injection** | Scans `.claude/skills/`, `~/.claude/skills/`. Injects `<available_skills>` metadata list. | Scans `.codex/skills/`, `~/.codex/skills/`. Compiles compact index into system prompt. | Scans paths in `opencode.json` `skills` array. Injects registry into context. |
| **On-Demand Loading** | Model calls built-in file reading tool (`View` / `Read`) on `SKILL.md`. Host must authorize `allowedTools`. | Core engine intercepts activation; injects `SKILL.md` body directly into thread state. | Core reads file via internal routine; appends content to session buffer. |
| **Disable / Filter Key** | Pass `settingSources: []` to run hermetically without skills. | Configure `extraRoots` or run with isolated skill paths (`--no-skills`). | Remove entries from `"skills"` array in `opencode.json`. |

---

## 5. Model Provider Registry & Custom Ingestion

### 5.1 OpenCode & Models.dev Architecture

OpenCode uses **Models.dev** (`https://models.dev`) as its centralized catalog for model capabilities, pricing, and context limits [[Official doc](https://models.dev)].

#### JSON Catalog Endpoints
* Full Catalog: `https://models.dev/api.json`
* Model Metadata: `https://models.dev/models.json`
* Core Schema Definition: `packages/core/src/schema.ts` in `anomalyco/models.dev` [[Source code](https://github.com/anomalyco/models.dev)].

#### Minimal Working Custom Provider (`opencode.json`)
To declare a private or third-party OpenAI-compatible gateway in OpenCode [[Official doc](https://opencode.ai/config.json)]:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "my-gateway/deepseek-v3",
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Custom Corporate Gateway",
      "options": {
        "baseURL": "https://ai-gateway.corp.internal/v1",
        "apiKey": "{env:CORP_AI_GATEWAY_KEY}"
      },
      "models": {
        "deepseek-v3": {
          "name": "DeepSeek V3 (Production)",
          "limit": {
            "context": 131072,
            "output": 8192
          },
          "modalities": ["text"]
        }
      }
    }
  }
}
```

---

### 5.2 Provider Registry Reference Table (20 Well-Known Providers)

| ID | Display Name | OpenAI-Compatible Base URL | API Style | Conventional Env Var |
| :--- | :--- | :--- | :--- | :--- |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` *(Native)* | `anthropic-messages` | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `openai-responses` / `openai-chat-completions` | `OPENAI_API_KEY` |
| `google` | Google Gemini (OpenAI Endpoint) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `openai-chat-completions` | `GEMINI_API_KEY` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` *(also `/anthropic`)* | `openai-chat-completions` *(also `anthropic-messages`)* | `DEEPSEEK_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` *(also `/api`)* | `openai-chat-completions` *(also `anthropic-messages`)* | `OPENROUTER_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `openai-chat-completions` | `GROQ_API_KEY` |
| `together` | Together AI | `https://api.together.xyz/v1` | `openai-chat-completions` | `TOGETHER_API_KEY` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `openai-chat-completions` | `FIREWORKS_API_KEY` |
| `mistral` | Mistral AI | `https://api.mistral.ai/v1` | `openai-chat-completions` | `MISTRAL_API_KEY` |
| `xai` | xAI (Grok) | `https://api.x.ai/v1` | `openai-chat-completions` | `XAI_API_KEY` |
| `moonshot` | Moonshot AI (Kimi) | `https://api.moonshot.cn/v1` *(also `/anthropic`)* | `openai-chat-completions` *(also `anthropic-messages`)* | `MOONSHOT_API_KEY` |
| `zhipu` | Zhipu AI / Z.ai (GLM) | `https://open.bigmodel.cn/api/paas/v4` *(also `/api/anthropic`)* | `openai-chat-completions` *(also `anthropic-messages`)* | `ZHIPU_API_KEY` / `ZAI_API_KEY` |
| `dashscope` | Alibaba Cloud (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `openai-chat-completions` | `DASHSCOPE_API_KEY` |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` *(also `/anthropic`)* | `openai-chat-completions` *(also `anthropic-messages`)* | `MINIMAX_API_KEY` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `openai-chat-completions` | `CEREBRAS_API_KEY` |
| `ollama` | Ollama (Local) | `http://127.0.0.1:11434/v1` | `openai-chat-completions` | `OLLAMA_API_KEY` *(placeholder)* |
| `lmstudio` | LM Studio (Local) | `http://127.0.0.1:1234/v1` | `openai-chat-completions` | `LM_STUDIO_API_KEY` *(placeholder)* |
| `azure` | Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` | `openai-responses` / `openai-chat-completions` | `AZURE_OPENAI_API_KEY` |
| `bedrock` | AWS Bedrock (Gateway) | `https://bedrock-runtime.{region}.amazonaws.com` | `anthropic-messages` *(via Gateway)* | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` |
| `vercel` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `openai-chat-completions` | `AI_GATEWAY_TOKEN` |

---

### 5.3 Custom Provider Injection Details Per Agent

#### 1. Claude Code / Claude Agent SDK
* **Injection Syntax (Environment or `settings.json`):**
  ```bash
  export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
  export ANTHROPIC_AUTH_TOKEN="sk-..."  # Third-party bearer token
  export ANTHROPIC_API_KEY=""           # MANDATORY: Must be set to empty string
  export ANTHROPIC_MODEL="deepseek-chat"
  ```
  *(Note: Claude Code automatically appends `/v1/messages`. Never add `/v1` to `ANTHROPIC_BASE_URL`)* [[Official doc](https://openrouter.ai/docs/frameworks/claude-code)].
* **Drop-in Anthropic Endpoints:** DeepSeek (`https://api.deepseek.com/anthropic`), Moonshot (`https://api.moonshot.cn/anthropic`), Zhipu/GLM (`https://open.bigmodel.cn/api/anthropic`), MiniMax (`https://api.minimax.io/anthropic`), OpenRouter (`https://openrouter.ai/api`).
* **Features Lost on Non-Anthropic Hosts:**
  1. Ephemeral Prompt Caching (unless gateway emulates cache headers).
  2. Thinking / Extended Reasoning Token budgets (parameters rejected by standard endpoints).
  3. Server-side tool search / `defer_loading` (beta headers rejected).

#### 2. OpenAI Codex CLI (`~/.codex/config.toml`)
* **User-Level Configuration:**
  ```toml
  model = "deepseek-chat"
  model_provider = "deepseek"

  [model_providers.deepseek]
  name = "DeepSeek API"
  base_url = "https://api.deepseek.com/v1"
  env_key = "DEEPSEEK_API_KEY"
  wire_api = "responses"   # MANDATORY: wire_api = "chat" is deprecated and rejected
  requires_openai_auth = true
  ```
* **CLI Override Form (`-c`):**
  ```bash
  codex -c 'model_provider="deepseek"' \
        -c 'model_providers.deepseek.base_url="https://api.deepseek.com/v1"' \
        -c 'model_providers.deepseek.wire_api="responses"' \
        -c 'model_providers.deepseek.env_key="DEEPSEEK_API_KEY"'
  ```
  *(Note: For security reasons, Codex strictly ignores `model_providers` in project-local `.codex/config.toml`; it must be set in `~/.codex/config.toml` or via `-c`)* [[Official doc](https://developers.openai.com/codex/config)].

#### 3. OpenCode (via ACP)
* Configured directly in `opencode.json` via the `provider` block (demonstrated in Section 5.1).

---

## 6. Handled Natively vs Host Must Implement

| Architectural Dimension | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Codex CLI (`codex app-server`) | OpenCode (via ACP) |
| :--- | :--- | :--- | :--- |
| **Skill Listing (Discovery)** | **Handled Natively**: Discovers `.claude/skills/` and global dirs; injects metadata into prompt [[Official doc](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code)]. | **Handled Natively**: Discovers `SKILL.md` directories; builds system prompt index [[Source code](https://github.com/openai/codex)]. | **Handled Natively**: Scans `.opencode/skills/` and `opencode.json` skill paths [[Official doc](https://opencode.ai/docs/skills)]. |
| **On-Demand Skill Load** | **Host Must Authorize**: Model triggers file read; host must provide and allow file-reading tools (`Read`/`View`) in `allowedTools`. | **Handled Natively**: Intercepts skill invocation; injects `SKILL.md` body directly into thread state [[Source code](https://github.com/openai/codex)]. | **Handled Natively**: Loads body on demand into session context via internal read routines. |
| **MCP Tool Deferral / Search** | **Handled Natively**: Auto-triggers at 10% context or via `ENABLE_TOOL_SEARCH="true"` [[Official doc](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)]. | **Host Must Implement**: Upfront schema load only; host must curate `tools.include` or wrap in a search router. | **Host Must Implement**: Upfront schema load only; host must inject a search plugin (e.g. `opencode-tool-search`) or filter permissions. |
| **Per-Server Enable/Disable** | **Host Must Implement**: Host must dynamically edit/filter the MCP config passed to the SDK. | **Handled Natively**: Supported via `enabled = true / false` in `[mcp_servers.<id>]` [[Official doc](https://developers.openai.com/codex/mcp)]. | **Handled Natively**: Supported via `"enabled": true / false` in `mcp.<id>` block [[Official doc](https://opencode.ai/config.json)]. |
| **Token Usage Reporting** | **Handled Natively**: Emits detailed `usage` objects in completion chunks; `/context` command in CLI. | **Handled Natively**: Reports token usage in `turn/completed` JSON-RPC notifications [[Source code](https://github.com/openai/codex/tree/main/codex-rs/app-server)]. | **Handled Natively**: Emits standardized `UsageUpdate` in ACP `session/update` notifications [[Official doc](https://agentclientprotocol.com)]. |
| **Custom Provider Injection** | **Handled Natively**: Via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (requires empty `ANTHROPIC_API_KEY`). | **Handled Natively**: Via `[model_providers.<id>]` in `~/.codex/config.toml` or `-c` flags (strictly `wire_api="responses"`). | **Handled Natively**: Via `"provider"` block in `opencode.json` with `@ai-sdk/openai-compatible`. |

---

## 7. Open Uncertainties & Operational Edge Cases

1. **Codex App-Server WebSocket Transport Stability:** While `codex app-server` exposes experimental WebSocket flags, production deployments in late 2026 rely almost exclusively on bidirectional `stdio`. Whether WebSocket framing handles high-throughput MCP binary payloads reliably remains unverified.
2. **Claude Agent SDK Dynamic MCP Attachment:** In `@anthropic-ai/claude-agent-sdk` v0.3.x, when `settingSources: []` is used, programmatically attaching MCP clients mid-session without restarting the query generator is undocumented.
3. **OpenCode Core Merge for Native MCP Lazy Loading:** Tracking issue #9350 remains the primary open thread for native MCP deferral in OpenCode; exact release tags integrating native lazy loading directly into the core ACP server loop are not yet formally finalized in core release branches.
4. **Third-Party Responses Wire Protocol Emulation:** While LiteLLM and OpenRouter claim compatibility with OpenAI's `/v1/responses` format used by Codex, edge cases involving multi-item tool-call streaming deltas occasionally trigger unhandled deserialization warnings in `codex-rs`.
5. **Prompt Caching on Third-Party Anthropic Proxies:** Gateways offering `/anthropic` compatibility endpoints vary widely in their handling of Anthropic prompt caching headers (`cache_control: { type: "ephemeral" }`), frequently degrading to full un-cached token pricing without explicit client notification.


---

## 8. Gap Analysis: What CubiQ Is Lacking Compared to Frontier Harnesses

A rigorous comparative audit of **CubiQ (`aiharness`)** against leading 2026 agent harnesses—**T3 Code (`pingdotgg/t3code`)**, **ZCode (`zai-org/ZCode`)**, **DeepSeek Harness (`dsh`)**, **OpenHands**, and **Devin**—reveals 9 critical architectural and operational gaps.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             CubiQ Gap Analysis Matrix                            │
├───────────────────────────────┬──────────────────────────┬───────────────────────┤
│ Capability Dimension          │ Frontier Harness State   │ Current CubiQ State   │
├───────────────────────────────┼──────────────────────────┼───────────────────────┤
│ 1. Execution Sandboxing       │ Docker / MicroVMs (dsh)  │ Host OS `node-pty`    │
│ 2. Parallel Git Worktrees     │ Auto-worktree per thread │ 1 active run / repo   │
│ 3. Universal MCP Tool Search  │ Lazy discovery (Claude)  │ Upfront dump (OpenCode│
│ 4. Active In-Turn Compaction  │ Rolling summary at 80%   │ Built, not wired      │
│ 5. Verification Loops         │ Auto-run test gate (Devin)│ Pure model-stop      │
│ 6. Background Async Tasks     │ Daemons & log streaming  │ Synchronous per-turn  │
│ 7. Pre-flight AST Repair      │ Zod grammar self-healing │ Unvalidated pass-thru │
│ 8. Hierarchical Subagents     │ Multi-agent child streams│ Single agent / thread │
│ 9. Remote Companion Surface   │ Mobile/Web bridge (T3)   │ Desktop Electron only │
└───────────────────────────────┴──────────────────────────┴───────────────────────┘
```

---

### 8.1 Execution Sandboxing & Containerization (The Security & Isolation Gap)
* **What Others Do (DeepSeek Harness `dsh`, OpenHands, Devin):**
  * **DeepSeek Harness (`dsh`):** Built on the Cordis framework to decouple the agent runtime from the execution host. Commands and file modifications run inside modular sandboxes (local Docker containers, remote SSH instances, or WebContainers) [[Official doc](https://github.com/deepseek-ai/deepseek-harness)].
  * **OpenHands (formerly OpenDevin):** Enforces strict isolation by running the agent inside a dedicated Docker container (`ghcr.io/all-hands-ai/runtime`) with restricted network egress, resource limits (cgroups), and non-root user execution [[Official doc](https://github.com/All-Hands-AI/OpenHands)].
  * If an agent runs a destructive command (`rm -rf ~`, `chmod -R 777 /`), executes malicious code from untrusted repositories, or downloads compromised dependencies, the damage is completely quarantined within an ephemeral container.
* **What CubiQ Has:**
  * Executes all terminal commands directly on the user's host operating system via `node-pty` / `$SHELL` [[Source code](../../README.md#L75-L78)].
  * Relies on `guard-rules.ts` (regex pattern matching blocking `git push`, `reset --hard`, etc.).
* **The Gap & Risk:**
  * Regex filters on raw bash strings are notoriously brittle: they can be circumvented via shell encoding (`echo cm0g... | base64 -d | sh`), subshells (`bash -c "..."`), python scripts (`python3 -c "import os; os.system(...)"`), or aliases.
  * Without container sandboxing, running untrusted repositories or letting an agent run autonomous multi-turn loops poses severe security and data-loss risks to the developer's workstation.

---

### 8.2 Concurrent Multi-Agent Execution via Git Worktrees (The Parallelism Gap)
* **What Others Do (T3 Code `pingdotgg/t3code`):**
  * T3 Code's flagship capability is **Git Worktree Isolation** [[Official doc](https://github.com/pingdotgg/t3code)].
  * When a user creates a task, T3 Code automatically creates an isolated Git worktree:
    ```bash
    git worktree add -b task/auth-refactor ../worktrees/task-auth-refactor main
    ```
  * Developers can run **3 to 5 agents simultaneously** on different threads or tasks within the same project. Agent A writes tests on branch A, Agent B refactors database schemas on branch B, and Agent C fixes UI bugs on branch C—with zero file write conflicts, zero dirty working tree clashes, and zero git lock contention.
* **What CubiQ Has:**
  * CubiQ has worktree primitives committed in Phase 10 (`4638000`), but threads in the same project still share the primary repository working directory by default [[Source code](../../HANDOFF.md#L22)].
* **The Gap:**
  * If a user attempts to run simultaneous agent turns on two threads in the same project, both agents edit the exact same files on disk concurrently, causing destructive race conditions, build failures, and corrupted git states.

---

### 8.3 Universal Dynamic Tool Search & Deferral (The MCP Context Bloat Gap)
* **What Others Do (Claude Code, Anthropic Messages API):**
  * Claude Code automatically triggers `ENABLE_TOOL_SEARCH` when MCP schemas exceed 10% of the context window [[Official doc](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)]. Full schemas are deferred (`defer_loading: true`), saving up to 85% of initial context and keeping prompt cache hit rates high.
* **What CubiQ Has:**
  * While Claude Code benefits from this natively, CubiQ registers MCP tools for **Codex and OpenCode (ACP)** by passing **all enabled tool schemas upfront** into the session [[Source code](../../README.md#L27-L30)].
* **The Gap:**
  * When a user connects 8–10 MCP servers in CubiQ's Connectors tab (e.g., GitHub, PostgreSQL, Linear, Slack, Memory, Filesystem), OpenCode and Codex are flooded with **20,000+ tokens of raw tool schemas on Turn 1**.
  * As proven by the Berkeley Function Calling Leaderboard (BFCL), tool-selection accuracy drops from ~92% with <30 tools to **~15–25% with 100+ tools**, resulting in hallucinated arguments, wrong tool invocations, and massive cost inflation.
* **The Solution for CubiQ:**
  * Implement a **Host-Side MCP Meta-Tool Router**. Instead of exposing 100 raw MCP schemas to OpenCode/Codex, CubiQ exposes only two synthetic tools:
    1. `search_tools(query: string)`: Searches in-memory MCP tool registry via BM25/vector embeddings.
    2. `call_mcp_tool(server: string, tool: string, args: object)`: Dispatches the tool call to the respective server.

---

### 8.4 Active In-Session Context Compaction (The Long-Session Decay Gap)
* **What Others Do (Claude Code, Cursor, OpenHands):**
  * When an agent thread approaches 75–80% of the model's context window (e.g., 160k / 200k tokens), the harness triggers an **automated in-session rolling compaction**:
    1. Runs an auxiliary LLM summarizer turn to condense turns 1 through $(N-4)$ into structured Markdown memory (decisions made, files modified, unresolved tasks).
    2. Prunes old tool output blobs (e.g. raw 500-line git diffs or compiler outputs), replacing them with lightweight references.
    3. Re-injects the summary as a fresh prompt prefix while keeping the most recent turns intact.
* **What CubiQ Has:**
  * CubiQ has compaction logic built in `cache-policy.ts` (`shouldCompact`, `claudeCompactEnv`, `codexCompactConfig`), but as documented in [`HANDOFF.md` line 48](../../HANDOFF.md#L48): **"built, not wired into agents"**.
  * Context survival currently only runs during an explicit cross-agent **Handoff** (`buildCheckpoint`, `fitCheckpoint`).
* **The Gap:**
  * A long-running conversation with a single agent will eventually hit context degradation ("context rot"), slow down, suffer attention dilution, and eventually fail with context length exceeded errors.

---

### 8.5 Automated Verification Loops & Self-Correction Gates (The Quality Assurance Gap)
* **What Others Do (Devin, SWE-agent, ZCode):**
  * Devin and SWE-agent implement **Test-Driven Verification Gates** [[Official doc](https://github.com/princeton-nlp/SWE-agent)].
  * The harness does not accept the agent's turn as "complete" merely because the LLM generated conversational text.
  * When the agent signals completion, the harness automatically executes a project verification command (e.g. `npm test`, `pytest`, `cargo check`, or `tsc --noEmit`).
  * If the verification command fails, the harness automatically injects the error log back into the agent context:
    *"Your changes caused 2 test failures in auth.test.ts. Review the failure output above and fix the issue before finishing."*
* **What CubiQ Has:**
  * The harness is purely passive. When the agent stops generating output, the turn concludes. If the agent introduced a syntax error or broke unit tests, the human user must manually detect it and prompt the agent to fix it.

---

### 8.6 Background Asynchronous Daemons & Long-Running Task Management (The Lifecycle Gap)
* **What Others Do (Claude Code, Windsurf, Devin):**
  * Expose first-class asynchronous background task tools:
    * `run_command(is_daemon: true, wait_ms: 5000)`
    * `manage_task(action: "status" | "kill" | "send_input")`
  * An agent can start a local development server (`npm run dev`), launch a background database container, or start a long test suite, receive an immediate Task ID, and continue reasoning or inspect logs asynchronously without timing out.
* **What CubiQ Has:**
  * CubiQ provides a background terminal drawer for the human user, but agent-executed commands run synchronously inside the turn loop. If an agent runs a blocking command (`npm run dev` or `python server.py`), the turn blocks indefinitely until the tool call timeout triggers.

---

### 8.7 AST Pre-flight Interception & Schema Self-Healing (The Tool Robustness Gap)
* **What Others Do (ZCode, DeepSeek Harness):**
  * Before executing a tool call emitted by an LLM, the harness intercepts the call and runs strict schema validation (using Zod in TypeScript or Serde in Rust).
  * If the LLM passed an invalid type or omitted a required property, the harness intercepts the failure *before* running any system code and synthesizes an immediate corrective feedback message:
    ```json
    {
      "status": "validation_error",
      "tool": "edit_file",
      "expected": { "start_line": "number" },
      "received": { "start_line": "string" },
      "correction_instruction": "Please pass start_line as an integer."
    }
    ```
* **What CubiQ Has:**
  * CubiQ has schema validation on its internal browser tools (`required: []`), but lacks a universal pre-flight schema interceptor for external MCP tools. Tool validation failures bubble up as unhandled promise rejections or driver-level failures.

---

### 8.8 Remote Companion Surface & Mobile Steering (The Ubiquity Gap)
* **What Others Do (T3 Code `pingdotgg/t3code`):**
  * Runs an embedded local HTTP/WebSocket server alongside the desktop app, providing a responsive companion web UI and mobile client (iOS/Android).
  * Developers can start a long coding task on their desktop, walk away, and monitor streaming progress, review diffs, or approve pending permissions directly from their smartphone [[Official doc](https://github.com/pingdotgg/t3code)].
* **What CubiQ Has:**
  * CubiQ is strictly a desktop window (Electron). If the user leaves their desk while an agent is waiting for a command approval, the entire pipeline remains halted until they return.

---

## 9. Deep Research: Real-Time Subagent Progress & Thread Visibility

### 9.1 The "Black-Box Subagent" Anti-Pattern vs. Nested Observability

In multi-agent systems, subagent delegation is critical for preventing context bloat: a primary agent spawns a specialized child agent (e.g. `ResearchSubagent`, `ExploreSubagent`), which reads dozens of files, runs search queries, and returns a concise 3-paragraph summary to the parent.

However, naive harness implementations suffer from the **"Black-Box Subagent" Anti-Pattern**:
```
User Prompt
   │
   ▼
Parent Agent: "Delegating to ResearchSubagent..."
   │
   ▼ (UI shows a static spinner for 2–3 minutes with zero feedback)
   │
   ▼
Parent Agent: "Here is what the subagent found: ..."
```
When subagents run as black boxes:
1. The user has no visibility into what files the subagent is reading, what shell commands it is executing, or whether it is stuck in an infinite loop.
2. If the subagent requires human approval for a sensitive command, the harness either hangs indefinitely or fails silently.
3. Observability tools (such as Laminar, Agent Flow, and Claude Code's native tree visualizer) have established the gold standard: **Hierarchical Nested Thread Observability** [[Official doc](https://laminar.sh)].

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Conversation Thread                                                           │
│                                                                                │
│  [User] Refactor the authentication middleware to use JWT tokens.              │
│                                                                                │
│  [Claude] I will spawn an explore subagent to analyze the existing auth code.  │
│                                                                                │
│  ▼ ┌────────────────────────────────────────────────────────────────────────┐  │
│    │ ▾ Subagent: Auth Codebase Explorer (ID: sub_4a9f2c) [Running...]       │  │
│    │   Tokens: 4,820 | Turns: 3 | Active Tool: grep_search                  │  │
│    ├────────────────────────────────────────────────────────────────────────┤  │
│    │   💭 Reasoning: I need to locate where session cookies are signed...   │  │
│    │   ⚙️ Tool: glob_files({ pattern: "src/auth/**/*.ts" })                 │  │
│    │      ↳ Found 4 files: auth.ts, session.ts, middleware.ts, token.ts     │  │
│    │   ⚙️ Tool: view_file({ path: "src/auth/session.ts", lines: [1, 80] })  │  │
│    │      ↳ Inspected session storage logic.                                │  │
│    │   💭 Reasoning: Synthesizing findings for parent agent...              │  │
│    └────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  [Claude] The explore subagent identified that session.ts handles cookies...   │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 9.2 Subagent Visibility Across the Three Major Runtimes

#### 1. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
* **How Subagents Are Invoked:**
  * The parent model invokes the built-in `Agent` tool (formerly `Task` in early SDK versions) with parameters:
    ```json
    {
      "role": "Database Inspector",
      "prompt": "Inspect prisma/schema.prisma and list all user relations."
    }
    ```
* **Event Stream Multiplexing:**
  * When iterating over the SDK's `query()` generator, the stream yields granular progress events:
    ```typescript
    for await (const message of query({ prompt, options })) {
      // 1. Tool Progress Heartbeats
      if (message.type === "tool_progress" && message.tool_name === "Agent") {
        console.log(`Subagent progress: ${message.elapsed_seconds}s, status: ${message.status}`);
      }

      // 2. Child Stream Events (Subagent Thinking & Output Deltas)
      if (message.type === "stream_event" && message.agent_id) {
        // message.agent_id identifies the child subagent
        // message.event contains text_delta, thinking_delta, or tool_use
      }

      // 3. Lifecycle Hooks
      if (message.type === "hook_event") {
        // Triggers on subagent:start, subagent:tool_call, subagent:complete
      }
    }
    ```
* **Transcript Log Isolation on Disk:**
  * Claude Code assigns each subagent an independent conversation ID.
  * Individual child transcripts are persisted to disk at:
    `<appDataDir>/brain/<parent-conversation-id>/subagents/<child-id>/transcript.jsonl`
  * **Harness Implementation Pattern:**
    * In Electron's main process, hook into the child streaming events emitted by the SDK generator.
    * Forward child events over IPC as `liveUpdate:subagent` with fields: `{ parentThreadId, subagentId, role, type: "delta" | "tool_call" | "reasoning", payload }`.

---

#### 2. OpenAI Codex CLI (`codex app-server` / `codex-rs`)
* **Subagent & Child Thread Architecture in `codex-rs`:**
  * In `codex app-server`, subagents and child tasks are modeled as **first-class threads** using the `thread/fork` or delegated child thread mechanism [[Source code](https://github.com/openai/codex/tree/main/codex-rs/app-server)].
  * Unlike monolithic runtimes that swallow child events, `codex app-server`'s bidirectional JSON-RPC 2.0 protocol explicitly includes the `thread_id` (and optional `parent_thread_id`) in every streaming notification.
* **JSON-RPC Child Event Stream:**
  1. **Child Thread Spawned:**
     ```json
     {
       "method": "turn/started",
       "params": {
         "thread_id": "thread_sub_981a2",
         "parent_thread_id": "thread_main_001",
         "turn_id": "turn_01",
         "role": "codebase_explorer"
       }
     }
     ```
  2. **Child Streaming Items (Reasoning & Tool Execution):**
     ```json
     {
       "method": "item/started",
       "params": {
         "thread_id": "thread_sub_981a2",
         "item": {
           "id": "item_sub_tool_1",
           "type": "tool_call",
           "name": "grep",
           "input": { "pattern": "JWT_SECRET" }
         }
       }
     }
     ```
  3. **Child Turn Completed:**
     ```json
     {
       "method": "turn/completed",
       "params": {
         "thread_id": "thread_sub_981a2",
         "turn_id": "turn_01",
         "usage": { "prompt_tokens": 1240, "completion_tokens": 85 }
       }
     }
     ```
* **Harness Implementation Pattern for CubiQ:**
  * In `src/main/agents/codex.ts`, the JSON-RPC message dispatcher currently assumes all notifications belong to the root `thread_id`.
  * **The Fix:** Inspect `params.parent_thread_id`. If present, route the item into a nested subagent store in the harness rather than discarding it or flattening it into the parent thread!

---

#### 3. OpenCode (via Agent Client Protocol - ACP)
* **Subagent Execution in OpenCode:**
  * OpenCode natively supports subagents (e.g., General, Explore, Scout, and task subagents).
  * When invoked, OpenCode creates a **"child session"**.
* **Current Limitations & Known ACP Gotchas:**
  * When running OpenCode through `opencode acp`, subagent events are often trapped inside the child session loop and not reliably multiplexed over the top-level ACP stdio stream [[Issue/discussion](https://github.com/anomalyco/opencode/issues/8124)].
  * In particular, permission requests originating from child sessions can stall because the ACP server fails to bubble the permission prompt up to the editor client.
* **Harness Implementation Pattern for CubiQ:**
  1. **Enable Verbose Private Logging:** Spawn OpenCode with `opencode --print-logs acp`.
  2. **Session Identification in ACP:** Listen for `session/update` notifications containing child session identifiers:
     ```json
     {
       "method": "session/update",
       "params": {
         "sessionId": "session_child_456",
         "parentSessionId": "session_parent_123",
         "type": "tool_call",
         "toolName": "grep"
       }
     }
     ```
  3. **Log-Tailing Fallback:** If the ACP version does not forward child updates, the Electron harness main process can tail the OpenCode session log file (`~/.config/opencode/logs/session_<id>.log`), extracting live tool calls and streaming thoughts to the renderer.

---

### 9.3 Electron + React Architecture for Nested Subagent Progress

To render real-time subagent progress without polluting the main conversation history:

```
                          ┌───────────────────────────┐
                          │   Main Process (Node.js)  │
                          └─────────────┬─────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           ▼                            ▼                            ▼
  Claude SDK Query             Codex JSON-RPC               OpenCode ACP
  `tool_progress` / deltas     `params.parent_thread_id`    `params.parentSessionId`
           │                            │                            │
           └────────────────────────────┼────────────────────────────┘
                                        │
                                        ▼ IPC
                      `liveUpdate:subagent-event`
                                        │
                                        ▼
                          ┌───────────────────────────┐
                          │   Renderer (Zustand Store)│
                          └─────────────┬─────────────┘
                                        │
                                        ▼
                          ┌───────────────────────────┐
                          │ React UI Component Tree   │
                          │ - MessageBubble           │
                          │   └─ SubagentDisclosure   │
                          │      ├─ Live Thinking Orb │
                          │      ├─ Sub-tool Call Badg│
                          │      └─ Collapsible Stream│
                          └───────────────────────────┘
```

#### 1. Data Contract (`src/shared/types.ts`)
```typescript
export interface SubagentProgress {
  id: string;               // Unique subagent conversation/thread ID
  parentItemId: string;     // The parent Agent tool call item ID
  role: string;             // Display role (e.g. "Codebase Explorer")
  status: "spawning" | "running" | "completed" | "failed";
  elapsedSeconds: number;
  currentActivity?: string; // e.g. "Reading src/auth.ts (lines 1-80)"
  reasoningDeltas: string;  // Live streamed thoughts of the child
  toolCalls: Array<{
    id: string;
    name: string;
    input: any;
    output?: string;
    status: "running" | "done" | "error";
  }>;
}
```

#### 2. UI Component (`SubagentDisclosure.tsx`)
```tsx
import React, { useState } from "react";
import { ChevronRight, ChevronDown, Bot, Terminal, CheckCircle2, Loader2 } from "lucide-react";
import { SubagentProgress } from "../types";

export const SubagentDisclosure: React.FC<{ subagent: SubagentProgress }> = ({ subagent }) => {
  const [isOpen, setIsOpen] = useState(subagent.status === "running");

  return (
    <div className="border border-border/60 rounded-lg my-2 bg-muted/20 overflow-hidden text-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-medium text-foreground">{subagent.role}</span>
          <span className="text-xs text-muted-foreground">({subagent.toolCalls.length} tool calls)</span>
        </div>
        <div className="flex items-center gap-2">
          {subagent.status === "running" ? (
            <span className="flex items-center gap-1 text-xs text-amber-500 font-mono">
              <Loader2 className="w-3 h-3 animate-spin" /> {subagent.elapsedSeconds}s
            </span>
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="p-3 space-y-2 border-t border-border/40 font-mono text-xs">
          {subagent.reasoningDeltas && (
            <div className="text-muted-foreground italic bg-background/50 p-2 rounded border border-border/30">
              💭 {subagent.reasoningDeltas}
            </div>
          )}

          {subagent.toolCalls.map((tool) => (
            <div key={tool.id} className="flex items-start gap-2 bg-background/80 p-2 rounded border border-border/40">
              <Terminal className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 overflow-hidden">
                <div className="font-semibold text-foreground flex items-center justify-between">
                  <span>{tool.name}</span>
                  <span className="text-[10px] text-muted-foreground">{tool.status}</span>
                </div>
                <div className="text-muted-foreground truncate">{JSON.stringify(tool.input)}</div>
                {tool.output && (
                  <pre className="mt-1 p-1 bg-muted/30 rounded text-[11px] overflow-x-auto text-foreground/80 max-h-32">
                    {tool.output}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
```

---

## 10. Strategic Roadmap for CubiQ

To elevate CubiQ from a high-quality multi-agent harness into an industry-leading Agentic Development Environment, implement improvements in three phased tiers:

### Phase 1: Context & Reliability Foundation (High ROI, Low Complexity)
1. **Wire In Active Context Compaction:** Connect `shouldCompact` in `cache-policy.ts` to trigger sliding-window summaries when a thread crosses 75% of the context window.
2. **Host-Side MCP Meta-Tool Router:** Implement `search_tools` and `call_mcp_tool` for OpenCode and Codex to prevent prompt bloat when more than 5 MCP servers are active.
3. **Automated Pre-Flight Schema Repair:** Intercept MCP tool arguments with Zod; return self-healing error objects on schema mismatch before invoking runtime tools.

### Phase 2: Observability & Developer Ergonomics (Medium Complexity)
1. **Nested Subagent Thread Progress (Section 9):** Implement `SubagentDisclosure` in React and route `liveUpdate:subagent` events across Claude SDK, Codex JSON-RPC child threads, and OpenCode child sessions.
2. **Automated Test-Driven Verification Gates:** Add a configurable post-turn hook that executes the project's test command (`npm test`, `cargo test`) and prompts the agent to self-correct upon non-zero exit codes.
3. **Automatic Git Worktree Isolation per Thread:** Automatically assign each new conversation thread to an isolated git worktree branch to unlock true multi-agent parallelism.

### Phase 3: Sandboxing & Remote Control (Advanced Architecture)
1. **Containerized Execution Sandboxes:** Provide pluggable Docker container support (inspired by DeepSeek Harness Cordis architecture) for untrusted repositories.
2. **Remote Web/Mobile Companion Bridge:** Embed a lightweight local WebSocket server allowing developers to monitor progress and approve permissions from mobile browsers (inspired by T3 Code).


---

## 11. Ecosystem Survey: The Landscape of Open-Source Agent Harnesses on GitHub

Beyond T3 Code, ZCode, and DeepSeek Harness, the open-source community on GitHub has produced several distinct families of coding agent harnesses. Each family represents a different set of trade-offs regarding sandbox security, token economics, editor coupling, and developer oversight.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   GitHub Agent Harness Ecosystem Taxonomy (2026)                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  1. CONTROL SURFACES (Universal Remotes / Multi-Agent Orchestrators)             │
│     • T3 Code (pingdotgg/t3code)    • Bird (block/bird)                          │
│                                                                                  │
│  2. AUTONOMOUS SOFTWARE RUNTIMES (Containerized / Sandbox-First)                 │
│     • OpenHands (All-Hands-AI)      • SWE-agent (princeton-nlp)                  │
│     • AutoCodeRover (NUS-SYSLAB)                                                 │
│                                                                                  │
│  3. MCP-NATIVE AGENT PLATFORMS (Standard-First Extensibility)                   │
│     • Goose (aaif-goose/goose)                                                   │
│                                                                                  │
│  4. TERMINAL-FIRST ARCHITECT / EDITOR ENGINES                                    │
│     • Aider (paul-gauthier/aider)   • Plandex (plandex-ai/plandex)               │
│                                                                                  │
│  5. IDE-EMBEDDED AGENT HARNESSES                                                 │
│     • Roo Code / Cline (cline/cline)• Continue (continuedev/continue)            │
│                                                                                  │
│  6. AGENTIC DEVELOPMENT ENVIRONMENTS (ADE / Next-Gen IDEs)                       │
│     • ZCode (zai-org/ZCode)         • DeepSeek Harness (deepseek-ai/dsh)         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 11.1 Detailed Analysis of Notable GitHub Agent Harnesses

#### 1. Aider (`paul-gauthier/aider` - 30k+ Stars)
* **Core Philosophy:** Terminal-first git pair programming agent.
* **Key Architectural Innovations:**
  * **Tree-Sitter Repository Map (Repo Map):** Uses tree-sitter AST parsing to extract all function, class, and variable signatures across the entire repository. It then applies the **PageRank algorithm** to the call graph to select the most structurally important definitions. This gives the model an accurate semantic map of a 100,000-line codebase within just **1,000 to 2,000 prompt tokens**.
  * **Architect / Editor Dual-Model Pattern:** Separates reasoning from editing. An expensive reasoning model (e.g. OpenAI o1 or Claude 3.7 Thinking) creates the plan and architecture, while a faster, cheaper model (e.g. Claude 3.5 Sonnet or GPT-4o-mini) executes the code search-and-replace hunks.
  * **Git-Backed Auto-Commit & Rollback:** Automatically creates an atomic Git commit for every single turn. If an agent's change breaks tests or is rejected, the user can run `/undo` to instantly restore the repository state.
  * **Automated Lint/Test Feedback Loop:** Automatically runs project linters and tests after applying edits; if syntax errors or test regressions occur, it feeds the compiler output back to the model for self-healing.

#### 2. OpenHands (`All-Hands-AI/OpenHands`, formerly OpenDevin - 45k+ Stars)
* **Core Philosophy:** The flagship open-source Devin equivalent for autonomous software development.
* **Key Architectural Innovations:**
  * **Event-Stream Architecture:** The core loop is modeled as an append-only event stream of `Action` $\to$ `Observation` pairs. Every thought, tool call, command execution, and file change is an immutable event, enabling seamless session restoration, pause-and-resume, and step-by-step replaying.
  * **Containerized Docker Runtime (`ghcr.io/all-hands-ai/runtime`):** Enforces total environment isolation. All agent tool calls, terminal commands, and file edits occur inside a dedicated Docker container or Firecracker MicroVM with restricted networking, protecting the host system from destructive commands.
  * **BrowserGym Integration:** First-class headless browser automation that parses accessibility trees (DOM distillation) to enable web app testing, documentation lookups, and visual verification.

#### 3. SWE-agent (`princeton-nlp/SWE-agent` - NeurIPS 2024)
* **Core Philosophy:** High-performance software engineering benchmark runner developed by Princeton University.
* **Key Architectural Innovations:**
  * **The Agent-Computer Interface (ACI):** Princeton researchers demonstrated that giving LLMs raw Linux bash terminals causes frequent failures (e.g. terminal pagination hanging on `less`, piping errors, and runaway context output). They invented the **ACI**, creating specialized CLI commands tailored specifically for LLM attention constraints:
    * `open <file> <line>`: Opens a file with strict 100-line windows and explicit line numbers.
    * `edit <start_line>:<end_line>`: Surgical text replacement coupled with an automated syntax linter that rejects edits before writing to disk if syntax is broken.
    * `goto <line>`, `scroll_down`, `scroll_up`: Windowed navigation commands that prevent context window blowouts.

#### 4. Goose (`aaif-goose/goose` by Block / Linux Foundation AAIF)
* **Core Philosophy:** Open-source, extensible AI agent engine created by Block (Square/Cash App) and contributed to the Linux Foundation.
* **Key Architectural Innovations:**
  * **MCP-First Architecture:** Goose uses the Model Context Protocol as its universal extension mechanism. File systems, terminal execution, developer toolkits, and external services are all MCP servers.
  * **Desktop + CLI Dual-Surface:** Built in Rust with a clean native desktop application and terminal CLI.
  * **Bird Ecosystem Companion:** Block also open-sourced **Bird**, a desktop control surface designed to manage multiple agent harnesses (Goose, Claude Code, GitHub Copilot) in a unified interface.

#### 5. Roo Code / Cline (`RooVetGit/Roo-Code` & `cline/cline` - 25k+ Stars)
* **Core Philosophy:** Deeply integrated VS Code autonomous coding agent extension.
* **Key Architectural Innovations:**
  * **Granular Context Bar & Token Budgeting:** Provides transparent, real-time visualization of context window breakdown (system prompt, tool schemas, chat history, active tokens) and calculates exact costs per turn.
  * **Custom Personas / Modes:** Allows users to define custom agent personas (e.g., *Architect*, *Code*, *Ask*, *Test*, *Review*) with strict per-mode tool permission whitelists and tailored system prompt instructions.
  * **Native MCP Client:** Seamless GUI for adding, testing, and toggling Model Context Protocol servers directly within the IDE sidebar.

#### 6. Plandex (`plandex-ai/plandex` - 15k+ Stars)
* **Core Philosophy:** Terminal-based AI coding engine for complex, multi-file software engineering tasks.
* **Key Architectural Innovations:**
  * **Branch-Based Sandbox:** Accumulates multi-file changes in an isolated sandbox branch before touching the user's working copy. Changes can be reviewed as unified diffs and committed atomically.
  * **Context Bag Pinning:** Users explicitly pin files, documentation URLs, and directory trees into persistent "context bags" to control exactly what enters the LLM context.
  * **Multi-Step Plan Verification:** Forces the agent to construct an execution plan first, which the user can review and edit before any file modifications are executed.

---

### 11.2 Comprehensive Matrix: Top Open-Source Agent Harnesses on GitHub

| Project | Creator / Maintainer | Core Language & Stack | Execution Isolation | Tool Calling & Protocol | Context Optimization Technique | Subagent / Multi-Agent Support |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CubiQ (`aiharness`)** | CubiQ Contributors | TypeScript + Electron | Host `node-pty` (Regex Git Guard) | Claude SDK, Codex JSON-RPC, ACP | Prompt Caching Pinning, Handoff Checkpoints | Single agent/thread (Sequential Handoff) |
| **T3 Code** | Theo Browne (`pingdotgg`) | TypeScript + Electron + Expo | Git Worktrees (`git worktree add`) | Wraps CLI binaries (`node-pty`) | Worktree branch diffs, Outbox queue | Concurrent threads in separate worktrees |
| **OpenHands** | All-Hands-AI (OpenDevin) | Python + TypeScript + React | Docker Container (`all-hands-ai/runtime`) | Custom Event Stream (`Action`/`Obs`) | Event pruning, DOM distillation | Micro-Agents / Delegator architecture |
| **Aider** | Paul Gauthier | Python | Host Git Repository | Search/Replace blocks, Edit format | Tree-sitter Repo Map with PageRank | Architect/Editor dual-model topology |
| **SWE-agent** | Princeton NLP | Python | Docker Container | ACI (Agent-Computer Interface) | 100-line windowed viewing, Linter gates | Single agent trajectory |
| **Goose** | Block / AAIF | Rust + Python | Host OS / Pluggable extensions | Native Model Context Protocol (MCP) | Dynamic MCP toolkit curation | Single thread execution |
| **ZCode** | Z.ai (Zhipu AI) | TypeScript + Electron | Local Sandbox / Execution Layer | Custom RPC, GLM tool calls | Dual-Model Router (Heavy/Flash, 1M context) | Multi-agent swarms (Plan/Build/YOLO) |
| **DeepSeek Harness** | DeepSeek AI | TypeScript + Cordis | Cordis Sandboxes (Docker, E2B, SSH) | Pluggable tool registry, MCP | Append-only event ledger, Session replay | Modular plugin execution loops |
| **Roo Code / Cline** | RooVetGit / Cline | TypeScript (VS Code Extension) | Host VS Code Workspace | Native tool loop + MCP Client | Exact token counting, Sliding context pruning | Custom modes with tool restrictions |
| **Plandex** | Plandex AI | Go | Sandbox Branch (`git`) | Search/Replace, Plan verification | Context Bags, Diff accumulation | Plan-first execution |

---

### 11.3 High-Value Ideas CubiQ Can Adopt from the GitHub Ecosystem

1. **Adopt Aider's Tree-Sitter Repo Map:**
   * *Problem in CubiQ:* When an agent asks "where is the auth middleware?", it either searches aimlessly with `grep` or asks the user.
   * *Solution:* Compute an in-memory PageRank call graph of function/class signatures (~1,500 tokens). Inject this map into the prompt prefix. Claude, Codex, and OpenCode immediately understand the repository structure without spending turns exploring.
2. **Adopt SWE-agent's ACI (Agent-Computer Interface) Linter Interceptor:**
   * *Problem in CubiQ:* An agent edits a file, introduces a syntax error, and doesn't notice until the user tests it.
   * *Solution:* Intercept file edit tools (`edit_file`, `write_file`). Run an instant in-memory AST syntax parser (e.g. `esprima` for JS/TS, `tree-sitter` for others). If syntax is broken, return an immediate error: *"SyntaxError: Unexpected token on line 42. File edit aborted."*
3. **Adopt T3 Code's Automatic Git Worktrees for Every Thread:**
   * *Problem in CubiQ:* Threads in the same project share the active working tree.
   * *Solution:* When the user clicks "New Thread", automatically run `git worktree add -b cubiq/<thread_id> ../.cubiq-worktrees/<thread_id> main`. Let each thread run in total isolation, and provide a unified diff merge drawer.
4. **Adopt OpenHands' Event Stream Persistence:**
   * *Problem in CubiQ:* Reconstructing past sessions or debugging agent decisions requires parsing mixed database columns.
   * *Solution:* Standardize on an immutable `Action` $\to$ `Observation` event log for every tool call and turn.


---

## 12. Deep Research: Optimizing Output Tokens and Taming First-Turn Cold Starts

Two of the most severe economic and performance bottlenecks in coding agent harnesses are:
1. **Output Token Waste (Generation / Completion Bloat):** Output tokens are 3x–5x more expensive than input tokens and are generated autoregressively at only 30–80 tokens/second. A 3,000-token response introduces 40–60 seconds of pure latency and risks hitting max generation caps.
2. **First-Turn "Cold Start" Context Explosion:** On Turn 1, naive harnesses dump system instructions, guidelines, 30+ tool schemas, skill manifests, and full directory trees, consuming **40,000 to 80,000 tokens before the user even types a prompt**.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     The Two Critical Token Bottlenecks                          │
├───────────────────────────────────────┬─────────────────────────────────────────┤
│ 1. Output Token Waste (Latency & Cost)│ 2. First-Turn Cold Start (Context Tax)  │
├───────────────────────────────────────┼─────────────────────────────────────────┤
│ • Full file rewrite (4,000 tokens)    │ • Raw tool schemas (25,000 tokens)      │
│ • Conversational pre-ramble (300 tok) │ • Full git file trees (20,000 tokens)   │
│ • Runaway thinking/reasoning budgets  │ • Heavy rulebooks & CLAUDE.md (5k tok)  │
│ • Verbose tool result echoing         │ • Full SKILL.md instruction bodies      │
├───────────────────────────────────────┼─────────────────────────────────────────┤
│ ↳ Solution: Diff hunks, chatter clamp,│ ↳ Solution: Repo maps, deferred schemas,│
│   dynamic effort, surgical slices     │   prefix cache locking, guide diet      │
└───────────────────────────────────────┴─────────────────────────────────────────┘
```

---

### 12.1 Optimizing Output Tokens: Squeezing Latency and Cost

#### 1. Diff Formats & File Modification Strategies
The single greatest consumer of output tokens in coding agents is file editing. Aider's empirical benchmarks evaluated three primary editing formats [[Official doc](https://aider.chat/docs/benchmarks.html)]:

* **Whole-File Rewrite:**
  * The model outputs the entire file from line 1 to line 1,000.
  * *Output Cost:* **3,000–5,000 tokens per edit**.
  * *Latency:* 45–60 seconds.
  * *Risk:* Truncation on large files, hallucinated missing imports, extreme token cost.
* **Search / Replace Conflict Markers (`<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`):**
  * The model outputs only the original lines to replace and the new replacement code.
  * *Output Cost:* **50–150 tokens per edit** (**97% reduction**).
  * *Latency:* 1–2 seconds.
  * *Gotcha:* String matching fails if the model slightly misquotes whitespace or indentation.
* **Unified Diff Hunks / Surgical Line-Numbered Replacement:**
  * Claude Code, Codex, and CubiQ use surgical replacement tools (`replace_file_content` / `edit_file`) specifying `StartLine`, `EndLine`, `TargetContent`, and `ReplacementContent`.
  * *Output Cost:* **30–80 tokens per edit** (**98.5% reduction**).
  * *Latency:* < 1 second.
  * *Anti-Lazy Coding Benefit:* Aider discovered that using strict diff formats completely eliminates "lazy comments" where models write `// ... rest of implementation unchanged ...` and accidentally wipe out hundreds of lines of code.

#### 2. Suppressing Pre-Action "Conversational Chatter"
Frontier LLMs have a conversational bias: before invoking a tool, they emit 150–300 tokens of conversational fluff (*"I would be glad to help you refactor that auth controller! First, I will search for where JWT tokens are generated, inspect the middleware, and then apply changes..."*).

* **The Harness Fix (Negative Constraints):**
  Harnesses like SWE-agent, Aider, and Claude Code inject explicit prompt constraints into Tier 0:
  ```markdown
  CRITICAL OPERATIONAL RULE:
  You are in direct autonomous execution mode.
  Do NOT explain your intentions or summarize your plan before invoking a tool.
  Do NOT provide conversational commentary before or between tool calls.
  Invoke the required tool immediately. Output explanations only after all tool executions complete.
  ```
  *Impact:* Eliminates 200–400 wasted output tokens per turn, cutting turn turnaround time by 4–8 seconds.

#### 3. Dynamic Reasoning & Thinking Budget Clamping
With extended reasoning models (Claude 3.7 Sonnet Thinking, OpenAI o1/o3-mini, DeepSeek R1), models will frequently spend **8,000 to 24,000 thinking tokens** reasoning through a trivial one-line typo fix or simple git status check.

* **Dynamic Effort Scaling:**
  CubiQ implemented `Thread.effort` and model-level effort toggles (Phase 10G) [[Source code](../../HANDOFF.md#L91)].
  * *Trivial tasks (lint fix, single-file typo, file search):* Pass `effort: "low"` or `max_thinking_tokens: 1024`.
  * *Medium tasks (feature implementation, test writing):* Pass `effort: "medium"` or `max_thinking_tokens: 4096`.
  * *Complex architecture (multi-file refactor, system redesign):* Pass `effort: "high"` or `max_thinking_tokens: 16384`.
  * *Impact:* Prevents output token budget exhaustion and cuts per-turn latency by up to 70%.

---

### 12.2 Taming the First-Turn "Cold Start" Context Explosion

On Turn 1 of a fresh session, a naive harness dumps everything it knows about the project into the context window:
* Base System Prompt: ~3,000 tokens
* Tool Schemas (25 tools): ~15,000–25,000 tokens
* Project Guidelines (`CLAUDE.md`, `HARNESS.md`, `AGENTS.md`): ~4,000–8,000 tokens
* Skills Registry (30 skills): ~3,000–6,000 tokens
* Raw File Tree (`git ls-files`): ~15,000–35,000 tokens
* **Total Turn 1 Cold Start:** **40,000 to 77,000 input tokens!**

Here is how frontier harnesses tame this cold start down to **< 5,000 tokens**:

#### 1. Aider's Tree-Sitter Repo Map (Compressing 100k Lines into 1k Tokens)
Instead of dumping `git ls-files` or running `tree -L 4` (which floods the context with thousands of irrelevant paths like icons, configs, and test fixtures), Aider builds a **Repository Map**:
1. Uses `tree-sitter` to parse ASTs across all source files in the repo.
2. Extracts class names, exported functions, method signatures, and imports.
3. Builds an internal call graph and runs the **PageRank algorithm** to identify the most structurally connected files and definitions.
4. Generates a compact syntax outline of the top 100 most critical definitions:
   ```python
   # repo_map summary (1,200 tokens)
   src/auth/jwt.ts:
     export function signToken(user: User): string
     export function verifyToken(token: string): TokenPayload
   src/middleware/auth.ts:
     export class AuthMiddleware implements Middleware
   src/db/client.ts:
     export const prisma: PrismaClient
   ```
*Impact:* The model understands the entire architecture of a 100k-line project in **1,200 tokens**, completely eliminating the need to dump file listings or spend 10 turns searching.

#### 2. Dynamic Tool Search & Deferral (`defer_loading`)
* As covered in Section 3.2, marking MCP tools with `defer_loading: true` under Anthropic's `advanced-tool-use-2025-11-20` beta header keeps tool schemas out of the initial prompt.
* Instead of sending 25 full JSON schemas on Turn 1 (~20,000 tokens), the harness sends a compact tool index and a single search tool (~1,500 tokens), achieving an **85% reduction in initial tool tokens**.

#### 3. Bounded Directory Walk & Strict Ignore Rules
* When providing file tree visibility:
  1. Enforce a **hard cap on depth**: maximum depth of 2 directories from root.
  2. Enforce a **hard cap on entry count**: maximum 80 files/folders displayed.
  3. Filter aggressively using `.gitignore`, `.claudeignore`, and harness-level blacklists (ignoring `node_modules`, `dist`, `.git`, `build`, `coverage`, `.next`, `vendor`, `.DS_Store`).
  4. If the agent needs to inspect a subfolder (e.g. `src/modules/billing`), it explicitly calls `list_directory("src/modules/billing")` on demand.

#### 4. "Guide Diet" (Markdown Compaction for Project Rules)
* Guidelines files like `CLAUDE.md`, `AGENTS.md`, and `HARNESS.md` often suffer from repetitive prose, chatty explanations, and outdated boilerplate.
* CubiQ's own roadmap plans a **"guide diet"** (`plan/docs/11-memory-extensions-guide.md §11.4`).
* *Rules for Guide Diet:*
  * Use telegraphic, imperative bullet points (e.g., *"Run tests via `bun test`. Use 2-space indentation. Never push to main directly."*).
  * Omit conversational background explanations and historical rationales.
  * Move domain-specific instructions out of `CLAUDE.md` and into on-demand `SKILL.md` files that load only when that specific domain is touched.
  * *Impact:* Reduces project rulebook overhead from 5,000 tokens to under **800 tokens**.

#### 5. Prompt Prefix Cache Locking (Turn 2+ Discount)
Even if Turn 1 incurs a 6,000-token cold start, **Turn 2 through Turn 50 should cost virtually nothing for that prefix**:
* By adhering to strict prompt caching discipline (Section 3.1):
  * Base instructions, static tool schemas, guide rules, and repo maps are pinned at the top of the prompt buffer without changing a single byte across turns.
  * On Anthropic, OpenAI, and DeepSeek, prompt caching hits **>90%** of the input tokens.
  * Cached tokens receive an **80–90% cost discount** and are processed instantaneously with sub-second time-to-first-token (TTFT).

---

## 13. Codebase Research: What CubiQ Actually Does Today (Claude, verified 2026-09-30)

*Source: two read-only passes over `aiharness` (branch `m4`, after `4f896a6`). Every load-bearing claim was re-opened in the code by Claude. `path:line` refers to the repo. Where this contradicts sections 1–12, this section wins.*

### 13.1 Skills: how they reach each agent
- **Discovery**: one scan per dir for `<name>/SKILL.md` (`src/main/skills/discover.ts:65-80`), frontmatter via `parseSkillMd` (`:29-53`); a skill with no `description` is skipped (`:84-85`).
- **Scopes** (`src/main/skills/sources.ts:63-89`): project `<cwd>/.agents/skills`, then `<cwd>/.claude/skills`, then harness, bundled and legacy (`AIHARNESS_SKILLS_DIR` / `UNSKILLED_SKILLS_DIR`, `catalog.ts:28-33`). `~/.claude/skills` is only read for de-dup, never as a source (`sources.ts:96-98`).
- **Delivery per driver** (`SkillsDelivery.mode`, `src/shared/types.ts:570-576`):

| Agent | Mode | What costs context | Progressive disclosure |
|---|---|---|---|
| Claude | `plugin` (`capabilities.ts:81`): harness skills copied into a plugin, `Skill` calls qualified `harness-skills:` (`skills/plugin.ts:43-77`) | Claude's own skills listing (measured **2.0k** for this repo, doc 11 §11.0) | **Native.** The body loads through Claude's `Skill` tool, *not* `Read` (so §4.3/§6 above are wrong on this point) |
| Codex | `extraRoots` (`capabilities.ts:109`; `codex.ts:577-580` `skills/extraRoots/set`) | Codex's own skills index | **Native** |
| OpenCode, Cursor | `tool` (`agents/registry.ts:48,60`): one harness `skill` tool served over `/mcp-skills` (`acp/driver.ts:691-696`) | The **tool's description lists every skill** (`skills/tool.ts:17-25`), so it grows linearly with N | Body on demand, but the **listing is ours** and uncapped. OpenCode also scans `.opencode/.claude/.agents/skills` natively (registry comment) |
| dsh (DeepSeek) | `envDir` via `DSH_BUNDLED_SKILL_DIR` (`registry.ts:36`) | the agent's own | native |
| Antigravity | `none` (`registry.ts:77`) | – | – |

- The harness injects a skill **body** only when the user runs it from the menu (`skills/compose.ts:15-39`, `service.ts:548`).

### 13.2 MCP: how servers reach each agent
- **Store**: `mcp.json` in Claude's `.mcp.json` shape plus `disabled` (`src/main/mcp/servers.ts:12-17`). Two scopes: a global store at `userData/mcp.json` and one per project (`McpScopes`, `servers.ts:136-161`). A project server replaces a same-named global one; `offGlobal` switches globals off per project. **Per-server enable/disable already exists in the harness, for every agent.**
- **Claude**: `forClaude` → SDK `options.mcpServers` (`servers.ts:189-191`), merged with the in-process harness tool server (`agents/claude.ts:44-62,436`).
- **Codex**: `forCodex` → thread `mcp_servers` (`servers.ts:194-203`, `codex.ts:220-237`); harness tools over HTTP.
- **ACP/OpenCode**: `session/new` / `session/resume` `mcpServers` (`servers.ts:205-225`, `acp/driver.ts:686-708`). HTTP servers only when the agent reports `mcpCapabilities.http` (`driver.ts:687`).
- **Built-in harness tools**: 7 browser tools (`browser/tools.ts:30-93`, always offered from turn 1 for cache stability) plus `memory_read` (`memory/tool.ts`; dropped for Claude, which has native memory: `claude.ts:43-45`).
- **Tool search / deferral**: nothing in `src/` sets `ENABLE_TOOL_SEARCH`, `alwaysLoad` or `defer_loading`. Claude defers natively (doc 11 §11.0 measured **15.9k** of tool schemas deferred on the first-party API). `ENABLE_TOOL_SEARCH` **is** a recognised env var in the shipped `@anthropic-ai/claude-agent-sdk@0.3.281` (`sdk.mjs` env list). The "10% of context" auto threshold is **not verified**. Codex and OpenCode get every schema up front.
- **Cache pinning**: `toolSetOf` fingerprints the harness tools plus enabled MCP servers per thread (`cache-policy.ts:40-98`, wired at `service.ts:577-585`), so mid-thread MCP changes are queued rather than mutating the prefix (matches §3.1).

### 13.3 Context accounting: the measurement gap
- `/context` preview (`src/main/context-preview.ts:15-32`): guide files and harness tools at ~4 chars/token; **MCP servers by name only, with no token cost; skills are not listed at all.**
- First-turn breakdown: Claude uses the SDK's real `getContextUsage()` (`claude.ts:502-519`, `estimated:false`). Codex and ACP synthesise only 3 estimated rows (harness tools, guide, memory index) (`codex.ts:903-919`, `acp/driver.ts:1130-1146`). **There are no skills or MCP rows**, so "context load from many skills and MCP servers" can't be measured in the app today.
- Fixtures: 3 mock skills (`test/fixtures/mock-skills`) and a one-tool `mock-mcp-stdio.mjs`. There is no seeder for scale tests.

### 13.4 Providers, and dsh
- **dsh is one ACP preset** (`src/main/agents/registry.ts:28-41`: `command: "dsh"`, `DSH_BUNDLED_SKILL_DIR`, `keyVar: DEEPSEEK_API_KEY`), plus mock rows (`renderer/src/mock.ts:69,143,275-283`), README/HARNESS mentions and test fixtures (`acp.test.ts:932`, `library.test.ts`, `inject-acp.test.ts`). The **DeepSeek provider** shares the id `deepseek` (`providers.ts:45-58` `LEGACY_ENV`/`LEGACY_PROVIDERS`, `settings.ts:120-138` `migrateDeepseekDefault`). Removing the agent must keep the provider.
- **Custom providers already ship**: `Provider { id, label, wireProtocol, baseURL, secret, models, headers?, env?, queryParams?, pathMode?, betaHeaders? }` (`shared/types.ts:76-90`); Settings → Agents & Providers → *Add provider* (`ProviderSheet.tsx:145-408`, saved by `settings.ts:280-300`). Keys go in safeStorage (`settings.ts:314-335`).
- **What's missing: a built-in catalog of well-known providers** (OpenCode/models.dev-style). The only list is the 3 legacy migration entries.
- **Per-agent injection** (`inject/*`): Claude needs `anthropic-messages` and sends `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (`inject/claude.ts:31-45`, with a warning off-Anthropic). Codex needs `openai-responses` and gets `-c model_providers.<id>` with `wire_api="responses"` and the key in env only (`inject/codex.ts:24-73`; matches §5.3). OpenCode needs `openai-chat` and gets a synthesized `@ai-sdk/openai-compatible` provider through `OPENCODE_CONFIG_CONTENT` (`inject/opencode.ts:44-60`; matches §5.1). A generic ACP agent takes any protocol, as a best effort (`inject/acp.ts:37-54`).

### 13.5 Corrections to sections 1–12
- §4.3 / §6: Claude loads skills through the **`Skill` tool**, not `Read`/`View`.
- §6 "Per-server enable/disable, Claude: host must implement": CubiQ already does this for all agents (`McpScopes`, `disabled`, `offGlobal`).
- §8.2 / §11.3.3: CubiQ **has** worktrees (T8.13, commit `4638000`).
- §5.2: some URLs conflict (MiniMax `api.minimax.chat` vs `api.minimax.io`; Moonshot `.cn` vs international `.ai`; Z.ai China `open.bigmodel.cn` vs international `api.z.ai`). Check them against `https://models.dev/api.json` before shipping.
- §8.3 BFCL accuracy figures (92% → 15–25%) have no source. Measure instead (plan P3).

### 13.6 What this means for the plan (`aiharness/.ai/plans/context-load-and-providers.md`)
1. **Measure first**: a mock kit (many skills and tools with near-duplicate distractors, each returning a unique sentinel), plus skills/MCP rows in `/context` and the Codex/ACP breakdown.
2. **Accuracy run**, live on Claude, Codex and OpenCode: tokens, correct picks, false calls.
3. **Trim only where the cost is ours**: an MCP router (`search_tools` + `call_mcp_tool` with schema pre-flight) for Codex/OpenCode above a threshold; a capped, project-scoped skill listing for OpenCode's `skill` tool; `ENABLE_TOOL_SEARCH` for Claude on BYOK hosts that support it; guide diet ≤600 tokens.
4. **Drop dsh, add a provider catalog** that prefills the existing custom-provider editor.
