# Lean harness improvement plan

Research and source-inspection snapshot: **2026-10-21**.

Status: **proposal, not an implementation authorization**. Saving this plan is authorized; changing application code, instructions, settings, worker routing, installations, or permissions requires separate approval. Do not import this document into the always-loaded prompt.

Research persistence rule, requested by the user: **save each new finding here before continuing research**. This file is the durable checkpoint; do not accumulate unsaved findings in conversation until a final report or compaction.

## 1. Objective and scope

Improve CubiQ's existing harness rather than building a competing harness around it.

> Minimize total tokens and time per verified successful task while preserving correctness, safety, and the user's control.

The target is measurable high reliability, not a guarantee of perfect accuracy or flawless model behavior. A smaller first prompt is useful only if it does not cause more searches, invalid calls, retries, rework, or missed requirements.

### User requirements

1. Recognize a new repository, inspect existing conventions, and establish or update project-specific instructions, documentation, skills, or workflows only when genuinely useful.
2. Understand available native features, skills, plugins, MCP servers, hooks, and executable tools before recommending or installing more.
3. Recognize repeated mistakes, instructions, and workflows; promote them into appropriate tests, scripts, skills, prompts, or reusable knowledge.
4. Keep a small accessible prompt library and a version-controlled global setup reusable across repositories, machines, and Claude accounts.
5. Reevaluate components as Claude Code and models evolve; remove or replace redundant components rather than accumulating them.
6. Avoid configuration-maintenance work, unnecessary documentation, and context overhead that do not improve user outcomes.
7. Prioritize the reported **approximately 25,000-token first request**, including instructions and tool schemas, across providers and models.
8. Use an explicitly selected **DeepSeek Free** worker route through AgentRouter or OpenCode's Zen/Console offering; never silently substitute a paid or different model.
9. Enhance the existing **Code Mode**, including discovery, structured results, batching, cancellation, permissions, output limits, and provider/native compatibility.
10. Enhance **harness custom instructions** using source-grounded comparisons with T3 Code, ZCode, Orca, Reasonix, OpenHuman, and other relevant harnesses; adopt useful mechanisms rather than copy entire prompts or products.

### Non-goals

- No new general-purpose orchestration or observability framework by default.
- No automatic repository scaffolding merely because an instruction file is missing.
- No nightly self-optimization agent or mandatory end-of-session documentation ritual.
- No wholesale synchronization of account state, credentials, transcripts, caches, or unreviewed memory.
- No UI redesign or change to the application's architecture, theme, component structure, or design tokens as part of this plan.

## 2. Verified baseline and important unknowns

The application repository is `aiharness`, product name **CubiQ**, manifest version **0.1.2**. [C20] Its architecture includes Claude Agent SDK, Codex and ACP drivers, and CubiQ's own provider loop. ([C1], [C2], [C3], [C4])

CLI commands run during research:

```text
claude --version
2.1.306 (Claude Code)

opencode --version
1.19.3
```

These establish the installed CLIs at inspection time, not necessarily the executable selected by every active application session.

| Verified source finding | Implication |
| --- | --- |
| CubiQ already has skill discovery/search, MCP routing, shared memory, and a failure-learning lifecycle. | Improve and consolidate existing mechanisms rather than introduce competing ones. ([C5], [C6], [C7], [C8]) |
| The app-tool set is deliberately always offered to preserve a stable prompt prefix. | Startup context and cache stability must be evaluated together. [C9] |
| Claude's first-session breakdown uses native context usage, while Codex/ACP paths estimate components and use later usage/context totals. | Current breakdowns are not directly comparable first-request measurements. ([C2], [C3], [C4]) |
| Some estimates serialize internal Zod objects rather than the emitted JSON Schema. | Estimate actual wire definitions instead of treating internal configuration size as model-token usage. ([C10], [C1]) |
| The native base prompt recommends background servers with `&`, while the CubiQ guide requires `shell_start`. | Remove contradictions before adding more instructions. ([C11], [C12]) |
| Provider-loop workers inherit the lead route by default; a missing team-member model can fall back to the lead. | Enforce requested worker routing in execution code, not prompt wording. [C13] |
| Existing evidence checks recognize check-like command text and are advisory. | A command that looks like a test is not proof that checks passed. [C14] |
| Existing lesson selection is capped at five and sorts by pinning, helpfulness, and recency. | Improve task relevance before increasing memory capacity. [C8] |

### Not yet established

- The reported 25k startup was **not independently reproduced**. It remains a user-reported baseline.
- Active MCP servers, enabled global plugins/hooks, provider configurations, account overrides, and live worker routing were not established through credential-bearing files.
- No live token benchmarks, comparative model/task-success experiments, or provider-backed evals ran. Later focused local tests and mocked probes **did run**; their commands, outputs, and limitations are checkpointed in section 11.5.
- An authoritative version-controlled global setup repository has not yet been identified.
- Local source references are an inspection snapshot, not proof that another branch or worktree has identical code.
- The checkout changed independently during research: the earlier audit anchor was `c790e1a`; this continuation observed `8d55dbe`, then `9a1b08d0d44cbc00a679976d52fed7c9121321db`. Do not attribute concurrent application commits or preexisting dirty files to this document-only work. Recheck cited lines before implementation.
- Final document check observed a further independent revision, `5178b93568818ca370b3bcb1a7a10f2b75d459eb`. Its recent commit messages report browser-on-demand becoming always-on for non-native-search agents, a shared Code Mode hint, bare-string tool argument conveniences, and `/codemode on|off`. This is **Git-history evidence pending current-source cross-check**, not proof those changes satisfy the CM/CI acceptance tests.
- The next audit pass started at that same `5178b93568818ca370b3bcb1a7a10f2b75d459eb`; current-source reconciliation is saved incrementally in section 11.7. The earlier test runs still describe their earlier inspected snapshots, not unconditionally this revision.
- The research session's subagent interface did not expose model selection. Earlier research workers cannot be certified as having used DeepSeek Free; no further workers were launched after the user's routing instruction.

## 3. First-request prompt and schema optimization

### 3.1 Measure the actual request

Extend existing context-breakdown events and the context preview. Do not build a second telemetry stack.

Separate the initial model request into:

```text
First model request
├── Native agent instructions, when using Claude Code/Codex/etc.
├── CubiQ instructions and expert prompt
├── Repository instructions
├── Skill and capability discovery metadata
├── Advertised tool schemas
├── Memory and lessons
└── Current user request
```

Keep these measurements distinct:

- **First request:** the initial model call, before tool results arrive.
- **First user turn:** potentially many model calls and tool results.
- **Current context:** the content of one particular request.
- **Total task consumption:** all requests, workers, retries, compaction, and background learning.

For each driver, record provider, requested model, driver/protocol/version, component sizes, advertised versus deferred tools, estimated versus reported tokens, measurement point, and cached versus uncached input. Use an explicit **unknown/native-owned** category when the harness cannot inspect a component.

Estimate from final serialized request components with a compatible tokenizer where available; reconcile against provider-reported usage. Character estimates remain labeled approximations. Normalize provider accounting without double-counting cached input or cache creation. Do not confuse bytes, context tokens, billable tokens, and whole-turn totals.

Normally store counts and component identifiers rather than raw prompts, tool arguments, headers, or sensitive source content. Detailed diagnostic capture must be explicit and sanitized.

### 3.2 Keep a small always-loaded core

The permanent prompt should contain only behavior needed for almost every task:

- Respect scope, permissions, and user control.
- Inspect relevant evidence before changing things.
- Use actual tool contracts rather than guessed names or arguments.
- Preserve project conventions.
- Verify outcomes and report uncertainty.
- Avoid unrelated changes and unsupported completion claims.

| Content | Appropriate loading |
| --- | --- |
| Universal safety and evidence requirements | Always loaded |
| Short, non-obvious repository constraints | Project context |
| UI/design requirements | Relevant paths or tasks |
| Release, migration, debugging procedures | On-demand workflow |
| Detailed skill documentation | On invocation |
| Historical lessons | Relevant retrieval, not a universal dump |
| Mechanical execution constraints | Tool implementation, hooks, or scripts |

Start with the smallest sufficient high-signal prompt, then add guidance based on demonstrated failures. Do not replace useful specificity with vague slogans. ([R1], [R2])

Splitting `CLAUDE.md` into `@` imports does **not** save context: imports still load. Unscoped rules also load at startup. Actual savings require removal or selective loading. [R3]

### 3.3 Expose schemas selectively

Classify capabilities into:

1. **Core:** directly available because they are frequently needed.
2. **Optional:** discoverable, with full schemas loaded when needed.
3. **Unavailable:** not advertised as usable.

For CubiQ's own loop, start with ordinary coding tools. Browser, design, external integrations, and specialist workflows should not require all their full schemas before an unrelated coding task. Use schema-size budgets, not only tool counts: five large schemas can cost more than twenty small ones.

Do not hide everything behind one generic `execute` tool. That can reduce startup tokens while degrading tool selection, argument validation, permissions, and auditability.

The Claude adapter deliberately keeps managed shell tools and `run_code` visible because deferred exposure caused missed usage. Preserve these documented source decisions until representative tests establish a better alternative. [C2]

### 3.4 Use provider-aware discovery

| Execution surface | Strategy |
| --- | --- |
| Claude Code driver | Prefer supported native tool search and instruction loading; avoid duplicate injection. |
| Codex/ACP drivers | Use actual supported capabilities; retain CubiQ fallback discovery where needed. |
| CubiQ provider loop | CubiQ owns prompt assembly, schema exposure, validation, and discovery. |

Do not assume an OpenAI-compatible API implements Claude Code's discovery behavior. Capability checks must apply to the actual driver/provider/model combination. Native tool search reduces schema loading, but discovery still has metadata and round-trip costs. ([R2], [R4])

Reuse the existing skill search, MCP router, and optional code-mode broker. Code execution can reduce large intermediate outputs and dependent-call overhead, but introduces its own complexity; do not force it onto simple tasks without evidence. ([C5], [C6], [C15], [R5])

**Continuation correction:** the inspected `9a1b08d` checkout already had a browser-on-demand experiment, a `browser_tools`/`browser_call` pair, thread-fixed exposure, and regression tests. Later independent commit `9e86e1e` reports making this always-on for agents without native search and removing the experiment setting. Extend or evaluate the current mechanism, not build another browser router. Its inspected test asserts a character-based schema-size saving over 1.2k estimated tokens; that is not a live provider-token or successful-task benchmark. ([C33])

### 3.5 Optimize caching after removing waste

A stable oversized prompt can cache well while remaining oversized. Cached tokens still occupy context.

Order of work:

1. Remove unnecessary content and duplicate delivery.
2. Keep the remaining prefix stable.
3. Measure cold and warm performance alongside successful-task cost.

Avoid rebuilding the tool catalog every turn. Choose a compact session profile, then use controlled discovery. Tool-set or prompt changes must preserve valid tool-call history and protocol-specific reasoning replay. Retain and extend existing cache/history protections. ([C16], [C17])

**Proposed pilot target:** reduce avoidable cold-start overhead by roughly half without increasing invalid calls, task failures, or total task consumption. This is an experimental target, not a measured result or universal token budget. Native-owned overhead may limit absolute reductions.

## 4. Reliable tool execution and completion evidence

Reliability belongs at an execution boundary, not in an expanding prose checklist:

```text
Receive call → parse → validate → authorize → execute with limits → report/verify result
```

### Tool contracts

- Generate protocol schemas from one canonical definition.
- Preserve required fields, enums, bounds, and meaningful descriptions.
- Test schema conversion for each supported protocol, including optional arguments.
- Surface schema-generation errors instead of silently substituting permissive schemas.
- Return actionable validation errors identifying the incorrect field.
- Keep names and arguments consistent where possible; adapt genuinely different provider contracts explicitly.

The existing MCP `required`-array compatibility handling is an example of a real failure worth retaining as a protocol regression test. [C18]

### Execution discipline

- Parallelize independent reads; order dependent or conflicting writes.
- Apply timeouts and cancellation behavior.
- Retry transient reads only under bounded policies.
- Never blindly retry a mutation after an ambiguous timeout; inspect resulting state or use an idempotency mechanism.
- Detect repeated identical failures and stop or change approach.
- Preserve permissions and side-effect classification inside discovery routers and code brokers.
- Report denied or unavailable actions without working around the boundary.

### Verification records

A reliable record contains the actual command, exit status, relevant assertions, working directory, revision/state, and whether execution happened after the final edit. Distinguish complete, partial, failed, and not-run checks.

The final response should summarize recorded evidence, not infer success from a command name or a worker's prose. Existing advisory flags can remain useful, but cannot substitute for outcome verification. ([C14], [R6])

## 5. Quiet repository awareness

### First substantive task in a repository

1. Establish repository identity, worktree location, package scope, and trust state.
2. Inspect existing instructions and relevant contribution documentation.
3. Inspect manifests, existing scripts, test configuration, and CI conventions relevant to the request.
4. Identify commands and non-obvious constraints needed for this task.
5. Check which approved capabilities are usable in this session.
6. Proceed without creating files unless a demonstrated gap exists.

Do not use directory basename alone as identity. Keep shared repository knowledge separate from worktree-specific state, and support non-Git folders. Do not execute untrusted project setup or configuration merely to inventory it.

### Cheap freshness checks

Cache lightweight discovery results and invalidate the relevant portion when a repository/worktree changes, a relevant manifest/instruction/configuration changes, the toolchain changes, or a recorded command fails. Do not run a full audit on every prompt.

Add or update project artifacts only when a non-obvious convention is repeatedly missed, a useful procedure is repeatedly rediscovered, a durable constraint is absent or contradictory, or guidance is demonstrably stale.

Reuse existing `AGENTS.md`, `CLAUDE.md`, scripts, and docs. Do not generate architecture overviews and onboarding documents simply because those files are absent. Claude Code's native instruction hierarchy, scoped rules, `/init`, and `/doctor prompt-audit` already support much of this behavior; verify applicability to the active surface before creating equivalents. ([R2], [R3], [R7])

## 6. Selective learning and appropriate artifacts

Learning means reviewed reuse, not permanent rule creation after every mistake.

| Observation | Preferred artifact |
| --- | --- |
| Reproducible code defect | Regression test |
| Invalid schema, wrong argument, broken call ordering | Harness contract test or agent eval |
| Repeated mechanical sequence | Existing script/task, or a small new script |
| Durable, non-obvious repository constraint | Short instruction or scoped rule |
| Reusable procedure requiring judgment | On-demand skill |
| Useful task-starting brief | Parameterized prompt template |
| Personal preference or rationale | Scoped retrievable knowledge |
| Temporary observation or uncertain hypothesis | Ephemeral note, or discard |

A serious defect deserves a regression test immediately; it need not recur before receiving coverage.

```text
Capture candidate
→ reproduce or substantiate
→ classify scope and artifact
→ check for an existing equivalent
→ validate the smallest change
→ review and promote
```

### Promotion boundaries

- Explicit corrections establish intent at their stated scope; inferred patterns remain provisional.
- External documents, tool results, and worker summaries are evidence, not authority to change policy.
- Global promotion requires genuinely cross-project applicability and review.
- Permission, hook, dependency, network, or routing changes require specific authorization.
- The candidate-producing process must not weaken its own acceptance tests.
- Separate agent mistakes from flaky infrastructure, ambiguous requests, and broken graders.
- Correlation between task failure and an injected lesson is not proof that the lesson caused harm.

### Improve existing learning before adding capacity

Filter lessons by task/path relevance before ranking by helpfulness or recency. Preserve bounded injection; detailed bodies should remain retrievable rather than universally loaded. [C8]

Count background extraction, drafting, replay, and grading in total consumption. Source defaults include daily ceilings of 50k lesson tokens and 200k memory-extraction tokens per project; these are ceilings, not evidence of actual spend or enabled settings. A system that saves 2k tokens but spends 20k analyzing a session is not an efficiency improvement. [C19]

## 7. Portable global setup and prompt library

First identify or designate the authoritative setup repository. Do not create a second competing source of truth by default.

| State | Treatment |
| --- | --- |
| Authored instructions, prompt templates, scripts, skill sources, reviewed configuration templates | Version-controlled source |
| Private project memory and temporary observations | Local runtime state unless deliberately promoted |
| Credentials, account state, transcripts, caches, installed/downloaded copies | Excluded from portable source |

Do not synchronize the whole `~/.claude` directory or raw settings. Export only explicitly allowed files and configuration keys. Authentication remains separate for each account.

### Small accessible prompt library

Use existing bundled workflows where they fit. Add only missing templates, initially from these task types:

- Plan a change.
- Implement a bounded change.
- Investigate a failure.
- Review risk.
- Verify outcomes.

Common fields: **objective, scope, acceptance criteria, non-goals, constraints, expected evidence/output**.

Expose templates through a menu or explicit invocation, not by injecting the full library into every session. Prefer user-invocable-only skills for occasional templates when the runtime supports that loading behavior. ([R2], [R7])

### Deployment requirements

- Preview/diff by default.
- Manage only owned files and allowed configuration keys.
- Preserve unrelated settings and unmanaged files.
- Make a second identical installation a no-op.
- Support rollback without overwriting intervening user edits.
- Record compatibility requirements and reviewed versions/revisions.
- Keep repository-specific behavior opt-in.
- Treat account-synced skills as downloaded artifacts, not editable authoritative source; local edits may be overwritten. [R7]

Do not assume identical support across local Claude Code, other agents, cloud sessions, and account skill uploads. Packaging and frontmatter may need small explicit adapters rather than duplicated workflow bodies.

## 8. Inventory, adoption, and retirement

Keep capability metadata outside the always-loaded prompt:

- Name, purpose, source, and version.
- Installed, enabled, loaded, and currently usable status.
- Context footprint, latency, permissions, and dependencies.
- Existing/native equivalent.
- Evidence that the capability helps.

Installed is not enabled; enabled is not necessarily usable in the current session. Use native diagnostics where available and safe sanitized metadata elsewhere. Never require credential values merely to report names/status.

### Adoption gate

Add a component only when there is a named requirement or reproduced failure, native/existing tools do not meet it, access and maintenance costs are acceptable, and representative evaluation shows benefit.

### Retirement gate

Reassess after relevant upgrades, repeated failures, security advisories, new native equivalence, overlap, or sustained non-use. Disable one component at a time, compare outcomes, and retain regression coverage for real requirements.

Rare safety controls should not be automatically removed just because they are unused. Native audits and usage diagnostics support decisions but do not authorize autonomous deletions or permission changes.

Normal operation should remain quiet. No nightly self-rewriting, mandatory session reports, or documentation refresh rituals. Expensive analysis should be user-requested or triggered by demonstrated friction. ([R1], [R2], [R6])

## 9. Explicit DeepSeek Free worker routing

At research time, OpenCode's public Zen/Console documentation listed:

```text
opencode/deepseek-v4.1-flash-free
```

The documentation describes this as a limited-time free model. Its listing confirms a documented option, not current account availability or successful routing from this application. Recheck the public catalog and actual supported runtime before activation. [R8]

Worker policy:

1. Explicitly select provider and exact model identifier.
2. Record the requested provider/model and any route change on each worker run; retain returned model metadata where available.
3. Reject unavailable or unsupported models instead of falling back to the lead.
4. Never silently switch to a paid or different model.
5. Permit an alternative route only under a user-approved policy.
6. Treat unknown returned model identity as unknown, not verified DeepSeek routing.

AgentRouter is an acceptable requested alternative once its exact offered identifier and access are safely confirmed. Its public landing page did not establish the model catalog during this research. Credential handling remains with the user's main session; do not open credential files to resolve this unknown. [R9]

Enforce this in the actual dispatcher/route resolver and cover fallback rejection with tests. Prompt wording alone cannot prevent the current provider-worker fallback behavior. [C13]

## 10. Phased delivery and acceptance criteria

| Phase | Work | Exit condition |
| --- | --- | --- |
| **0 — Baseline and routing** | Comparable initial-request measurement; explicit worker-route selection and failure behavior. | We know which components consume tokens and which model workers request. |
| **1 — Correctness and instruction cleanup** | Code Mode cancellation/containment/scheduling gaps; prompt contradictions, duplicate delivery, inaccurate estimates. | No new side-effect bypasses; less ambiguity; measurements correspond to exposed context. |
| **2 — Selective exposure** | Optional schema/skill loading using existing discovery mechanisms. | Lower cold-start overhead without more invalid calls or task failures. |
| **3 — Execution reliability** | Schema tests, retry/cancellation behavior, permissions, and verification records. | Known failures have deterministic tests or representative eval coverage. |
| **4 — Selective reuse** | Repository awareness, relevant learning, portable setup/prompt sources, retirement policy. | Repeated work decreases without growing permanent context or maintenance cost. |

### Recommended first implementation slice

**Checkpoint evidence → correct measurement and requested routing → fix Code Mode containment/cancellation/scheduling → resolve instruction conflicts → add schema/evidence regression tests → evaluate selective exposure.**

The Code Mode and custom-instruction slices in sections 11.3–11.4 are now explicit deliverables. Preserve the existing QuickJS/broker architecture initially; do not replace it with a full-privilege REPL or another framework without a demonstrated requirement.

Before launching implementation workers, establish the user's approved worker route. Keep changes bounded and reversible, and preserve the current application architecture and UI conventions.

### Evaluation strategy

Reuse existing tests and eval infrastructure. Begin with a small representative subset; do not add another runner by default. Maintain held-out cases and repeat important trials under matched model versions, resources, and cache conditions. Deterministic graders should check observable outcomes; require exact tool ordering only for genuine dependencies or safety requirements. [R6]

Include both positive and negative cases:

- A browser task loads and uses the needed capability.
- An unrelated coding task does not preload browser/design workflows.
- A repository with sufficient existing instructions gets no unnecessary scaffolding.
- Switching repositories/worktrees does not leak scoped facts or reuse the wrong commands.
- A repeated failure is promoted into the appropriate artifact.
- A one-off observation does not become permanent policy.
- A failed check is never reported as passing.
- A mutation with ambiguous completion is not blindly retried.
- An unavailable requested worker model fails visibly rather than changing routes.
- Discovery and code-mode paths preserve permissions and cancellation.

Measure:

- Verified first-attempt success and repeated-trial consistency.
- Invalid calls, retries, missed capabilities, unsupported completion claims, and user rework.
- Total tokens across lead, workers, retries, retrieval, compaction, background learning, and grading.
- Cold/warm latency, including p50/p95 when sample size supports them.
- Human review and maintenance effort.
- Cache behavior without treating cache-hit rate as the primary objective.

Predeclare tolerances and material savings targets. Reject new critical failures; report uncertainty for small samples. Passing a finite suite does not prove perfect accuracy or zero risk.

### Planning verification status

Source inspection, public-document research, CLI version checks, and the focused tests/probes in section 11.5 were performed. Research workers were used before the explicit routing preference was provided, as noted in section 2; this continuation used direct read-only research because the available worker interface cannot certify DeepSeek Free routing. No live application/provider benchmarks, third-party harness executions, installations, or application/configuration edits were performed. Implementation verification must use actual command outputs and outcome evidence, not historical reports or worker assertions.

## 11. Expanded harness audit — durable research checkpoint

Checkpoint date: **2026-10-21**. Scope includes Code Mode and custom instructions, not implementation. Findings below are saved before the next research pass. A source implementation or an inspected test is not proof of deployed runtime behavior or comparative superiority.

### 11.1 Evidence levels and repository identity

- **S — Source:** the relevant implementation was opened and inspected.
- **T — Test source:** a relevant regression test was inspected; external tests were **not run** here.
- **P — Local probe:** current behavior reproduced locally with mocks or harmless temporary inputs, not a live model/provider.
- **D — Documentation:** official/native documentation describes a capability; live activation is unknown.
- **M — README/metadata:** discovery or maintainer claim, not verified performance.
- **Unmeasured:** first-request savings, model adherence, success rates, latency/cost superiority, and production worker identity require later matched experiments.

Repositories and fixed source snapshots used in this continuation:

| Harness/reference | Repository and inspected revision | Inspection scope |
| --- | --- | --- |
| T3 Code | `pingdotgg/t3code`, `main`, `618761a2d6d615b2c0a07e5de4d82384a583f717` | Codex instruction delivery, capability-aware app guidance, orchestration instructions, handoff-budget/delivery tests. [H1] |
| ZCode | `zai-org/ZCode`, `main`, `3c5b227649371507ddc4eb46ac5133afe6db1cab` | Context builder, tool exposure/history tests, privileged Node REPL and lifecycle handling. [H2] |
| Orca | `stablyai/orca`, `main`, `7f21cc91b8f6cda56c24572fdbe9932bde9e8717` | Prompt transport, injected-turn classification, instructional-plugin integrity. Not a replacement provider loop benchmark. [H3] |
| Reasonix | `esengine/DeepSeek-Reasonix`, active `studio`, `35b9f132aecf2154c27407ebf5c4d3cc42ab33b9` | Instruction resolver/tests, provider reasoning replay, evidence readiness/tests, bounded memory recall. [H4] |
| Reasonix stable line | Same repository, `main-v2`, `9ee6ad0a81d27070e142880c219081f4b2ff8d22` | README version/distribution cross-check only. Current active-branch findings must not be attributed to every stable installation. |
| OpenHuman | `tinyhumansai/openhuman`, `main`, `cd272109efe7a74781dee15c1ae653b4c56cc28c` | Tool-pack visibility versus execution permissions, routing, instruction-path adapter/tests. [H5] |
| OpenCode | Canonical `anomalyco/opencode` (redirect from `sst/opencode`), `dev`, `4d5965762ec5e0d1a0b14630553fc62b51a11fba` | Code Mode catalog/runtime, typed tool boundary, instruction admission/update/test sources. Installed local `1.19.3` is not this source snapshot. [H6] |
| Pi | Canonical `earendil-works/pi` (redirect from `badlogic/pi-mono`), `main`, `cedefc53264f521f5a55be61b746a39c6ada8d4e` | Tool-aware system sections, resource/instruction loading, Code Mode host lifecycle and worker tests. [H7] |
| Gemini CLI | `google-gemini/gemini-cli`, `main`, `c1740d29301a73a47dc3501c1aecc7eb00c0ee58` | Trusted just-in-time instruction discovery, import handling, associated test sources. [H8] |
| Codex | `openai/codex`, `main`, `af91f6ef2cd66ead278ebe7d5751973eef430aee` | Native Code Mode cell/dispatch lifecycle, availability, output handling, global instruction refresh. [H9] |
| Cloudflare Code Mode | `cloudflare/agents`, `main`, `fc7f59fb00e7ae0045086b094b94a22abc760206`, `packages/codemode` | Executor, lazy connector docs/search, approval/replay proxy, executor tests. Not a coding-agent product comparison. [H10] |
| Aider | `Aider-AI/aider`, `main`, `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Token-targeted repository-map ranking, caching, freshness tests. [H11] |
| Cline | `cline/cline`, `main`, `e9dafbb764d0cb9acb4ef93a956ae72c350b3952` | VS Code instruction-toggle/write boundary and test source; active shared-SDK loader needs separate tracing. [H12] |
| Roo Code | `RooCodeInc/Roo-Code`, `main`, `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` | Custom-instruction compilation and global/project merge test source; added during the next audit pass. [H13] |
| Native Claude Code | Installed CLI `2.1.306`; CubiQ SDK pinned to `0.3.281` | Official instruction-loading documentation; SDK/bundled runtime may differ from installed CLI. No live prompt capture. ([R3], [C20]) |

**Branch correction:** the earlier legacy `main` Reasonix README pointed to a Go rewrite on `main-v2`. Current GitHub metadata and the pinned `studio` README identify **2.x `studio` as active** and **1.x `main-v2` as stable/maintenance**. Research the intended line explicitly, never rely on the old `main` README alone.

**Reuse boundary:** repository metadata identifies MIT for T3/Orca/Reasonix/OpenCode/Pi/Cloudflare, Apache-2.0 for ZCode/Gemini/Codex/Aider, and GPL-3.0 for OpenHuman. These are inventory observations, not a complete legal review. Borrow design ideas; review exact file licenses, notices, dependencies, and compatibility before copying code. No peer code was imported.

### 11.2 Code-grounded comparison — keep, adapt, do not copy

| Peer | Finding and evidence | Action for CubiQ |
| --- | --- | --- |
| T3 Code | **S/T:** Codex app context is kept separate from collaboration-mode text, tool-specific guidance is conditional on availability, numbered entries preserve section order, and tests constrain every entry to 4,000 UTF-8 bytes. Its source documents provider truncation/drop behavior; that behavior was not independently reproduced here. [H1] | Test the active adapter's delivered instruction channel and limits. Keep mode instructions separate from app capability guidance; do not assume the same limit for every Codex release/provider. |
| T3 Code | **S/T:** handoff tests preserve command exit outcomes, omit reasoning, budget the serialized envelope and images, track delivered/omitted item IDs, and avoid retrying an ambiguous injection. Orchestration guidance distinguishes child tasks from new threads and places provider/model/options in call arguments. [H1] | Extend CubiQ's existing handoff/injection mechanisms with coverage and retry-safety tests; validate requested model/options in the dispatcher. Do not copy the large always-on orchestration/HTML-publishing prompt. |
| ZCode | **S/T:** `buildToolExposure` separates native search, local search/router, resident tools, and unavailable tools; request projection preserves raw history and search/result pairing across additions/removals. [H2] | Extend existing discovery with provider capabilities and explicit exposure state. Avoid interpreting hidden-from-prompt as denied, or removing historical call/result pairs when catalogs change. |
| ZCode | **S:** context assembly distinguishes stable/dynamic and system/meta-user sections, does not mirror tool schemas into system text, and checks whether guidance tools really exist. Custom prompt and workflow identity paths are explicitly distinct. [H2] | Give CubiQ instruction parts provenance and explicit append/replace semantics. Do not copy blanket wording that repository/memory content overrides every default; permission/safety enforcement remains independent. |
| ZCode | **S:** its `js` tool uses persistent Node state, explicit high-risk/system permission, cancellation/reset generations, artifact/model output budgets, and disposal. The source explicitly says full Node privileges. [H2] | Borrow lifecycle, reset, output-contract, and stale-generation ideas. **Do not replace CubiQ's confined QuickJS sandbox with this privileged REPL merely to gain persistence.** |
| Orca | **S:** prompt transport sanitizes terminal escape bytes; known injected-turn shapes are separated from genuine user prompts; instructional-plugin content is rehashed against the user's reviewed identity before use. [H3] | Preserve source provenance and reviewed-content identity for imported instructions/skills. Prefer structured host metadata over guessing authorship from text tags. Native agent wrapping alone does not demonstrate fewer model tokens. |
| Reasonix | **S/T:** instruction resolution loads only the workspace-to-target ancestor chain, expands imports with cycle/diamond deduplication, records provenance, rejects source-boundary/symlink escapes, and tests stable machine-independent labels. [H4] | Improve CubiQ's root-only loader incrementally with confined, budgeted hierarchy/import support. Preserve portable labels and deduplication. No unconditional scan/load of every descendant rule. |
| Reasonix | **S/T:** final readiness consumes host receipts and requires applicable successful checks **after the latest write**, retaining captured check obligations despite later declaration changes. Tests distinguish missing versus unattributed/ungranted review evidence. [H4] | Reuse the existing project check gate but make completion evidence time/state-bound. Start with command outcomes and final-edit freshness; do not adopt its entire task-contract/goal machinery. |
| Reasonix | **S:** provider reasoning replay is endpoint-specific. Automatic memory recall is low-authority, relevance-filtered, default four hits/2,400 characters, excludes expired facts, and records suppression reasons. [H4] | Retain CubiQ's protocol/history protections and bounded learning; improve relevance, expiry, provenance, and replay-cache fingerprints rather than increase capacity. Defaults are source settings, not universal budgets. |
| OpenHuman | **S/T:** packed tools stay registered while schemas are withheld. Discovery and bare-call routing honor execution ceilings; tests catch the hidden-but-over-permission trap and preserve essential read/write routes. [H5] | Evaluate optional capability packs, but share one authorization decision across direct/router/code paths. Keep essential coding tools reachable and never use deferral as permission enforcement. |
| OpenHuman | **S/T:** instruction-path tests cover bounded reads, canonical same-directory deduplication, outside symlinks, and FIFO rejection. Underlying TinyAgents details were not inspected end-to-end. [H5] | Add equivalent harmless boundary/large-file tests to CubiQ. README claims such as “500 agents on a $10 VPS” measure neither LLM-token savings nor coding-task correctness. |
| OpenCode | **S/T:** immutable per-inventory runtime caches, namespace catalogs, lazy signatures/search with pagination, structured input/output diagnostics, and semantic instruction/catalog deltas are implemented. Instruction admission distinguishes temporary unavailability from confirmed removal and hashes canonical values. [H6] | Adapt compact discovery and explicit update/removal semantics without rewriting prefixes each turn. Treat unreadable safety instructions differently from optional memory. Do not build a duplicate native Code Mode when the active runtime already provides it. |
| OpenCode | **S/T caveat:** catalog's 2,000 estimated-token default is not a hard total cap: pinned tools and namespace descriptions remain, and a TODO notes unbounded namespace inventory. Runtime limits are configurable and can be absent. [H6] | Charge helper text, namespaces, pinned exceptions, signatures, and wrappers to a real budget. Do not claim peer defaults guarantee bounded requests or execution. |
| Pi | **S:** system instructions depend on declared tools, hide indirect tools from direct-use rules, deduplicate tool-contributed guidance, and separate custom prefix/append/full replacement. Its resource loader handles linked-worktree shadowing and project trust for replacement prompts/extensions. [H7] | Compile CubiQ's short guide from the actual tool surface instead of static model-family guesses; define override scope and avoid duplicate worktree instructions. Do not copy Pi's broader filesystem-ancestor policy without CubiQ trust boundaries. |
| Pi | **S/T:** Code Mode nested calls use the normal tool pipeline; host execution tracks pending calls, aborts their signals on first terminal outcome, ignores late events, and exposes worker admission/exit tests. Session store writes can follow conversation branches. [H7] | Fix CubiQ's lifecycle and scheduling through the shared broker. Add branch/worktree-safe reset/cleanup before considering durable state or replay. Worker tests are inspected, not run here. |
| Gemini CLI | **S/T:** high-intent file tools discover subdirectory instructions just in time; the manager checks folder trust, confines to trusted roots, tracks loaded file identities, and separates startup categories. Import processing excludes code regions and validates real paths. [H8] | Add path-triggered instructions outside Code Mode's reducible data return so a script cannot accidentally swallow policy. Retain explicit provenance; inspect exact import semantics before promising native parity. |
| Codex | **S:** native Code Mode uses execution cells, bounded output, cancellation/closure gates, and nested dispatch through the standard tool runtime. Availability distinguishes direct fallback from fail-closed Code-Mode-only execution. Global instruction refresh retains a last good value on temporary failure and clears confirmed absence. [H9] | Negotiate real native availability rather than infer it from a name/version. Specify CubiQ fallback versus native ownership and keep nested execution/approval/state evidence intact. This snapshot does not prove the user's installed Codex has these features enabled. |
| Cloudflare Code Mode | **S/T:** connector search/describe materialize TypeScript documentation on demand; namespaces and collisions are checked; a proxy separates audit-only call logs from bounded model output and supports approval/replay with execution identity. [H10] | Reuse search/describe/structured-result ideas in CubiQ's broker. Durable replay is optional later work, not a prerequisite to improve normal scripts. |
| Cloudflare Code Mode | **S caveat:** executor defaults block outbound networking; its lifetime gate releases pending RPC holds but explicitly **does not cancel already started host work**. Replay requires deterministic code or explicit steps, and rollback is compensation, not an atomic transaction. [H10] | Do not copy its gate and call it cancellation. Preserve CubiQ's no-direct-network stance and never imply “all calls rolled back,” exactly-once external effects, or safe mutation retries without evidence. |
| Aider | **S/T:** repository maps rank definitions/references and mentioned paths/symbols under a token target, cache tags by mtime, and expose refresh modes; tests explicitly show reuse can stay stale until refresh. [H11] | Pilot an on-demand, source-only repository/symbol map if ordinary search is insufficient. Label freshness and token estimates; do not add a persistent full repository map to every prompt or treat its target as a strict cap. |
| Cline | **S/T:** its current rule-toggle path resolves physical files to approved rule roots, rejects nested/outside/non-rule write targets, writes the same frontmatter the SDK reads, and verifies the requested enable state. The separately inspected SDK parser rejects malformed YAML; discovery tests deliberately support externally symlinked rule files. A write-boundary check is not a read-boundary guarantee. [H12] | Keep one authored instruction source and derive loaded/enabled UI state from the effective loader, not a competing toggle cache. Preserve explicit failure outcomes and owned-file boundaries; choose CubiQ's read trust policy separately. |
| Roo Code | **S/T:** instruction compilation has explicit global/mode/project sections, relative path labels, local overrides, legacy fallback, and default-off broader subfolder discovery. Merge tests assert global text precedes project text. Its loader follows rule symlinks and recursively collects content; no byte cap or physical-root confinement is visible in this function. [H13] | Borrow explicit scope labels and supported compatibility modes. Do not copy recursive rule loading or assume ordering/symlink-depth limits establish trusted, bounded context. Surrounding trust enforcement was not audited. |
| Claude Code | **D:** native hierarchy, path-scoped rules, imports, instruction diagnostics, and memory are already available in supported versions. Instructions are guidance, not enforced configuration; imports still consume context. [R3] | Prefer native ownership in the Claude adapter and CubiQ fallback elsewhere; verify the SDK runtime, not just the separately installed CLI. |

This is a **targeted source comparison**, not an exhaustive audit of every feature of the listed projects. Uninspected peer capabilities remain unknown; no relative reliability ranking is justified.

### 11.3 CubiQ Code Mode — verified foundation and concrete gaps

Keep the current foundation: QuickJS loaded lazily, no direct filesystem/network/process/modules, 30-second script timeout, 64 MiB VM memory setting, JSON session state with staged writes, discovery helpers, plain read/glob/grep values, child-call tracing, and a shared broker. The native-provider path permits more tools and authorizes children; the MCP code-server variant exposes only declared read effects (legacy fallback: `autoAllow`). These are **different execution surfaces**, not one universal permission mode. ([C15], [C23], [C24])

| ID / priority | Finding | Evidence and bounded consequence | Proposed acceptance test/change |
| --- | --- | --- | --- |
| CM1 — P0 | Script timeout/return/failure does not abort a separate script-owned child signal. | **S/P:** `watchStop` ends the sandbox, while broker calls receive the original caller signal. A warmed harmless probe timed out, found that child signal un-aborted, and saw mocked host work finish later. This is not proof every real tool ignores cancellation. [C23] | Create a script-owned controller, combine it with turn/request signals, close admission on every terminal outcome, abort pending children, and reject late results. Never claim already completed side effects were undone. |
| CM2 — P0 | Queued calls can execute after cancellation. | **S/P:** broker acquisition waits without signal-aware withdrawal or a post-acquire abort check. With one slot, a second mocked call started with `signal.aborted === true`. [C23] | Cancel and drain queued calls before starting them; keep one terminal record per admitted call; test cancellation before/after authorization and while queued. |
| CM3 — P0 | Broker concurrency ignores the tool's `parallel`/effect classification. | **S/P:** the main loop serializes unsafe calls, but the broker only limits total concurrency (default eight). Two `parallel: false` mocked writes overlapped with peak two. ([C23], [C28]) | Reuse one execution/scheduling boundary; serialize mutations and conflicting paths, allow independent reads, and test `Promise.all` cannot bypass it. |
| CM4 — P0 | “Scoped to the thread folder” currently means path resolution, not read confinement. | **S/P:** `resolvePath` marks outside paths but read/glob/grep do not reject them at this boundary; MCP code-server children have no authorization callback. A server rooted in the approved temp folder read an absolute **source manifest** outside it. No credential file was used. ([C24], [C25]) | Define authorized read roots explicitly, enforce realpath/symlink boundaries and sensitive-file policy at the tool boundary, and preserve approved artifact/skill roots. Test with harmless fixtures; never probe real secrets. |
| CM5 — P1 | Host log/bridge allocations are not covered by the VM limit; failure output is not bounded like success. | **S/P:** `console.log` appends host strings; failure branches call `failure` without `bound`. Probe returned **60,059 bytes** after an error, exceeding the ordinary **51,200-byte** bound. ([C23], [C25]) | Bound logs incrementally, bridge value size/depth, total calls/queue, and final success/error output; save recoverable artifacts. A cap on rendered output alone is not a host-memory cap. |
| CM6 — P1 | Nested calls do not consistently produce the same evidence as direct calls. | **S:** broker tool-use rows omit arguments/command payloads; rows after 40 are suppressed, not merely visually collapsed. Provider-loop check/repeat tracking sees top-level calls; MCP code-server `emitFromTool` bypasses the `runTurn` event collector. ([C23], [C28], [C34]) | Keep complete, sanitized host receipts independently of UI row limits. Carry parent/execution identity, input classification, outcome/exit status, and cancellation into evidence and learning. Do not reinject full audit logs into model context. |
| CM7 — P1 | Structured results and schema declarations are incomplete outside the native read/search tools. | **S:** app `ToolOutput` is primarily text/image/error; declarations default to `Promise<string>`. The small JSON-Schema-to-TS renderer does not resolve `$ref`/`allOf`, root unions, dictionary schemas, or arbitrary tool identifiers; it is documentation, not runtime typechecking. ([C24], [C27], [C35]) | Extend the canonical contract with optional structured output and shape metadata. Preserve `isError`, truncation, pagination, exit status, and provenance; add supported-schema and unsupported-schema tests rather than silently emit misleading types. |
| CM8 — P1 | Large-file recovery advice cannot work as written. | **S:** script read loads the complete file before checking 2 MiB, then rejects it before applying `offset`/`limit`, even though the error advises paging. [C25] | Check size/read bounded windows before loading full content; test a harmless over-limit file can be paged or receives accurate recovery instructions. |
| CM9 — P1 | Code Mode does not by itself shrink the advertised native-provider tool set. | **S:** provider `tools` equals the full `scriptable` array with `run_code` alongside direct tools. Existing behavior tests deliberately preserve that hybrid mode. ([C1], [C15]) | Benchmark hybrid/direct versus compact discovery under matched tasks before changing exposure. Do not reinstate removed Code-Mode-only behavior or hide essential tools by default. |
| CM10 — P1 | State ownership, concurrent commits, cleanup, and native equivalence need explicit contracts. | **S/P:** provider state is process-local per session; MCP state/read/tool maps are process-local per thread. Two harmless overlapping same-thread scripts lost one staged state write when a later completion replaced the shared map. Native detection special-cases OpenCode major version ≥2, not actual availability across peers. ([C24], [C36]) | Serialize scripts sharing state or apply revision-checked/explicit key patches; test no lost updates and thread/worktree isolation. Add reset/dispose on lifecycle/generation changes and capability negotiation. Persistence/replay is opt-in later work. |
| CM11 — P0 | Read-only scheduling metadata can bypass an app tool's approval intent in the MCP Code Mode surface. | **S/P:** `HarnessTool.effect` is explicitly scheduling, not permission. `readsOnly` includes `effect: "read", autoAllow: false` and the code-server broker has no authorization callback; a harmless mock ran unasked. An explicit `effect: "mutate"` tool was excluded, so not every app tool is exposed. ([C24], [C40]) | Separate script-callable effect policy from permission decisions. Preserve the same required approval/denial on direct and nested paths, or omit approval-required tools from the auto-allowed read-only wrapper. Test contradictory and legacy metadata without real side effects. |
| CM12 — P1 | Malformed nested input can become a valid default invocation. | **S/P:** non-object values not covered by the string shorthand become `{}`. A numeric input to an optional-only mock app tool was rejected directly, but normalized to `{}` in Code Mode and executed after the mock authorization allowed it. This is a validation inconsistency, not an approval bypass. ([C37], [C40]) | Reject unsupported root input shapes before normalization; retain only explicitly documented shorthands, then run the same validation. Test scalar/null/array/multiple-argument cases and that invalid input never invokes even a defaultable mutation. |

**Minimum Code Mode implementation slice:** CM1–CM4 and CM11 with regression tests first; CM5–CM8 next; then measured catalog/discovery and lifecycle improvements. Preserve direct coding tools and the MCP variant's read-only intent. Browser page mutations, shell commands, and external calls must keep their own permissions, not inherit “safe” from a wrapper.

Small model-facing guidance should describe the actual surface only: use direct tools for a simple operation; use a script for dependent reads or reducing large results; discover unfamiliar tools; await calls whose completion matters; parallelize only independent safe calls; return compact evidence with paths/line references. Add task-specific examples on demand, not another long always-loaded Code Mode manual.

### 11.4 CubiQ custom instructions and learning — explicit improvement track

| ID / priority | Current-source finding | Proposed bounded change |
| --- | --- | --- |
| CI1 — P1 | `createGuide` combines bundled → user → project guides, has mtime caching and legacy filename fallback, and exposes source parts for preview. Full guide bodies are concatenated; guide and root-file loaders have different size/refresh behavior. Root `contextFiles` reads only `AGENTS.md` then `CLAUDE.md`, exact-text deduped and capped at 12,000 characters per file. ([C26]) | Reuse these parts in one small instruction resolver with source, scope, identity/hash, loading trigger, effective channel, and budget diagnostics. Do not add another editable instruction store. |
| CI2 — P1 | Root loader does not expand `@` imports, load `.claude/CLAUDE.md`/local files, or apply nested/path-scoped rules. Local probe specifically confirms `@AGENTS.md` stays literal; it did not independently exercise every missing-file variant. [C26] | Add bounded/confined hierarchy and supported imports only for CubiQ-owned loading; prefer native resolution in native drivers. Specify differences from Claude/Pi/Reasonix instead of promising blanket compatibility. |
| CI3 — P1 | The base prompt says ordinary file content is data and “only the user gives instructions,” yet project files/skills are deliberately injected as guidance; shell background guidance also contradicts `shell_start`. ([C11], [C12], [C26]) | Distinguish approved instruction sources from arbitrary evidence and scope overrides explicitly. Generate capability guidance from available tool contracts; permissions/security do not become overrideable prose. |
| CI4 — P1 | Claude appends to its native preset, Codex sends developer instructions, ACP delivers a first-user-prompt guide, and the provider loop owns system assembly. These are not equivalent authority/loading channels. ([C1], [C2], [C3], [C4]) | Add adapter contract tests for delivery once, resume/compaction, mode/capability changes, truncation, unavailable tools, and duplication. No guidance for tools the surface cannot invoke. |
| CI5 — P1 | `parseSkillMd` accepts a small scalar YAML subset. Probe yields a literal pipe character for `description`, treats `disable-model-invocation: yes` as false, and ignores unsupported fields. `paths` rule frontmatter is not thereby promised as a skill feature. [C21] | Support the actual intended frontmatter contract, including multiline descriptions, and diagnose unsupported syntax/fields. Do not claim `yes` must be accepted without choosing a YAML/spec policy; never silently change invocation/security scope. |
| CI6 — P1 | Automatic lesson selection is capped at five but ignores task/path relevance until later outcome attribution; lesson text says to follow it unless the user says otherwise. [C8] | Relevance-first retrieval under bounded tokens; keep learned content lower-authority than current instructions, include freshness/provenance, and do not promote external/worker prose into rules automatically. |
| CI7 — P0/P1 | The learning outside-content heuristic matches `mcp__...`, not native `call_mcp_tool`; local probe reproduces the gap. Nested calls/suppressed rows further complicate source attribution. ([C31], [C23]) | Record origin at execution (external/repository/approved instruction/user), propagate through routers/scripts, and gate learning/promotion from provenance rather than tool-name prefixes. This is a filter gap, not a demonstrated poisoning incident. |
| CI8 — P1 | Extractor lookup closes over the initial `drivers` array; runtime provider drivers enter `Service.syncDrivers`. Background lookup also uses that static array, while the learner uses `service.allDrivers()`. ([C29]) | Resolve dynamically and test newly registered/removed providers. Preserve explicit background choices; no fallback to an unapproved model. |
| CI9 — P0 | Explicit background model strings are not catalog-validated, missing drivers fall through to automatic picks, and provider run/one-shot resolution can select the first saved model when the requested ID is absent. Team-member fallback can be reported after executing the wrong requested route. ([C13], [C30]) | Enforce exact provider/model/options and reject unavailable explicit selections **before** execution. Validate all routes: lead, worker, extraction, drafting, and replay. This audit does not establish the live account's route. |
| CI10 — P1 | Replay key includes case/lesson IDs, model, agent, app version, rollout, but not lesson/case content, schema/prompt/CLI/grader fingerprints. [C32] | Fingerprint inputs that affect a verdict and invalidate changed evidence. This is a stale-cache risk supported by key structure, not a reproduced incorrect promotion. |
| CI11 — P1 | Nonzero Bash exits retain `display.exitCode` but set `isError` only for timeout. Failure learning watches `isError`; check-command heuristics do not prove outcomes, and configured project checks run after the agent answer. ([C28], [C34]) | Represent transport/tool failure separately from command outcome, preserve expected nonzero exits, and bind verified completion to applicable commands after the last mutation. Reuse existing check/fix machinery, not a new framework. |

Suggested instruction contract, **not a new configuration schema commitment**:

1. Mandatory execution/safety policy remains enforced by tools and authorization.
2. A short app guide describes actual capabilities and lifecycle expectations.
3. Explicit user/project/path-specific guidance applies at its declared scope without widening permissions.
4. Skills/workflows load only when relevant/invoked; imported bodies still cost context.
5. Memory, inferred lessons, tool results, and peer reports remain attributed evidence with lower authority.
6. Optional-source errors can degrade visibly; unreadable mandatory policy must not silently disappear. Distinguish removed, temporarily unavailable, and disabled sources.
7. Stable core stays stable; effective changes use the adapter's supported update path and valid replay semantics. Show source/budget diagnostics without raw secrets.

Acceptance fixtures should cover conflicting global/project guidance, nested and sibling paths, imports/cycles/diamonds, symlink/outside roots, large/FIFO/nonregular files, a disabled tool with stale instructions, different native instruction-selection policies, resume/compaction, and instructions discovered inside a script but not returned by it. Keep existing architecture, renderer design, settings, and installations unchanged until approved.

### 11.5 Focused verification checkpoint — actual outputs, not a benchmark

Runtime used: Node **v24.3.0**, Vitest **4.1.11**. The existing temporary audit config is outside the repository at:

`/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode/cubiq-harness-audit-vitest.config.mjs`

It sets `envFile: false`, `envDir: false`, `setupFiles: []`, a focused include list, and two workers. Commands use `env -i`, a restricted PATH, and HOME/TMPDIR pointing to the approved temporary directory. No live provider requests or credential-file reads were required. The default eval scripts explicitly load `.env` and were **not run**. [C20]

**Run A — prior focused audit selection plus eight temporary current-behavior probes:**

```sh
env -i PATH="/usr/bin:/bin" HOME="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" TMPDIR="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" "/Users/phumrin/.local/bin/node" "node_modules/vitest/vitest.mjs" run --config "/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode/cubiq-harness-audit-vitest.config.mjs" --configLoader runner --reporter dot --no-cache
```

Actual aggregate output: **`Test Files 11 passed (11)`; `Tests 215 passed (215)`; duration `1.99s`.** The nonexistent `test/skills-tool.test.ts` in the old include list was not counted as executed coverage.

**Run B — expanded selection including Code Mode, declaration, guide, and skill-discovery tests:**

```sh
env -i PATH="/usr/bin:/bin" HOME="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" TMPDIR="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" "/Users/phumrin/.local/bin/node" --input-type=module -e 'import { startVitest } from "./node_modules/vitest/dist/node.js"; const ctx = await startVitest("test", [], { config: "/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode/cubiq-harness-audit-vitest.config.mjs", configLoader: "runner", reporters: ["default"], watch: false, cache: false }, { envFile: false, envDir: false, test: { include: ["test/code-tool.test.ts", "test/code-mode.test.ts", "test/code-script-data.test.ts", "test/ts-decl.test.ts", "test/guide.test.ts", "test/skills-discover.test.ts"], setupFiles: [], cache: false } }); await ctx.close();'
```

Actual aggregate output: **`Test Files 17 passed (17)`; `Tests 307 passed (307)`; duration `8.40s`.** Vite merged include arrays, so this contains the earlier selection plus six additional files: **299 existing tests and eight temporary probes**, not 307 new regression tests and not 522 independent tests across runs. Node emitted an experimental SQLite warning; no test failure was shown.

**Run C — continuation selection, additional browser/search/HTTP/output coverage:**

```sh
env -i PATH="/usr/bin:/bin" HOME="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" TMPDIR="/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode" "/Users/phumrin/.local/bin/node" --input-type=module -e 'import { startVitest } from "./node_modules/vitest/dist/node.js"; const ctx = await startVitest("test", [], { config: "/var/folders/bg/702ybqv14yv94_mflvq_tjwm0000gn/T/opencode/cubiq-harness-audit-vitest.config.mjs", configLoader: "runner", reporters: ["default"], watch: false, cache: false }, { envFile: false, envDir: false, test: { include: ["test/code-tool.test.ts", "test/code-mode.test.ts", "test/code-script-data.test.ts", "test/ts-decl.test.ts", "test/guide.test.ts", "test/skills-discover.test.ts", "test/browser-on-demand.test.ts", "test/harness-tools-search.test.ts", "test/mcp-http.test.ts", "test/bound.test.ts"], setupFiles: [], cache: false } }); await ctx.close();'
```

Actual aggregate output: **`Test Files 21 passed (21)`; `Tests 349 passed (349)`; duration `3.47s`.** This is **341 existing tests plus the eight temporary probes**; runs overlap and must not be added as independent coverage. Node emitted the experimental SQLite warning. The checkout independently advanced to `f2add6c656709da7acfa473ae31c3a8dc93c9ddc` by this verification; test counts changed in Code Mode/data files. Treat the run as evidence of the files exercised then, not a frozen reproduction of every earlier commit. No tests were edited by this audit.

The eight temporary probes confirm current behavior for nonzero Bash status, schema estimates (sample **91** versus **54** character-estimated tokens for emitted definition), explicit background model/driver selection, replay-key inputs, outside-content name detection, frontmatter subset, and literal root-file imports. Passing a behavior probe validates the observation, not that the behavior is desirable or fixed.

**Additional harmless inline probes:** Vite `createServer` used `configFile: false`, `envFile: false`, `envDir: false`, middleware mode, and an approved temp cache directory to load the actual Code Mode modules. Warmed QuickJS/mock probes reproduced CM1, CM2, CM3, CM5; a source-manifest-only absolute read reproduced CM4. These five probes are not part of the 307-test total. The first cold-start timeout probe failed in the probe runner before observing a broker signal (`Cannot read properties of undefined`); it is not counted as successful evidence. A warmed rerun completed with all assertions and the reported observations.

**Typecheck continuation:** all three project configurations completed without diagnostics using the existing TypeScript CLI under the same clean environment:

```text
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --incremental false --composite false
node node_modules/typescript/bin/tsc -p tsconfig.web.json --noEmit --incremental false --composite false
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit --incremental false --composite false
```

The actual shell command ran each with the `env -i` PATH/HOME/TMPDIR and absolute Node launcher shown for Run C, chained with `&&`; it returned successfully with **no output/diagnostics**. Incremental/composite flags were disabled only for this invocation to avoid writing build-state files; no project configuration changed. This is typecheck evidence, not lint/build or runtime correctness.

**Not yet run:** full application suite, lint, desktop/browser E2E, live 25k startup reproduction, comparative task evals, peer test suites, or production cancellation/permission probes. No fix was applied. This checkpoint cannot establish perfect accuracy, lower total task consumption, or the user's real runtime configuration.

### 11.6 Remaining research, with immediate-save discipline

- Spot-check additional native/peer instruction delivery and schema tests only when they address a named gap; save the finding here before the next fetch batch.
- Verify baseline changes as the user's checkout evolves, especially browser-on-demand and Code Mode defaults; do not overwrite concurrent edits.
- Persistence checkpoint at `5178b93568818ca370b3bcb1a7a10f2b75d459eb`: document reference check found **56 definitions**, **no missing/duplicate references**, **65 commit-pinned peer source links**, balanced code fences, **10 CM findings** and **11 CI findings**. `git diff --no-index --check /dev/null pland.md` produced no whitespace errors. Scoped tracked diff of application/resources/tests/scripts/instructions/config manifests was empty. Preexisting `road-map-handoff.md` deletion and unrelated untracked images were left untouched; no commit was made.
- Finalize small implementation slices and held-out acceptance cases from CM/CI IDs, avoiding another general-purpose framework or universal prompt dump.
- Verify this document's references/diff/whitespace and report preexisting dirty files separately. Application edits and actual provider benchmarking still require their respective authorization/access.

### 11.7 Continuation checkpoints — current revision and deeper boundary review

**N1 — current source, `5178b93568818ca370b3bcb1a7a10f2b75d459eb`:** the newer convenience/guidance changes do **not** implement CM1–CM3. `code.ts` still forwards the original signal to broker calls and ends the VM without a script-owned child controller; `code-broker.ts` still waits on a signal-unaware queue and never consults `parallel`. Current-revision mock probes below reconfirm these observations. ([C23], [C24])

**N2 — argument convenience is broader than a read/glob/grep-specific adapter:** `code.ts:35–39,257–281` maps a bare string to **any** tool with exactly one required string field. The declared TypeScript signature and `CODE_DESCRIPTION` still describe the object-call form; unsupported non-object values are converted to `{}` for the underlying tool to validate. This may be a deliberate convenience, not automatically a defect. Acceptance must cover single-string normalization, tools with several required fields, optional-only tools receiving malformed input, no accidental mutation, and documentation/runtime agreement. This did not add cancellation, containment, or scheduling checks. [C37]

**N3 — current guidance and exposure surfaces:** `code-hint.ts` tells agents to use one script for project exploration rather than conditionally choose it by workload. The MCP code-server description now clarifies directory reads as arrays. `browser/on-demand.ts` no longer describes an opt-in experiment, but routing/default/command wiring still needs current-source confirmation before retiring the earlier “opt-in” finding. Benchmark the hint on simple as well as multi-read tasks; one extra wrapper/script is not necessarily cheaper for a single read. [C37]

**N4 — browser deferral wiring confirmed, not merely a commit message:** `index.ts:614–620` selects the browser discovery/call pair whenever the initial driver lookup lacks `capabilities.toolSearch === true`; design threads are explicitly exempt and keep their own tool set. There is no experiment-setting condition. The Code Mode MCP server separately builds script tools from the original `harnessTools`, not this deferral pair, and filters declared read effects. The earlier “opt-in browser deferral” description is historical, not current. Initial-array versus runtime-provider capability lookup remains a compatibility edge case, not a reproduced routing failure. ([C33], [C38])

**N5 — normalization coverage is incomplete:** current `code-tool.test.ts` still contains 16 tests and no bare-string normalization case. `grep.ts:221–240` accepts runtime alias `output_mode: "files"` even though its advertised enum lists only `files_with_matches`, `content`, `count`. It validates the regex with JavaScript before choosing ripgrep, so engine support is not interchangeable. Keep convenience explicitly documented/tested and distinguish benign alias acceptance from missing strict validation; do not infer better tool accuracy from the convenience commit alone. [C38]

**N6 — current-revision boundary probes, actual output:** on `5178b93`, a warmed QuickJS test with a controlled promise and mock broker reproduced: `CM1 RECONFIRMED: timeout result returned, child signal un-aborted, mocked host work completed later`; `CM3/CM6 RECONFIRMED: parallel=false mocked writes overlapped at peak=2; use rows lack input payload`; `CM2 RECONFIRMED: queued mocked call began after abort`; `CM5 RECONFIRMED: failure output 60059 bytes`. Assertions completed successfully, with no real writes/network/model calls. A separate negative case using an already-aborted signal returned a stopped error with **zero** broker calls: do not generalize the queue/timeout issue into “every stopped script executes.” These are standalone probes, not added regression coverage or a 307-test rerun.

Probe invocation used the same clean environment (`env -i`, PATH `/usr/bin:/bin`, HOME/TMPDIR in the approved temporary directory), Node `--input-type=module -e`, and Vite `createServer({configFile:false,envFile:false,envDir:false,cacheDir:<approved temp>,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]}})`. It loaded `/src/main/harness/tools/code.ts` and `/src/main/harness/tools/code-broker.ts`; controlled gates established execution order, avoiding reliance on a cold VM starting within a tiny timeout. For the later implementation, convert these observations into normal tests that assert the corrected behavior.

**N7 — containment/resource caveats from current source:** `glob.ts:67–89` skips descendant symlinks, but callers can explicitly choose an outside or symlinked **root** through `resolvePath`, which checks lexical location rather than realpath confinement. `read.ts:57–78` still reads the complete file before its script-size check/window, while `glob` collects/sorts all matches before its 5,000-result script limit. Ripgrep output in `grep.ts:48–114` is accumulated before result caps; its fast path does not pass the advertised 1 MiB file-size cap. The fallback skips files above 1 MiB. Treat these as implementation differences requiring harmless fixtures, not evidence of a real secret leak or memory-exhaustion incident. ([C25], [C39])

**N8 — harmless filesystem fixtures reconfirm CM4 and reproduce CM8:** a temporary workspace and separate `outside` folder under the approved temp parent contained only authored dummy text. MCP Code Mode read that fixture via absolute path, `../outside/...`, and an inside-root symlink. The same code server rejected a **2,400,000-byte** text fixture despite `offset:1, limit:1`, with the “over 2 MB” paging advice. Assertions passed; fixtures were removed. No secrets or real user files were accessed. Actual output: `CM4 RECONFIRMED: absolute, ../ traversal, and symlink reads reached a harmless fixture outside the root`; `CM8 REPRODUCED: a 2400000-byte harmless file is rejected even with offset=1, limit=1`.

**N9 — permission and effect are separate contracts (new CM11):** a code-server mock with `effect:"read", autoAllow:false` ran without any permission callback; a legacy `autoAllow:true` tool also ran, while `effect:"mutate", autoAllow:true` was excluded. This confirms the metadata distinction is lost at this wrapper, not that a particular enabled production tool has been exploited. `agents/types.ts:36–39` defines `autoAllow` for asking and `effect` for scheduling; `appLoopTool` preserves that distinction on the ordinary provider path. The read-only MCP wrapper must not silently substitute effect metadata for authorization. ([C24], [C40])

**N10 — “MCP-capable” is surface-specific:** the code server receives router tools, but current `call_mcp_tool` is `autoAllow:false, effect:"mutate"`, so `readsOnly` excludes it even for an underlying MCP method that only reads. `search_tools` can be present without an executable MCP-call route inside this sandbox. Preserve this conservative boundary unless individual method safety/permission/cancellation is explicitly supported; do not claim MCP scripting parity with the native-provider Code Mode from a UI label or README. ([C24], [C31], [C38])

**N11 — state race (CM10 raised to P1):** a controlled mock paused script A after staging `left=1`; script B completed and saved `right=2`; A then completed and replaced the shared state snapshot. A follow-up `load` returned only `{"left":1}`. Actual output: `STATE RACE REPRODUCED: overlapping scripts on one thread lost the right=2 state write`. This is direct code-server invocation with harmless in-memory values, not evidence that a specific native adapter permits overlapping production turns. `run_code` is declared read-effect/auto-allowed over MCP and no same-thread execution lock exists at this boundary; test the actual adapter scheduling too. ([C23], [C24])

**N12 — trace suppression can hide a denied outcome (CM6):** a mock broker authorized 40 calls, then denied the 41st. The denial returned to the script, but emitted no error tool-result event because calls past the UI limit suppress events entirely. The aggregate `Note` had a successful “Not listed” result. Actual output: `CM6 REPRODUCED: the 41st denied call had no failure receipt; only the aggregate Note row remained`. Do not confuse 41 emitted results (40 real + one note) with complete receipts. Keep outcomes independently of visual row reduction. [C23]

**N13 — argument normalization discrepancy (new CM12):** `appLoopTool` rejected numeric root input to an optional-only mock tool; the sandbox converted numeric input to `{}` and invoked that same mock after an explicit allow decision. Actual output: `NORMALIZATION GAP REPRODUCED: direct numeric input was rejected; nested numeric input became {} and invoked the mock action`. No real mutation occurred and permission was not circumvented in this probe. Correct the input boundary rather than add another reminder to “use JSON.” ([C35], [C37], [C40])

**N14 — added peer discovery, not yet findings:** GitHub metadata resolved `cline/cline` at `e9dafbb764d0cb9acb4ef93a956ae72c350b3952` and `RooCodeInc/Roo-Code` at `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`, both `main` and Apache-2.0 according to metadata. Target the instruction/rule trust and tool-contract boundaries only; do not describe their behavior until relevant implementation/tests are inspected. No installations or peer execution.

**N15 — MCP transport lifecycle needs an explicit contract:** `mcp-http.ts:231–248` builds a signal from incomplete HTTP-response closure, passes it only when a thread/code ID is present, and does not combine the MCP handler's request signal with that context. Its server is stateless and newly constructed per HTTP request. Thus “user Stop,” HTTP disconnect, MCP cancellation, and script timeout are different paths; a context signal alone does not establish all four work. `readJson` also accumulates the entire HTTP body before parse without a byte cap. These are source-level gaps requiring SDK-contract/harmless mock tests, not a network pentest or a demonstrated live cancellation failure. [C41]

**N16 — Roo Code custom instructions, S/T:** the pinned compiler and global merge tests support separate global and mode-specific text, generic/mode-specific rule folders, AGENTS/local overrides, legacy fallback, path headers, and explicitly opt-in wider subfolder discovery. This is useful instruction compatibility evidence, not permission enforcement. The rule collector recursively reads files and resolves symlinks (depth five); a recursion-depth check does not cap total files/bytes, and this function lacks a realpath root-boundary check. Surrounding workspace trust/permissions were not inspected, so do not call the whole product insecure. Adopt scoped loading and bounded diagnostics, not this loader wholesale. [H13]

**N17 — schema rendering is not validation, peer correction:** OpenCode's pinned `tool-schema.ts` renders local `$defs`/`definitions`, `allOf`, unions, dictionaries, quoted keys, and constraint JSDoc with depth/unresolved-reference guards. Its `decodeInput`/`decodeOutput` actually decode **Effect schemas** but return raw JSON-Schema values unchanged. Therefore the earlier typed-boundary description applies to the schema-native path; surrounding host validation is still required for raw schemas. CubiQ should test the runtime validator independently of declaration quality, not assume a better TypeScript signature validates anything. [H6]

**N18 — compact definitions need a canonical host contract:** Codex's pinned `tool_definitions.rs` reuses cached Code Mode definitions, renders from the tool spec otherwise, then drops input/output schema copies after augmentation. This is memory/representation separation, not evidence that tools execute unvalidated or that CubiQ should delete its canonical schemas. Use one authoritative host-side contract and smaller model-facing signatures with measurable wire size. [H9]

**N19 — Cloudflare schema adapter has broader documented fallback coverage:** its pinned `json-schema-types.ts` resolves local JSON Pointers only (no fetching external `$ref` URLs), returns `unknown` for unresolved/circular/deep structures, supports boolean schemas, nullable, unions/intersections, tuples, dictionaries, and quoted identifiers. These are renderer features, not a complete validation/safety guarantee. For CubiQ CM7, inspect/test exact generated syntax and semantics for the used schema subset; preserve actionable “unsupported schema” diagnostics rather than falsely imply no-argument functions. [H10]

**N20 — Cline effective-state versus UI-state lesson, S/T:** the pinned VS Code toggle implementation writes `disabled` into the rule file consumed by the SDK, verifies the resulting state, and distinguishes `written`, `skipped`, `failed`. Physical-root/direct-child checks prevent toggle writes into outside symlink targets or files the SDK does not load. Tests assert stale state-only toggles do not rewrite authored files, hand edits remain authoritative, malformed rules show the SDK state, and identical writes preserve mtime. This supports CubiQ's source-of-truth, portability, and truthful “loaded” diagnostics requirements. It does not establish all runtime instruction-loading safety or task accuracy. [H12]

**N21 — do not infer runtime from legacy helpers:** Cline's inspected `rule-helpers.ts` includes frontmatter parse-failure **fail-open** rendering, while the current toggle/SDK state tests treat unparseable mapping frontmatter as not loadable. Its own comments say SDK loaders consume direct children and frontmatter state. These may be separate code paths; trace the shared SDK loader before describing Cline's actual parse policy. Apply the same discipline to CubiQ's native adapters: test the channel used, not the similarly named unused helper. [H12]

**N22 — current tests have narrow verification scope:** CubiQ's inspected search tests force the JavaScript fallback with an empty PATH; that does not verify ripgrep/file-size/ignore parity. The inspected HTTP MCP tests cover authentication, discovery, project/thread binding and progress heartbeats, but do not establish script-timeout child cancellation or strict JSON body budgets. Extend focused existing coverage for the boundary rather than assume the suite proves all variants. ([C39], [C41], [C42])

**N23 — official MCP contract clarifies CM7/CM11:** the `2025-11-25` tools specification defines optional `outputSchema` and object `structuredContent`, requires server structured results to conform when a schema is supplied, and recommends client validation. Tool names can contain hyphens/dots, so `declare function <raw name>` is not a universally valid JavaScript/TypeScript binding. It also says annotations are untrusted unless the server is trusted: `readOnlyHint` is not permission authority. CubiQ's current HTTP and Claude result adapters emit text/images/error only, while allowed tools are separately selected by `autoAllow`. Preserve this separation when adding structured Code Mode outputs; do not auto-approve an external MCP method from its annotation. ([R10], [C35], [C43])

**N24 — cancellation is not rollback:** official MCP cancellation is optional, can lose a race to completed processing, and callers should ignore late replies. Task-augmented requests use a different cancellation mechanism. A transport notification alone cannot promise no side effects after Stop, undo completed actions, or exactly-once retries. Acceptance needs explicit queued/started/settled/unknown-effect outcomes and transport/turn/script cancellation separately. Applies to CM1–CM2 and N15. [R11]

**N25 — `/codemode` scope verified only as command metadata so far:** current `src/renderer/src/commands.ts:18` says on/off applies to **new threads**. The code-server `codeModes` resolver stays fixed on first access for the current app run, consistent with the cached-tool-prefix rationale. This is not a mid-session native capability toggle and must not be presented as one; actual handler and restart behavior need a separate check. ([C24], [C44])

**N26 — Cline SDK parser policy traced, S/T:** the pinned shared loader's `parseRuleConfigFromMarkdown`/skill/workflow variants throw on malformed YAML and on non-boolean enable/disable fields, strip UTF-8 BOM, require usable bodies, and distinguish workspace/global AGENTS identities. Its tests cover BOM, legacy file layouts, managed plugin namespaces, workflow precedence, and rule/workflow symlinks to an external fixture. This resolves N21 for the shared parser: the older fail-open helper is not the parser policy. It also confirms toggle-write confinement must not be misreported as all instruction-read confinement. Watcher-to-effective-prompt delivery remains a separate boundary to verify. [H12]

**N27 — current first-request breakdown omits components it actually advertises:** provider `driver.ts:405–418` counts base/guide/project/memory, native+task schemas, app schemas, and skills, but omits `run_code`, ask/propose schemas, environment and plan text, wrappers, and the current user prompt. Auto-compaction overhead uses the fuller system/tool serialization. Therefore the displayed initial total is not a complete first-request total even after fixing Zod-internal estimates. Extend existing measurement from final request components; label native-owned/unknown segments. [C45]

**N28 — instruction refresh is neither uniformly frozen nor uniform across drivers:** provider calls `contextFiles(input.cwd)` when assembling each turn, despite the file's “read once per session” comment; `createGuide` is mtime-cached but can change across turns. ACP injects guide/expert/memory only when `guidePending`; it clears that flag before checking a startup abort or making the prompt request. A failed/aborted delivery can therefore require transactional pending-state handling. No failure was reproduced yet. Test accepted delivery, retry, resume/compaction, and cache/reasoning bindings rather than rely on comments or a generic “stable for the session” claim. ([C26], [C45])

**N29 — continuation verification checkpoint:** focused Run C completed with **349 passing tests in 21 files**, recorded in section 11.5. `git diff --exit-code` for application/resources/tests/scripts/instructions/manifests was empty. The checkout advanced independently to `f2add6c656709da7acfa473ae31c3a8dc93c9ddc`; final review qualifies current versus historical findings rather than assuming no concurrent change. Only `pland.md` was edited by this audit, and preexisting deletion/images remain untouched. Final document validation passed as recorded below.

**N30 — final-revision reconciliation:** scoped `git diff 5178b93..f2add6c` showed **no changes** in the Code Mode engine/broker/server/read/hint and the inspected Code Mode tests, so the reproduced core gaps have not been fixed by those intervening commits. Recent independent history does report Claude skill allowlisting and OpenCode synced-skill hiding with estimated request savings. Those are discovery/history claims pending source review, not measured savings or fixes by this audit. Preserve them as existing work and reevaluate overlap rather than recommend another universal skill-discovery layer.

**N31 — actual document/type verification:** final standalone validation reported **69 reference definitions**, no missing/duplicate references, **77 commit-pinned peer links**, balanced fences, **12 CM findings**, **11 CI findings**, **31 checkpoints**, **six implementation slices**, **no table-column issues**, and **no trailing whitespace**. All three project TypeScript configurations completed without diagnostics, as recorded in section 11.5. A no-index new-file diff can return a difference exit status even when its whitespace check prints no errors; do not use an `&&` chain that silently skips reference validation. Document integrity checks are not proof of live token savings or corrected runtime behavior.

Document review also caught an unescaped pipe character inside the CI5 table cell; the cell now describes the literal character in words so Markdown column structure is preserved. This was a document formatting issue, not an application-code fix.

Every checkpoint is saved before starting the next inspection/probe. No application fixes, settings changes, installations, or commits are authorized by these findings.

### 11.8 Bounded implementation slices — proposed, approval still required

Do not implement the research log verbatim as permanent prompt text. The following consolidates the findings into small changes to existing components, not a new harness/framework. Use the user's approved exact worker route or surface that it is unavailable before delegating implementation.

| Slice | Exact scope / decisions | Exit evidence |
| --- | --- | --- |
| **S0 — request and route truth** | Extend `harness/driver.ts`, `context-preview.ts`, existing usage/breakdown paths and route resolvers. Count final serialized system, user, and advertised tool components; label estimates/native-owned gaps. Reject missing explicitly requested provider/model before run/one-shot/background dispatch. No live secrets or raw prompt dumps by default. | Initial component sums match the captured request representation; include run_code/ask/plan/env/user overhead. Requested unavailable routes never invoke a fallback mock. Cold/warm performance remains unmeasured until matched provider evals. |
| **S1 — Code Mode execution boundary** | Keep QuickJS and `createCodeBroker`. Add run-owned cancellation/admission, signal-aware queued work, bounded cleanup and late-result handling. Reuse ordinary permission/scheduling semantics; serialize mutations. For the auto-allowed read-only MCP variant, **omit approval-required/unknown-effect tools initially**, rather than build a second permission router. Allow parallel safe reads only. Serialize same-thread/session stateful scripts initially to avoid whole-map lost updates. | CM1–CM3/CM10/CM11 controlled-gate tests: zero queued starts after abort, children receive abort, late completions cannot overwrite state/receipts, unsafe calls never overlap, no lost state, denials preserved. Pre-aborted and normal successful scripts still work. Document non-cancellable external-effect uncertainty. |
| **S2 — read roots, input, and resource limits** | Extend existing file path/read/search boundaries, not prompt prohibitions. Default to authorized worktree/project root; explicitly admit needed harness artifact/skill roots without blanket home access. Resolve physical paths before access. Validate root argument shape before any documented shorthand. Apply file/window/log/queue/bridge limits before expensive allocation; bound errors too. | CM4/CM5/CM8/CM12 fixtures: traversal/symlink/outside denial before reads, allowed artifact roots still work, invalid input invokes nothing, over-limit reads page correctly or give accurate recovery, UTF-8/error outputs and queued call budgets stay bounded. No real secret probes. |
| **S3 — receipts and structured contracts** | Share child-call outcome recording with the existing evidence/learning collector. Keep all sanitized outcomes independently of the 40-row visual limit. Add structured output only as a backward-compatible optional contract; preserve existing string/array scripts. Runtime validation is separate from JSON-Schema-to-TypeScript rendering. Keep canonical contracts host-side and budget model-facing declarations. | Direct/router/script calls carry matching command status/provenance/parent IDs, failed/denied 41st calls remain recorded, checks after final writes govern completion. Test `$ref`/union/dictionary/name handling on the supported subset, actionable unsupported-schema errors, and no stdout-text parsing dependency. |
| **S4 — scoped custom instructions** | Reuse `createGuide`/context file parts and native loading where supported. Add source/scope/hash/trigger/effective-channel diagnostics and a bounded trusted fallback resolver. Separate app guidance, repository/path rules, skills, and lower-authority learned facts. Commit pending instruction delivery only after the adapter accepts it; preserve failure/retry state. Avoid duplicate injection and inactive-tool hints. | Fixtures for hierarchy/import cycles/diamonds/siblings, trust/read boundaries, malformed YAML, removal versus temporary unreadability, resume/compaction, aborted/failed ACP first delivery, and policy discovered inside a script but not returned. Native-vs-owned adapter parity is reported, not assumed. |
| **S5 — evaluate and retire overlap** | Evaluate the **existing** browser deferral/hybrid Code Mode under simple, bulk-read, dependent-read, MCP, and mutation tasks. Prefer genuine native Code Mode when available, with explicit CubiQ fallback ownership. Reuse existing eval runner/learning budgets; only later add reviewed snippets or durable state if repeated tasks justify it. | Matched held-out task outcomes, total lead/worker/retry/learning tokens, invalid calls and cold/warm latency—not schema size alone. No new critical regressions. Disable duplicate capabilities one at a time with rollback; no autonomous installation/permission/routing changes. |

Within each slice, write focused tests before changing behavior, review the actual diff, and run safe real checks. Source-guidance cleanup can be paired with the slice it describes, but larger schema exposure and persistent replay must wait for the execution boundary and measurement to be sound. Preserve current application architecture, UI/theme/tokens, settings not explicitly in scope, and unrelated dirty files.

**Current next action is verification/planning only:** these slices are ready to discuss or approve individually; `next` in this research flow does not authorize changing application code. Focused tests/typechecks are recorded above; the full suite/lint, runtime provider benchmarks, and active configuration remain separate verification/access questions.

## 12. Design mode track — zero-pick start, auto style, inspiration notes

Added **2026-10-22** at the user's request. This is a **separate track**: the section 1 non-goal ("no UI redesign") still applies to sections 3–11. Same status as the rest of this file: a proposal. Changing code needs approval, and any change under `src/renderer/**` follows the repo-root `DESIGN.md`.

The user asked for three things:

1. A design mode that needs no up-front picks (no "Full", no tier, no system).
2. A replacement for the current theme/template picker and its styling, which the user dislikes.
3. A way for the AI to get inspiration notes from the best sites and styles.

### 12.1 Current state (verified in source, 2026-10-22, branch `m4` at `9f13ac0`)

| What the user picks today | Where | Default when nothing is picked |
| --- | --- | --- |
| Permission mode: Ask, Auto-edit, Plan or Full | `src/renderer/src/components/DesignSettingsMenu.tsx:82-95`, `ThreadControls.tsx` | Driver default |
| Design system: one of 5 bundled (`clean`, `dashboard`, `editorial`, `mono`, `playful`) or the project's own | `DesignSystemMenu.tsx`; `resources/design-systems/*/DESIGN.md` (~52 lines each) | `project`, then **`clean`** (`src/main/design/systems.ts:140-146`) |
| Prototype tier: Quick, Working or Real app | `TierMenu.tsx`; `src/shared/tiers.ts` | `working` (`tiers.ts:5`) |

Consequences:

- **Unpinned designs mostly look the same.** Without a project system, every design falls back to `clean` ("well-made SaaS settings page", `resources/design-systems/clean/DESIGN.md:4`). A landing page, a game menu and a finance dashboard therefore start from the same blue-on-white kit. This is the template look the user dislikes.
- **The tier asks the wrong question.** It sets how much discipline to apply (`tierNote`, `tiers.ts:47-55`), but users think in terms of what they are making. The surface (landing page, app screen, docs, portfolio) already tells the agent most of this.
- **Permission friction.** I found no auto-allow for writes inside the design folder (`designDirName`) in `approvals.ts`, `harness/permissions.ts` or the driver permission paths. Under Ask, each file write prompts, which pushes users to pick Full. *Re-verify on a live design thread before acting on this.*
- **No inspiration input.** Apart from an optional user-attached reference image (`resources/skills/design-prototype/SKILL.md:16`), the agent has nothing about good real-world styles. `design_lint` checks spacing, contrast, targets and colour (`src/main/design/lint.ts`), but nothing for generic AI patterns ("slop").
- **Offline canvas.** `resources/DESIGN-MODE.md` forbids network and web fonts, so every style falls back to system font stacks. That alone makes pages look alike.

### 12.2 Verdict on "no need to pick anything"

**Yes, it's a good idea, with three guardrails:**

1. **Infer, show, allow override.** The agent infers the surface, mode, tier and style on the first turn. The single chip then reads e.g. `Auto · Persuade · Riso Print`, and any part can still be changed in one click. Remove the up-front pick, not the control.
2. **The brief wins.** If the prompt names a style, colours, fonts or a reference, follow it exactly. Inference only fills the axes the user left open (Impeccable and Anthropic's frontend-design skill both state this rule).
3. **Never auto-switch to Full.** Instead, auto-allow writes **inside the thread's own design folder** in every mode except Plan. Anything outside that folder follows the normal mode. This removes the reason people pick Full without widening access.

Existing threads with an explicit system or tier keep their exact behaviour (no-regressions rule). "Auto" is a new stored value, not a reinterpretation of `null`.

### 12.3 OpenPencil — what to adopt

Repo: [ZSeven-W/openpencil](https://github.com/ZSeven-W/openpencil) @ `d155cd0`. MIT, ~6.4k stars, pushed 2026-10-21. It is an AI-native vector design tool (Rust, Skia canvas, `.op` JSON files, MCP server, design-to-code). Its prompt corpus is in `crates/op-ai-skills/skills/`, with the loader in `crates/op-ai-skills/src/compose.rs` and `src/budget.rs`.

| Concept | Their mechanism | Take for CubiQ |
| --- | --- | --- |
| **Design-type detection** | `phases/planning/design-type.md`: classify by purpose. Type 0 = a single component (400 wide, no page chrome), 1 = multi-section page (1200, scroll), 2 = single-task screen (375×812), 3 = data workspace, 4 = deck (1920×1080). It also states that "mobile login" means a real mobile screen, not a phone mockup. | **Adopt** as the first-turn surface classifier. It replaces the need to pick a tier or format, and fixes "profile card" being built as a whole page. |
| **Style-guide auto-selection** | `phases/planning/style-guide-selector.md`: the agent infers 3–5 tags (platform, visual, industry) and picks the guide with the best tag overlap. ~50+ guides in `skills/style-guides/*.md`, each with frontmatter `tags:` and `platform:`, plus a self-contained palette, type, radius and component spec. If nothing matches, it falls back to defaults. | **Adopt the mechanism; write our own content** (see 12.6). This directly replaces the theme picker. |
| **Phase-scoped prompt loading** | Each skill file has frontmatter `phase: [planning|generation|validation|maintenance]`, `trigger.keywords`, `priority` and `budget`. `compose_system_prompt` adds skills in order and **drops whole trailing skills** once the character budget is reached (`compose.rs:12-30`). | **Adopt.** Load the planning notes on turn 1 and the generation and validation notes only when used. Fits section 3's token goals and [[context-no-bloat]]. |
| **Anti-slop + cross-generation memory** | `phases/generation/anti-slop.md`: section rhythm, no identical card groups, and `{{recentHistory}}`. The heading font and palette **must differ from recent generations**. Also 1–3 small "creative variations" per design. | **Adopt.** Keep a small per-project history of style, heading font and palette (no content) and include the last 3 in the selector. |
| **Vision QA with structured fixes** | `phases/validation/vision-feedback.md`: screenshot plus node tree go to a model, which returns JSON `{qualityScore, issues, fixes[]}`. It explicitly does not judge image taste. | **Partly there already** (`design_screenshot`, `design_critique_save`). Add the checklist items we lack: sibling width consistency, structural consistency, missing borders on inputs. |
| **Model-capability prompt tiers** | Full-tier models get complete prompts with thinking; standard-tier models run without thinking; basic-tier models get simplified prompts. | **Adopt the idea:** prompt richness follows the model, not a user pick. Cheap or free models get the short notes. |
| Concurrent agent teams by spatial region | The orchestrator splits a page into hero, features and footer, and agents build them in parallel. | **Later, maybe.** It conflicts with [[experts-manual-only]] and adds token cost. Not in this track. |
| Rust/Skia canvas, `.op` format, Chinese trigger keywords | — | **Don't take.** Our canvas is HTML. Keep English-only content ([[experts-english-only]]). |

### 12.4 Impeccable — what to adopt

Repo: [pbakaus/impeccable](https://github.com/pbakaus/impeccable) @ `8644175`. Apache-2.0, ~85k stars, v4.7.0, pushed 2026-10-22. It is a design skill for AI harnesses with 23 commands and a standalone Rust anti-pattern detector (`crates/detect`, `crates/core/src/checks/rules.rs`). Read: `SKILL.md`, `reference/new-work.md`, `reference/craft-floor.md`, `reference/routing.md`.

| Concept | Take for CubiQ |
| --- | --- |
| **Modes by surface, not by product** (`SKILL.md` "Modes"): **Persuade** (landing, pricing), **Operate** (app UI, dashboards, settings), **Read** (docs, articles), **Experience** (portfolio, gallery). Ambition scales with the mode. Persuade and Experience get bold, committed work. Operate and Read show craft through precision and restraint. | **Adopt as the main axis** of the auto chip. It replaces Quick/Working/Real app as the thing that shapes the design. Tier becomes effort, inferred from wording ("quick sketch" → Quick, "production"/"handoff" → Real app). Default: Working. |
| **Refinement preserves; redesign replaces.** An established world in code is inherited even without a DESIGN.md. A local addition never becomes a new identity exercise. | **Adopt** in the design guide. It stops follow-up turns from restyling the whole page. |
| **Break the "category rut"** (`new-work.md` §3): name the page this category always ships and its predictable opposite. List 7 candidate worlds from the audience's own culture (its objects, publications, notation, interfaces). Then a seeded random roll (`concept-seed`) picks which ones reach the user, so the top-ranked default doesn't always win. | **Adopt a light version.** On a new world, the agent writes 3 directions and a seeded roll orders them. Build the lead as `index.html`; the others become one-paragraph notes, or `variant-b.html` / `variant-c.html` on the Real app tier (variants already exist in `DESIGN-MODE.md`). |
| **Colour strategy before colours**: Restrained, Committed (one colour on 30–60% of the surface), Full palette, or Drenched. Pick light or dark from the use scene, not the category. | **Adopt** as one line in the direction note. |
| **Calibration and refuse list** (`craft-floor.md`): eyebrow/kicker labels above headings, gradient text, coloured `border-left` over 1px, hard offset shadows outside neobrutalism, same-size icon+heading+text card grids, the hero-metric template, decorative 01/02/03 numbers, mono as a "technical" costume, emoji as icons, and a list of overused fonts. Also an "un-themed browser surfaces" check (selection, caret, scrollbars, focus ring). | **Adopt as deterministic `design_lint` rules** (new rule `slop`). Machine-checkable items go in code; judgement items stay as one short prompt list. |
| **Detector hook after UI edits** (`reference/hooks.md`) | **Adopt:** run `design_lint` (with the slop rule) automatically after each design-folder write burst. Findings go into the next turn, so the agent doesn't need to remember to run it. |
| **PRODUCT.md vs DESIGN.md**: product truth separate from visual decisions. A small surface brief holds the direction contract (~150 words). | **Adopt as `.direction.md`** in the design folder: thesis, world, colour strategy, type, signature moment, what it refuses. It is never shipped in the HTML. |
| The rest of the ritual: decision-page server, comp image generation, `build-phase` state machine, 23 commands, mandatory `npx` launcher. | **Don't take.** Too many tokens and round trips. Their own docs call the comp-led path "frontier-tier only". It would also be a second design harness inside ours (section 1 objective). |

### 12.5 Other sources checked

- **Anthropic `frontend-design` skill** ([anthropics/skills](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design/SKILL.md) @ `dbd4588`):
  - Two passes. First write a compact plan: 4–6 named hex values, type roles, an ASCII layout and principles. Then review it against the brief ("would a similar prompt land here too?"), revise the generic parts, and only then build.
  - Lists the 5 looks AI design clusters around: cream + serif + terracotta; near-black + one acid accent; broadsheet hairlines; the SaaS card kit; template chrome such as eyebrows, `A · B` meta and `→` on links.
  - "Spend your boldness in one place."
  - "Jot down notes about what you've tried": this matches the history in 12.3.
  - **Adopt** the plan → review → build loop inside `design-prototype`. It is cheaper than Impeccable's ritual.
- **awesome-design-md** ([voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md) @ `3b60532`, MIT, ~123k stars): 84 DESIGN.md files inspired by real sites (Linear, Stripe, Apple, Vercel, Airbnb…), in the Google Stitch DESIGN.md format, which our systems already use. Each is about **24 KB (~6k tokens)**, too large to inject. The README says they are not official brand systems.
  - **Use as research input only:** distill principles into our own short, unbranded notes.
  - Don't ship brand-named clones. They risk trademark and impersonation problems, and copying a brand is not what the user wants.
- **Mobbin MCP** (official, OAuth, paid plan, launched May 2026; searches screens, flows and sections) and **Refero Styles** (turns a live site's visual language into a markdown spec): the best "real-world reference" sources found.
  - **Optional connector later:** off by default, discoverable rather than always-loaded (section 3.3), used during planning to extract principles, never to clone screens.
  - Sources: [mobbin.com/blog/mobbin-vs-refero](https://mobbin.com/blog/mobbin-vs-refero), [developertoolkit.ai Mobbin MCP](https://developertoolkit.ai/en/shared-workflows/mcp-ecosystem/mobbin-mcp/). These are vendor and creator pages, and their figures are self-reported.
- **We already have** `design-system-extract` for "make it like this site or codebase", and reference images (`refs/ref-1.png`). Keep both; this is the explicit "copy this vibe" path.

### 12.6 The inspiration library ("inspo notes")

Replace the 5 bundled themes as the *default* path with a tagged **style library**. Keep `resources/design-systems/` for explicit, durable systems.

```text
resources/design-styles/<id>/STYLE.md
---
name: riso-print
tags: [editorial, playful, print, warm, landing-page]
modes: [persuade, experience]
platform: web            # web | mobile | deck | any
---
Thesis (1 line) · Colour strategy + 4–6 named hex · Type roles (system stack or bundled face)
Layout moves (3 bullets) · Signature moment (1) · Refuses (3) · Notes on motion
```

- **Size budget:** each note ≤ ~1.2k tokens. The selector sees only a one-line index (`id: tags`), about 20 tokens per style. Only the chosen note is injected, once, on the first turn and after a switch (same once-only pattern as `prepareDesignTier`, `service.ts:1487-1506`).
- **Content:** start with 20–30 notes, written in English by us and spread across modes and moods: editorial, Swiss, brutalist, soft pastel, retro terminal, luxury, data-dense, playful, print/riso, glass (only where justified), dark and light. They are inspired by patterns seen in OpenPencil's guides, awesome-design-md and the best public sites. They are distilled, carry no brand names and copy no text.
- **Anti-repeat:** a per-project `design-history.json` keeps the last N `{style, headingFont, palette}`. The selector must avoid the most recent one unless the brief pins it.
- **Fonts:** the canvas is offline, so "distinctive type" needs a small **bundled OFL font pack** that gets copied into the design folder, the same way `system/` is synced today. This needs a decision (size, licences, Windows parity [[two-machines]]). Without it, half of the anti-template advice can't be carried out.
- **Project first:** if the project has its own system (`project` in `systems.ts`), it still wins. The library is for open briefs only.

### 12.7 Proposed first-turn flow (no picks)

```text
prompt → classify (in the agent's planning step, not an extra model call)
          surface: component | page | screen | workspace | deck | mobile
          mode:    persuade | operate | read | experience
          tier:    quick | working | real-app   (from wording; default working)
          tags:    3–5 → style id (avoid recent history; brief wins)
       → write .direction.md (≤150 words) → build index.html
       → auto design_lint (+ slop rule) and design_screenshot → fix once
       → reply in 1–2 lines: "Read as Persuade · Riso Print. Try: bolder / quieter / other style"
chip:  Auto · Persuade · Riso Print   (click → override any of the three, or go back to a fixed system)
```

The agent reports what it inferred so the chip can display it: either a tiny structured tool call (`design_set_direction {surface, mode, tier, style}`) or a parse of `.direction.md`. Prefer the tool call because it is validated (section 4).

### 12.8 Bounded slices — approval required per slice

| Slice | Scope | Exit evidence |
| --- | --- | --- |
| **D0 — baseline** | No code. Run 10 fixed prompts (landing, pricing card, mobile login, dashboard, docs page, portfolio, deck, settings, game menu, finance app) on today's defaults. Screenshot each in the dark theme ([[ui-visual-bar]]). Count repeated font/palette/layout looks and permission prompts per design. | Saved screenshots and a table. This is what D1–D3 are judged against. |
| **D1 — zero-pick start** | Add the `auto` value for system and tier (new stored value, migration-safe). Auto-allow writes inside the design folder in all modes except Plan. Merge the three chips into one `Auto · …` chip with override (follow `DESIGN.md`, `design-system` skill). Add `design_set_direction`. Files: `shared/tiers.ts`, `design/systems.ts`, `service.ts` (tier/system prep), `approvals.ts` + driver permission paths, `DesignSettingsMenu.tsx`, `TierMenu.tsx`, `DesignSystemMenu.tsx`, `resources/DESIGN-MODE.md`. | Tests: old threads with explicit picks behave exactly as before; writes outside the design folder still prompt under Ask; Plan stays read-only. Live: create a design with no picks on Claude, Codex and OpenCode, and screenshot the chip. Windows gate. |
| **D2 — style library + selector** | `resources/design-styles/` with 20–30 notes and an index. Selector rules go in `DESIGN-MODE.md` (index only) plus a once-per-switch injection. Per-project anti-repeat history. Decide on the font pack. | First-request size grows by ≤ ~1k tokens (index), measured with section 3.1's breakdown. D0 prompts now land on at least 6 distinct styles; no style repeats twice in a row. |
| **D3 — direction step + slop lint** | Update `design-prototype` with the plan → rut check → build loop (Anthropic skill + a light Impeccable roll) and the mode rules. Add a `slop` rule to `lint.ts`: eyebrow above heading, gradient text, `border-left` > 1px on cards, zero-blur offset shadows, ≥3 identical sibling cards, emoji as icons, overused display fonts, un-themed `::selection` / scrollbars. Auto-run lint after write bursts. | Unit fixtures for each slop rule (positive and negative). D0 prompts: slop findings per page go down compared with the baseline, with no new contrast/target failures. |
| **D4 — optional reference connectors** | Mobbin/Refero as optional MCP, off by default, discoverable only. Planning step only. | Not loaded for unrelated tasks (schema-size check). Works when enabled; no clone of reference text or images. |

### 12.9 Decisions (answered 2026-10-22)

The user wants design mode to "work like OpenPencil, it looks nice", and chose:

- **Scope:** look + flow. Keep the HTML canvas; adopt OpenPencil's canvas layout, auto style and styled variant boards. No vector editor.
- **Variants:** one board per prompt, plus a "More styles" button for 2–3 more.
- **Inspiration:** our own unbranded notes.
- **Fonts:** bundle a small OFL font pack.

Permissions (auto-allow writes in the design folder) and the override behind the Auto chip follow the recommendations in 12.2.

The phased build spec is `.ai/plans/design-mode-openpencil.md` (P0–P5). It replaces slices D0–D4 above and **still needs approval before any code changes**.

## 13. References

### Public primary sources

- **R1 — Effective context engineering for AI agents:** smallest sufficient high-signal context, tool overlap, just-in-time retrieval, and context-management trade-offs. <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- **R2 — Claude Code extension overview:** native-versus-custom feature selection, context costs, scoped rules, skill invocation, hooks, and subagent trade-offs. <https://code.claude.com/docs/en/features-overview>
- **R3 — Claude Code memory and project instructions:** instruction loading, `AGENTS.md`, imports, path-scoped rules, auto-memory scope, and prompt auditing. <https://code.claude.com/docs/en/memory>
- **R4 — Claude Code MCP:** native tool discovery and MCP configuration/behavior; applicability varies by execution surface. <https://code.claude.com/docs/en/mcp>
- **R5 — Code execution with MCP:** selective schema loading, intermediate-result reduction, and code-execution complexity/security costs. Reported example savings are not a prediction for CubiQ. <https://www.anthropic.com/research/code-execution-with-mcp>
- **R6 — Demystifying evals for AI agents:** outcome-based grading, balanced positive/negative cases, real failure-derived tasks, repeated trials, and environment isolation. <https://www.anthropic.com/research/demystifying-evals-for-ai-agents>
- **R7 — Claude Code skills:** progressive disclosure, user-only invocation, bundled workflows, account sync, and portability limitations. <https://code.claude.com/docs/en/skills>
- **R8 — OpenCode Zen/Console model catalog:** model identifiers, free-model availability, pricing, and provider-specific privacy statements. <https://opencode.ai/docs/zen/>
- **R9 — AgentRouter public landing page:** did not provide a usable model inventory in the read-only fetch. <https://agentrouter.org>
- **R10 — MCP tools specification, 2025-11-25:** input/output schemas, structured content, tool identifiers, annotations/trust, and actionable error distinctions. <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- **R11 — MCP cancellation specification, 2025-11-25:** optional cancellation, races/late replies, resource cleanup, and separate task cancellation. <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation>

Public documentation is version-dependent. CLI versions and account/provider conditions must be checked again when implementing; documentation describes capabilities, not proof of live activation.

### Peer implementation sources — commit-pinned

- **H1 — T3 Code:** [Codex delivery](https://github.com/pingdotgg/t3code/blob/618761a2d6d615b2c0a07e5de4d82384a583f717/apps/server/src/provider/CodexDeveloperInstructions.ts), [delivery-size tests](https://github.com/pingdotgg/t3code/blob/618761a2d6d615b2c0a07e5de4d82384a583f717/apps/server/src/provider/CodexDeveloperInstructions.test.ts), [orchestration guidance](https://github.com/pingdotgg/t3code/blob/618761a2d6d615b2c0a07e5de4d82384a583f717/packages/provider-core/src/server/orchestrationInstructions.ts), [handoff tests](https://github.com/pingdotgg/t3code/blob/618761a2d6d615b2c0a07e5de4d82384a583f717/apps/server/src/orchestration-v2/ContextHandoffBudget.test.ts).
- **H2 — ZCode:** [exposure](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/search/exposure.ts), [exposure tests](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/tests/tool-search-exposure.test.ts), [context builder](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/context/builder.ts), [instruction/memory section](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts), [Node REPL](https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts).
- **H3 — Orca:** [prompt transport](https://github.com/stablyai/orca/blob/7f21cc91b8f6cda56c24572fdbe9932bde9e8717/src/shared/agent-prompt-injection.ts), [injected-turn classification](https://github.com/stablyai/orca/blob/7f21cc91b8f6cda56c24572fdbe9932bde9e8717/src/shared/harness-injected-user-turns.ts), [instructional-plugin integrity](https://github.com/stablyai/orca/blob/7f21cc91b8f6cda56c24572fdbe9932bde9e8717/src/main/plugins/plugin-instructional-content-integrity.ts).
- **H4 — Reasonix:** [resolver](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/state/instruction/resolver.go), [resolver tests](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/state/instruction/resolver_test.go), [host check declarations](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/state/instruction/instruction.go), [readiness](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/runtime/agent/final_readiness.go), [readiness proof tests](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/runtime/agent/readiness_proof_test.go), [reasoning replay](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/model/openai/reasoning_replay.go), [memory recall](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/state/memory/auto_recall.go), [active-line README](https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/README.md), [stable-line README](https://github.com/esengine/DeepSeek-Reasonix/blob/9ee6ad0a81d27070e142880c219081f4b2ff8d22/README.md).
- **H5 — OpenHuman:** [pack wiring](https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/tools/toolpacks/ops.rs), [routing](https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/agent/tinyagents/middleware/packed_tool_route.rs), [permission/exposure tests](https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/tools/toolpacks/toolpacks_tests_scoping_and_visibility_tests.rs), [instruction adapter](https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/agent/prompts/agents_md.rs), [instruction boundary tests](https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/agent/prompts/agents_md_tests.rs).
- **H6 — OpenCode:** [instruction admission](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/instructions/index.ts), [admission tests](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/test/instructions/index.test.ts), [catalog](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/codemode/catalog.ts), [catalog tests](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/test/codemode/catalog.test.ts), [catalog updates](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/codemode/instructions.ts), [app Code Mode](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/codemode/tool.ts), [typed execution](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/codemode/src/tool-runtime.ts), [optional runtime limits](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/codemode/src/codemode.ts).
- **H7 — Pi:** [system sections](https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/coding-agent/src/core/system-prompt.ts), [resource loader](https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/coding-agent/src/core/resource-loader.ts), [Code Mode tool](https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/coding-agent/src/extensions/codemode/tool.ts), [host lifecycle](https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/codemode/src/runtime/execution.ts), [worker lifetime tests](https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/codemode/test/worker-lifetime.test.ts).
- **H8 — Gemini CLI:** [JIT entrypoint](https://github.com/google-gemini/gemini-cli/blob/c1740d29301a73a47dc3501c1aecc7eb00c0ee58/packages/core/src/tools/jit-context.ts), [manager](https://github.com/google-gemini/gemini-cli/blob/c1740d29301a73a47dc3501c1aecc7eb00c0ee58/packages/core/src/context/memoryContextManager.ts), [JIT tests](https://github.com/google-gemini/gemini-cli/blob/c1740d29301a73a47dc3501c1aecc7eb00c0ee58/packages/core/src/tools/jit-context.test.ts), [imports](https://github.com/google-gemini/gemini-cli/blob/c1740d29301a73a47dc3501c1aecc7eb00c0ee58/packages/core/src/utils/memoryImportProcessor.ts).
- **H9 — Codex:** [Code Mode service and nested boundary](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/core/src/tools/code_mode/mod.rs), [execute handler](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/core/src/tools/code_mode/execute_handler.rs), [dispatch broker](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/core/src/tools/code_mode/delegate.rs), [global instruction refresh](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/codex-home/src/instructions/mod.rs).
- **H10 — Cloudflare Code Mode:** [executor](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/executor.ts), [executor tests](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/tests/executor.test.ts), [connector search](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/connectors/search.ts), [lazy describe](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/connectors/describe.ts), [approval/replay proxy and model projection](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/proxy-tool.ts).
- **H11 — Aider:** [repository map](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py), [map/freshness tests](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/tests/basic/test_repomap.py).
- **H12 — Cline:** [rule toggle/write path](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts), [toggle and root-boundary tests](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/apps/vscode/src/core/context/instructions/user-instructions/__tests__/cline-rules.test.ts), [separate rendering helpers](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/apps/vscode/src/core/context/instructions/user-instructions/rule-helpers.ts).
- **H12 follow-up — Cline shared SDK:** [instruction parser/discovery](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts), [parser/discovery tests](https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/sdk/packages/core/src/extensions/config/user-instruction-config-loader.test.ts).
- **H13 — Roo Code:** [custom instruction compiler](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/custom-instructions.ts), [global/project merge tests](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/__tests__/custom-instructions-global.spec.ts).
- **Peer schema follow-up:** [OpenCode renderer/decoder](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/codemode/src/tool-schema.ts), [Codex definition preparation](https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/core/src/tools/code_mode/tool_definitions.rs), [Cloudflare JSON Schema renderer](https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/json-schema-types.ts).

### Local code evidence

Paths are relative to this repository. Line ranges refer to the inspected snapshot and may drift.

| Ref | File and inspected lines | Evidence |
| --- | --- | --- |
| C1 | [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 193–266, 342–436, 554–579 | Provider prompt assembly, tool exposure, initial estimates, and app-tool schema conversion/validation. |
| C2 | [`src/main/agents/claude.ts`](src/main/agents/claude.ts), 45–64, 481–520, 579–616 | Native Claude integration, always-loaded tool exceptions, prompt append, and context-usage API. |
| C3 | [`src/main/agents/codex.ts`](src/main/agents/codex.ts), 1322–1344 | Estimated component breakdown and later usage total. |
| C4 | [`src/main/agents/acp/driver.ts`](src/main/agents/acp/driver.ts), 1416–1441 | ACP/OpenCode usage aggregation and estimated context breakdown. |
| C5 | [`src/main/skills/tool.ts`](src/main/skills/tool.ts), 7–10, 33–99 | Skill listing/search thresholds, snapshot behavior, and on-demand loading. |
| C6 | [`src/main/mcp/router.ts`](src/main/mcp/router.ts), 141–174, 210–315 | Router threshold/index, search/call tools, and argument validation. |
| C7 | [`src/main/memory/index.ts`](src/main/memory/index.ts), 5–14; [`src/main/index.ts`](src/main/index.ts), 483–525 | Shared memory instructions, scoped indexes, frozen snapshots, and incremental updates. |
| C8 | [`src/main/learn/lifecycle.ts`](src/main/learn/lifecycle.ts), 6–15, 63–139 | Lesson selection, outcome attribution, retirement, revalidation, and promotion. |
| C9 | [`src/main/index.ts`](src/main/index.ts), 472–473, 584–614 | Stable all-tools array and always-offered app/shell tools. |
| C10 | [`src/main/context-preview.ts`](src/main/context-preview.ts), 4–13, 25–74; [`src/main/harness/context/estimate.ts`](src/main/harness/context/estimate.ts), 1–14 | Internal schema serialization and character-based estimates. |
| C11 | [`src/main/harness/context/system.ts`](src/main/harness/context/system.ts), 25–43 | Native base behavior, including conflicting background-shell instruction. |
| C12 | [`resources/CUBIQ.md`](resources/CUBIQ.md), 5–16 | CubiQ tool guidance, managed-shell requirement, and evidence rules. |
| C13 | [`src/main/harness/subagent.ts`](src/main/harness/subagent.ts), 35–58, 128–170; [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 359–389 | Worker route inheritance, member-model resolution, and fallback behavior. |
| C14 | [`src/main/evidence.ts`](src/main/evidence.ts), 1–4, 51–97 | Advisory evidence flags and check-command heuristic. |
| C15 | [`src/main/harness/tools/code.ts`](src/main/harness/tools/code.ts), 1–44, 153–206; [`src/main/code-mode.ts`](src/main/code-mode.ts), 74–128 | Existing code-mode execution, discovery helpers, and read-only driver variant. |
| C16 | [`src/main/cache-policy.ts`](src/main/cache-policy.ts), 33–97, 106–178 | Tool-set fingerprints, queued changes, miss classification, and cache accounting. |
| C17 | [`src/main/harness/context/binding.ts`](src/main/harness/context/binding.ts), 1–42 | Protocol-specific reasoning replay and prefix-change handling. |
| C18 | [`src/main/mcp-http.ts`](src/main/mcp-http.ts), 34–53 | Existing `required`-array schema compatibility fix. |
| C19 | [`src/shared/learn.ts`](src/shared/learn.ts), 109–143 | Background-learning settings, default ceilings, and accounting metadata. |
| C20 | [`package.json`](package.json), 2–6, 17–34, 37–66 | Product identity, scripts, package manager, and dependency versions. |
| C21 | [`src/main/skills/sources.ts`](src/main/skills/sources.ts), 86–125; [`src/main/skills/discover.ts`](src/main/skills/discover.ts), 26–55, 68–107 | Skill source precedence, native-name exclusion, discovery depth, and frontmatter subset. |
| C22 | [`test/cache-regression.test.ts`](test/cache-regression.test.ts), 35–95 | Existing cache-accounting regression coverage to extend rather than duplicate. |
| C23 | [`src/main/harness/tools/code.ts`](src/main/harness/tools/code.ts), 69–145, 164–168, 243–277, 339–365; [`src/main/harness/tools/code-broker.ts`](src/main/harness/tools/code-broker.ts), 11–94 | Script lifetime, caller signal forwarding, host logs, queue/concurrency, suppression after 40 rows, child execution. |
| C24 | [`src/main/code-mode.ts`](src/main/code-mode.ts), 32–39, 71–134 | Thread-fixed mode; read-effect filtering, request/turn signals, per-thread caches, MCP code-server construction. |
| C25 | [`src/main/harness/tools/paths.ts`](src/main/harness/tools/paths.ts), 16–21; [`src/main/harness/tools/read.ts`](src/main/harness/tools/read.ts), 37–78; [`src/main/harness/tools/bound.ts`](src/main/harness/tools/bound.ts), 8–43 | Outside-path marking versus read enforcement, complete-file load before script-size check/window, ordinary output bounds. |
| C26 | [`src/main/guide.ts`](src/main/guide.ts), 4–29, 53–107; [`src/main/harness/context/files.ts`](src/main/harness/context/files.ts), 9–30; [`src/main/harness/context/system.ts`](src/main/harness/context/system.ts), 25–43, 79–90 | Guide order/caching/parts, root-only instruction loading/cap/deduplication, base prompt and assembly. |
| C27 | [`src/main/harness/tools/ts-decl.ts`](src/main/harness/tools/ts-decl.ts), 9–89; [`test/ts-decl.test.ts`](test/ts-decl.test.ts) | Small declaration renderer and covered schema subset, not a compiler or full JSON Schema interpreter. |
| C28 | [`src/main/harness/tools/bash.ts`](src/main/harness/tools/bash.ts), 142–160; [`src/main/harness/loop.ts`](src/main/harness/loop.ts), 183–208, 224–293; [`src/main/service.ts`](src/main/service.ts), 904–916 | Command exit versus tool error; main-loop scheduling/failure/check heuristics and event-based failure learning. |
| C29 | [`src/main/index.ts`](src/main/index.ts), 918, 1141–1163; [`src/main/service.ts`](src/main/service.ts), 159–167; [`src/main/memory/extractor.ts`](src/main/memory/extractor.ts), 276–315, 346–360 | Static extractor/background driver lookup versus dynamic service registry; extraction prerequisites/fallback. |
| C30 | [`src/main/learn/background.ts`](src/main/learn/background.ts), 33–62; [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 125–137, 178–188 | Explicit model/driver selection and first-model fallback in provider run/one-shot paths. |
| C31 | [`src/main/learn/draft.ts`](src/main/learn/draft.ts), 190–195; [`src/main/mcp/router.ts`](src/main/mcp/router.ts), 274–311 | External-content heuristic misses native router name; router validation and mutation classification. |
| C32 | [`src/main/learn/replay.ts`](src/main/learn/replay.ts), 44–77; [`src/main/learn/lifecycle.ts`](src/main/learn/lifecycle.ts), 110–139 | Replay-cache inputs, verdict reuse, limited runtime revalidation and promotion conditions. |
| C33 | [`src/main/browser/on-demand.ts`](src/main/browser/on-demand.ts), 15–89; [`src/main/index.ts`](src/main/index.ts), 614–626; [`test/browser-on-demand.test.ts`](test/browser-on-demand.test.ts), 71–77 | Existing browser discovery/call pair, thread-fixed opt-in delivery, character-based schema-size test. |
| C34 | [`src/main/service.ts`](src/main/service.ts), 1012–1111, 1188–1195; [`src/main/evidence.ts`](src/main/evidence.ts), 60–96 | Extraction before post-answer checks; check/fix flow, advisory evidence, separate MCP child event emission. |
| C35 | [`src/main/agents/types.ts`](src/main/agents/types.ts), 11–43; [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 545–574 | App result contract, schema conversion fallback, runtime argument validation and text bounding. |
| C36 | [`src/main/agents/acp/driver.ts`](src/main/agents/acp/driver.ts), 139–143, 924, 1280–1288; [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 93–98; [`src/main/code-mode.ts`](src/main/code-mode.ts), 80–82 | OpenCode-major native Code Mode heuristic, process-local state ownership and guidance. |
| C37 | [`src/main/harness/tools/code.ts`](src/main/harness/tools/code.ts), 35–50, 257–281; [`src/main/code-hint.ts`](src/main/code-hint.ts), 1–2; [`src/main/code-mode.ts`](src/main/code-mode.ts), 26–27; [`src/main/browser/on-demand.ts`](src/main/browser/on-demand.ts), 1–5 | Current `5178b93` argument convenience/guidance, object-call documentation, directory result clarification, and browser-on-demand wording. |
| C38 | [`src/main/index.ts`](src/main/index.ts), 614–647; [`src/main/harness/tools/grep.ts`](src/main/harness/tools/grep.ts), 199–240; [`test/code-tool.test.ts`](test/code-tool.test.ts), 34–158 | Always-on non-native-search browser deferral with design exception, separate code-server tool inventory, undocumented grep alias and current normalization-test gap. |
| C39 | [`src/main/harness/tools/glob.ts`](src/main/harness/tools/glob.ts), 67–89, 112–136; [`src/main/harness/tools/grep.ts`](src/main/harness/tools/grep.ts), 48–114, 159–174; [`src/main/harness/tools/paths.ts`](src/main/harness/tools/paths.ts), 16–21 | Descendant symlink skipping versus explicit-root policy, post-collection match caps, unbounded ripgrep collection, and fast/fallback file-size policy differences. |
| C40 | [`src/main/agents/types.ts`](src/main/agents/types.ts), 36–40; [`src/main/code-mode.ts`](src/main/code-mode.ts), 71–94, 107–127; [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 558–572 | Effect metadata is scheduling, autoAllow is approval policy; MCP Code Mode effect filtering and absent child authorization diverge from the normal app-tool adapter. |
| C41 | [`src/main/mcp-http.ts`](src/main/mcp-http.ts), 83–90, 158–169, 199–260 | Unbounded JSON-body collection, stateless per-request server, HTTP-close signal delivery versus unused MCP handler cancellation signal. |
| C42 | [`test/harness-tools-search.test.ts`](test/harness-tools-search.test.ts), 24–25, 82–122; [`test/mcp-http.test.ts`](test/mcp-http.test.ts), 33–223 | Search coverage forces the fallback; HTTP tests cover discovery/binding/authentication/heartbeats rather than every script lifecycle boundary. |
| C43 | [`src/main/agents/claude.ts`](src/main/agents/claude.ts), 40–67; [`src/main/mcp-http.ts`](src/main/mcp-http.ts), 241–244; [`src/main/agents/types.ts`](src/main/agents/types.ts), 11–40 | Text/image/error result adapters, effect-to-readOnlyHint annotation, separate autoAllow-to-allowedTools mapping. |
| C44 | [`src/renderer/src/commands.ts`](src/renderer/src/commands.ts), 18; [`src/main/code-mode.ts`](src/main/code-mode.ts), 32–39 | `/codemode` command describes new-thread scope; Code Mode exposure fixed per thread on first access. |
| C45 | [`src/main/harness/driver.ts`](src/main/harness/driver.ts), 190–191, 405–431; [`src/main/agents/acp/driver.ts`](src/main/agents/acp/driver.ts), 1274–1302 | Per-turn root instruction reads, incomplete first-request breakdown versus full overhead, and guide pending-state cleared before confirmed ACP delivery. |

[C1]: src/main/harness/driver.ts
[C2]: src/main/agents/claude.ts
[C3]: src/main/agents/codex.ts
[C4]: src/main/agents/acp/driver.ts
[C5]: src/main/skills/tool.ts
[C6]: src/main/mcp/router.ts
[C7]: src/main/memory/index.ts
[C8]: src/main/learn/lifecycle.ts
[C9]: src/main/index.ts
[C10]: src/main/context-preview.ts
[C11]: src/main/harness/context/system.ts
[C12]: resources/CUBIQ.md
[C13]: src/main/harness/subagent.ts
[C14]: src/main/evidence.ts
[C15]: src/main/harness/tools/code.ts
[C16]: src/main/cache-policy.ts
[C17]: src/main/harness/context/binding.ts
[C18]: src/main/mcp-http.ts
[C19]: src/shared/learn.ts
[C20]: package.json
[C21]: src/main/skills/sources.ts
[C22]: test/cache-regression.test.ts
[C23]: src/main/harness/tools/code-broker.ts
[C24]: src/main/code-mode.ts
[C25]: src/main/harness/tools/read.ts
[C26]: src/main/guide.ts
[C27]: src/main/harness/tools/ts-decl.ts
[C28]: src/main/harness/tools/bash.ts
[C29]: src/main/index.ts
[C30]: src/main/learn/background.ts
[C31]: src/main/learn/draft.ts
[C32]: src/main/learn/replay.ts
[C33]: src/main/browser/on-demand.ts
[C34]: src/main/service.ts
[C35]: src/main/agents/types.ts
[C36]: src/main/agents/acp/driver.ts
[C37]: src/main/harness/tools/code.ts
[C38]: src/main/index.ts
[C39]: src/main/harness/tools/glob.ts
[C40]: src/main/agents/types.ts
[C41]: src/main/mcp-http.ts
[C42]: test/harness-tools-search.test.ts
[C43]: src/main/agents/claude.ts
[C44]: src/renderer/src/commands.ts
[C45]: src/main/harness/driver.ts
[H1]: https://github.com/pingdotgg/t3code/blob/618761a2d6d615b2c0a07e5de4d82384a583f717/apps/server/src/provider/CodexDeveloperInstructions.ts
[H2]: https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/core/src/tool/search/exposure.ts
[H3]: https://github.com/stablyai/orca/blob/7f21cc91b8f6cda56c24572fdbe9932bde9e8717/src/main/plugins/plugin-instructional-content-integrity.ts
[H4]: https://github.com/esengine/DeepSeek-Reasonix/blob/35b9f132aecf2154c27407ebf5c4d3cc42ab33b9/internal/state/instruction/resolver.go
[H5]: https://github.com/tinyhumansai/openhuman/blob/cd272109efe7a74781dee15c1ae653b4c56cc28c/crates/openhuman-core/src/tools/toolpacks/ops.rs
[H6]: https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/codemode/tool.ts
[H7]: https://github.com/earendil-works/pi/blob/cedefc53264f521f5a55be61b746a39c6ada8d4e/packages/coding-agent/src/extensions/codemode/tool.ts
[H8]: https://github.com/google-gemini/gemini-cli/blob/c1740d29301a73a47dc3501c1aecc7eb00c0ee58/packages/core/src/context/memoryContextManager.ts
[H9]: https://github.com/openai/codex/blob/af91f6ef2cd66ead278ebe7d5751973eef430aee/codex-rs/core/src/tools/code_mode/mod.rs
[H10]: https://github.com/cloudflare/agents/blob/fc7f59fb00e7ae0045086b094b94a22abc760206/packages/codemode/src/executor.ts
[H11]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py
[H12]: https://github.com/cline/cline/blob/e9dafbb764d0cb9acb4ef93a956ae72c350b3952/apps/vscode/src/core/context/instructions/user-instructions/cline-rules.ts
[H13]: https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/prompts/sections/custom-instructions.ts
[R1]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[R2]: https://code.claude.com/docs/en/features-overview
[R3]: https://code.claude.com/docs/en/memory
[R4]: https://code.claude.com/docs/en/mcp
[R5]: https://www.anthropic.com/research/code-execution-with-mcp
[R6]: https://www.anthropic.com/research/demystifying-evals-for-ai-agents
[R7]: https://code.claude.com/docs/en/skills
[R8]: https://opencode.ai/docs/zen/
[R9]: https://agentrouter.org
[R10]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
[R11]: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
