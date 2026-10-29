# 13. CubiQ Optimization Roadmap

**Performance, agent quality, context, memory, lazy tools, evaluation, browser testing, teams, and automations**

- **Date:** 2026-10-17
- **Status:** Proposed implementation roadmap. The implementation checkboxes below describe future work.
- **Audience:** The project owner, maintainers, and agents implementing individual phases.
- **Basis:** Repository source inspection, the owner's wishlist and follow-up decisions, and the primary references linked below.
- **Primary objective:** Reduce the cost and time required to complete useful tasks successfully while maintaining or improving accuracy.

This document expands the eight-phase proposal into implementation guidance, dependencies, evaluation criteria, and a research reference catalog. It complements [12. Harness Best Practices](12-harness-best-practices.md), [Context Economy](10-context-economy.md), and [Memory, Extensions and Guide](11-memory-extensions-guide.md).

The code observations are a dated source-level baseline. Profiling and new live evaluations are part of the roadmap; performance improvements and current test-pass counts are not claimed here.

## Contents

1. [Direction and decisions](#1-direction-and-decisions)
2. [Success metrics](#2-success-metrics)
3. [Current implementation and concrete opportunities](#3-current-implementation-and-concrete-opportunities)
4. [Research conclusions](#4-research-conclusions)
5. [Architecture and shared contracts](#5-architecture-and-shared-contracts)
6. [Implementation phases](#6-implementation-phases)
7. [Evaluation design and experiment protocol](#7-evaluation-design-and-experiment-protocol)
8. [Delivery order and first implementation package](#8-delivery-order-and-first-implementation-package)
9. [Validation and rollout](#9-validation-and-rollout)
10. [Calibration decisions](#10-calibration-decisions)
11. [References](#11-references)

## 1. Direction and decisions

### 1.1 The owner's wishlist

| Requested area | Intended outcome | Main phases |
| --- | --- | --- |
| 1. App performance | Faster startup and switching; responsive long conversations and design canvases | P1, P2 |
| 2. Effective agent automations | Reliable normal runs plus scheduled, stateful background jobs | P4, P7 |
| 3. Tokens, context, accuracy, and memory | Less repeated work, better recall and corrections, lower total task cost | P1, P4, P8 |
| 4. Automatic skill and MCP use | Relevant capabilities discovered and loaded when needed | P3, P8 |
| 5. Eval framework | Trustworthy comparisons, realistic scenarios, and bounded improvement experiments | P1, P8 |
| 6. Seamless browser use and testing | Visible interactive browsing plus isolated headless verification | P3, P5 |
| 7. Expert team optimization | Useful specialization with measurable coordination overhead | P4, P6, P8 |

### 1.2 Confirmed product decisions

| Decision | Selected direction |
| --- | --- |
| Performance scope | Address startup/switching, long-chat UI lag, agent completion time, and token/accuracy issues |
| Automation scope | Include both the reliability techniques and a scheduled automation feature |
| Automation runtime | Local-first: run while CubiQ is open or in the tray; handle missed work on wake/restart |
| Browser workflow | Visible CubiQ pane for interactive work; isolated headless sessions for background/testing work |
| Background/member models | Configurable cheap defaults, with per-project choices and user-controlled escalation |
| Agent behavior | Flexible, outcome-oriented guidance; avoid unnecessary rituals and forced delegation |

**Development delegation preference:** When a supervising development agent delegates work for this project, the owner requested Zen DeepSeek Flash Free. Confirm the current model identifier before dispatching. Follow the repository's [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md); workers have their own delegation restrictions. A dispatcher that cannot select the requested model should perform the work directly or resolve the model choice with the owner.

**Product model policy:** CubiQ's background jobs and expert members use configurable project defaults. The development-worker preference above is not a global free-only product requirement.

### 1.3 Design principles

1. **Optimize successful completion.** Count retries, failed attempts, subagents, and background calls when measuring cost.
2. **Measure before changing architecture.** Source inspection identifies candidates; profiles and controlled evals establish impact.
3. **Extend existing foundations.** CubiQ already has drivers, a service layer, tool routing, memory, browser tools, and an eval runner.
4. **Keep the common path small.** Expose enough information to discover useful capabilities; retrieve details progressively.
5. **Make compressed information recoverable.** Keep result references, source paths, versions, and unresolved decisions.
6. **Use flexible guidance.** A simple question can receive a direct answer; a small task can stay with the lead; complex work can expand its investigation.
7. **Make operating constraints explicit.** Budgets, user permissions, and ordering on shared mutable resources belong in execution code.
8. **Grade outcomes and evidence.** Use traces to explain inefficiency and mistakes. Require a particular sequence only when the sequence is itself part of the contract.
9. **Version the inputs to an experiment.** Prompts, skills, models, tools, fixtures, graders, and runtime settings all affect the result.
10. **Keep diagnostics local by default.** Reuse the repository's credential redaction and local artifact conventions.

## 2. Success metrics

### 2.1 Primary metrics

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Task success | The requested outcome is verified by an appropriate grader or observable application state | Prevents optimizing for cheap but incomplete answers |
| Cost per success | Total attributable model cost across attempts divided by successful attempts, using a fixed task distribution | Includes the cost of failures and coordination |
| Completion time | Time from starting work to a verified outcome; report agent-active time and user-wait time separately | Captures excessive model round trips, tool waits, and rework |
| Correction/retry rate | Frequency of user corrections, explicit retries, and automatic fix rounds | Measures how much extra work the user needs to supply |
| UI responsiveness | Startup, thread-switch, input, scroll, and render timing distributions | Captures the desktop experience separately from model latency |

For a balanced evaluation suite with the same number of trials per case:

```text
cost_per_success = sum(cost of every attempt) / count(successful attempts)
```

For unequal trial counts, first calculate mean cost and pass rate per case, then average cases with the declared suite weights. This prevents a frequently repeated easy case from dominating the result. A suite with no successes has no finite cost-per-success result.

In production, also report cost per resolved root request, folding its retries and fix rounds into the original request. Include unresolved requests in success-rate reporting and retain their incurred cost; do not count them as resolved outcomes.

### 2.2 Supporting diagnostics

- Model calls, tool calls, repeated calls, and repeated failures.
- Time to first token, provider latency, tool duration, and time spent waiting for permissions or user answers.
- Uncached input, cache-read input, cache-write input, output, and reasoning tokens where reported.
- Initial guide/tool/skill/memory overhead and its change across model calls.
- Expected cache resets versus unexpected prefix changes.
- Tool-discovery recall, unnecessary discovery, and tools loaded but never used.
- Memory retrieval relevance, correction adoption, duplicate notes, and stale-note use.
- Browser assertion success, stale-reference recovery, console/network errors, and evidence completeness.
- Team overhead, duplicated investigation, member failure/escalation, and result reuse.
- Main/renderer CPU, memory growth, long tasks, IPC payload sizes, and background resource use.

### 2.3 Accounting rules

- Each charge has one accounting owner. If an engine reports a parent total that already includes members, reconcile child records instead of adding them twice.
- Include model calls for compaction, extraction, lesson drafting, judging, and retries. Show experiment/evaluator overhead alongside the evaluated agent's cost.
- Preserve `unknown` when an engine does not report usage or prices. A verified free price is zero; missing pricing is not zero.
- Label usage as **reported**, **estimated**, or **unavailable**. Cost comparisons must disclose coverage.
- A cached eval result retains its original measured task cost. Its current execution spend is zero. These are different fields.
- Count a cached trial once. Reusing one output does not create additional independent repetitions.
- Use a versioned price snapshot for comparable experiments. Report provider-side pricing differences separately from harness changes.

Numerical latency targets, acceptable quality tolerance, and the minimum useful cost improvement are set from the P1 baseline. They should be declared before selecting a winning optimization.

## 3. Current implementation and concrete opportunities

These findings identify implementation work and profiling targets. Function names are included because line numbers will move.

| ID | Current observation | Opportunity / implication | Source |
| --- | --- | --- | --- |
| B01 | `ThreadView` maps all conversation segments; several projections scan the event list | Window long histories, isolate live rendering, and maintain incremental projections | [ThreadView.tsx](../../src/renderer/src/components/ThreadView.tsx), [turns.ts](../../src/renderer/src/turns.ts) |
| B02 | `Store.listEvents()` loads and parses the complete history of a thread | Introduce paged renderer reads and targeted service queries | [db.ts](../../src/main/db.ts) |
| B03 | Renderer initialization awaits each project's thread listing in a loop | Reduce startup round trips and prioritize the initial workspace | [store.ts](../../src/renderer/src/store.ts), `init()` |
| B04 | Live deltas are already batched; Board already culls off-screen iframes | Measure and extend these mechanisms instead of implementing duplicate layers | [store.ts](../../src/renderer/src/store.ts), `drainQueue()`; [Board.tsx](../../src/renderer/src/design/Board.tsx) |
| B05 | Design change notifications are thread-wide; Board iframe keys include a shared reload key | Add affected-path/version information and selective invalidation | [watch.ts](../../src/main/design/watch.ts), [Board.tsx](../../src/renderer/src/design/Board.tsx) |
| B06 | The native loop already runs consecutive read calls concurrently, up to eight at a time | Benchmark any additional batching against this existing baseline | [loop.ts](../../src/main/harness/loop.ts), `runCalls()` |
| B07 | The skill tool loads bodies on demand but lists all available skill descriptions in its definition | Add scalable metadata discovery and avoid repeated body injection | [skills/tool.ts](../../src/main/skills/tool.ts), `skillTool()` |
| B08 | MCP has BM25 search, cached listings, and pooled calls; cold search refreshes every enabled server | Improve catalog persistence and targeted cold discovery | [mcp/router.ts](../../src/main/mcp/router.ts), [mcp/servers.ts](../../src/main/mcp/servers.ts) |
| B09 | `appLoopTool()` maps `autoAllow` to read access; browser actions and memory writes can be auto-allowed | Separate permission decisions from concurrency/effect classification | [harness/driver.ts](../../src/main/harness/driver.ts), `appLoopTool()` |
| B10 | Memory indexes are budgeted and recency-ordered; their prompt blocks are frozen per session | Add relevance and correction freshness while retaining cache discipline | [memory/store.ts](../../src/main/memory/store.ts), [memory/snapshot.ts](../../src/main/memory/snapshot.ts) |
| B11 | Extraction reads the project index, can write user notes globally, and can fall back to the thread's model | Make extraction scope-aware and apply the shared background model/budget policy | [memory/extractor.ts](../../src/main/memory/extractor.ts), `run()` and `applyOps()` |
| B12 | Native sessions use synchronous JSONL reads/writes; large native tool output is already saved for paging | Profile persistence and extend recoverable-result handling | [harness/session.ts](../../src/main/harness/session.ts), [tools/bound.ts](../../src/main/harness/tools/bound.ts) |
| B13 | Pruning can replace results with a request to rerun the tool; compaction has fixed default budgets | Prefer existing result references and context-size-aware retention | [context/prune.ts](../../src/main/harness/context/prune.ts), [context/compact.ts](../../src/main/harness/context/compact.ts) |
| B14 | `runTrial()` sends a single prompt with empty harness/MCP tool lists; the native eval setup disables memory | Add realistic multi-turn and integrated workflow scenarios | [evals/lib/runner.ts](../../evals/lib/runner.ts), [evals/lib/agents.ts](../../evals/lib/agents.ts) |
| B15 | The eval cache key omits requested repetitions; `findCached()` returns a complete prior task result | A larger trial request can reuse a smaller result; cache individual trials and verify coverage | [evals/lib/store.ts](../../evals/lib/store.ts), [evals/run.ts](../../evals/run.ts) |
| B16 | The saved 25-case full baselines for DeepSeek and Haiku are all-pass | Retain their regression value and add passable harder cases for quality improvement | [evals/baseline.json](../../evals/baseline.json) |
| B17 | Browser tools reject calls until the pane is enabled; `BrowserController.page()` already supports requesting an opening | Connect automatic opening to a reliable, session-owned browser workflow | [browser/tools.ts](../../src/main/browser/tools.ts), [browser/controller.ts](../../src/main/browser/controller.ts) |
| B18 | Expert-private skill indexes and team channels exist; member definitions have no model selection field; native members get read/search plus team tools | Add supported member model/tool policies and richer result/cost visibility | [shared/experts.ts](../../src/shared/experts.ts), [experts/team.ts](../../src/main/experts/team.ts), [harness/subagent.ts](../../src/main/harness/subagent.ts) |
| B19 | The learner scores turns, captures cases, and drafts candidate lessons; replay/promotion/lifecycle are unfinished | Complete the learning loop after trustworthy evaluation and accounting exist | [learn/index.ts](../../src/main/learn/index.ts), [shared/learn.ts](../../src/shared/learn.ts) |

The main integration points are [Service](../../src/main/service.ts), [AgentDriver / TurnInput](../../src/main/agents/types.ts), [main startup wiring](../../src/main/index.ts), and the [main-renderer contract](../../src/shared/types.ts).

## 4. Research conclusions

### 4.1 Effective automations

The Anthropic automation article [R01] supplies a useful reliability model:

- Read each source from a bookmark rather than a fixed lookback window.
- Distinguish an unavailable source from an available source with no changes.
- Recheck time-sensitive claims before delivering a result.
- Confirm delivery before advancing the associated ledger/cursors.
- Read current preferences at the start of a run.
- Keep durable operational state and explicit per-run budgets.

CubiQ can implement these patterns locally. The first destinations can be a saved artifact and the Message Center; connector destinations can use explicit delivery adapters.

### 4.2 Reason Agent and a smaller tool interface

Reason Agent 1.1 describes minimal always-present tools, deferred capabilities, programmatic execution, and cache-eligible prefixes [R03]. Its public repository contains documentation and benchmark data; the product runtime is closed-source [R04].

#### What Reason reports

On three Coding Agent Index benchmarks (303 tasks, three attempts each, GPT-6 Astra at `xhigh`), Reason reports [R03]:

| Measure | Reason 1.1 | Codex | Pi |
| --- | --- | --- | --- |
| Index score | 65.1 | 62.5 | 61.4 |
| Input tokens per attempt | 1.92M | 2.48M | — |
| Cost per solved task | baseline | +22% | +10% |

It also reports 15% fewer output tokens than Codex, 15–23% lower cost per attempt on each benchmark, and a 34% lower median cost per task on GPT-6.1 Sol. These are self-reported results. Some comparison figures come from Artificial Analysis or public Harbor jobs rather than identical runs. Refused attempts and judge failures count as zero.

#### How it achieves this

Reason 1.1 is built on the open-source Pi harness [R03], [R19]. The article names the mechanisms; Pi's public documentation shows how they work:

1. **One code tool replaces many model turns.** A `codemode` tool accepts JavaScript that runs as the body of an async function in a QuickJS sandbox [R20]. The script calls `tools.<name>({...})`, can run calls with `Promise.all`, and filters or aggregates results before returning. Only the script's output reaches the model. Reason's example is "a search, five file reads and a test run can take one model call" [R03]. Each avoided model turn saves a full re-read of the cached prefix and the turn's output tokens. This is the most likely main source of the 23% input-token reduction.
2. **A small, fixed front door.** The model sees a short prompt and a few general coding tools [R03]. Pi's design omits built-in plan mode, to-dos, permission popups, and subagents from the core [R19]. Reason exposes its platform features (sessions, subagents, cloud computers, preview URLs, pull requests) as deferred tools that the code tool finds on demand.
3. **Tiered tool exposure.** Pi tools declare an `exposure` [R21]:

   | Mode | Declared to the model | Callable from code | Found by |
   | --- | --- | --- | --- |
   | `direct` | Yes | Yes | Always present |
   | `codemode` | No | Yes | The code tool's listing and search |
   | `deferred` | No | After activation | `tool_search` |
   | `model-only` | Yes | No | Facade/orchestrator tools |
   | `hidden` | No | No | Withdrawn |

   Inside a script, `searchTools(query)` ranks tools with BM25 (default limit 8), and `describeTool(name)` returns a TypeScript declaration. Inline declarations listed in the code tool's description share a budget of about 3,000 tokens [R20]. With `codemode.mode = only`, all other tools are hidden and the model must work through scripts.
4. **An append-only prefix.** The prompt and tools stay unchanged between turns, and each request only appends to the previous one, so every turn is cache-eligible up to its new content [R03]. Pi writes later prompt or tool changes as transcript messages instead of rewriting the system block, so discovering a tool does not invalidate the cache [R21]. Reason cites a model in which raising the cache hit rate from 95% to 98% cut the bill by about 17%. Cached input is most of the cost of agent workloads.
5. **Script state without context.** `store`/`load` keep JSON between scripts and commit only when a script succeeds. A failed script keeps its partial output, and real tool calls made before the failure are not rolled back [R20].

Reason states that it "has not yet tested how much of the saving each accounts for." The attribution above is an inference from the mechanisms, not a measured breakdown.

#### Implications for CubiQ

| Reason/Pi mechanism | CubiQ today | Roadmap action |
| --- | --- | --- |
| Code tool with brokered `tools.*` | No sandboxed script tool; the native loop runs up to eight consecutive reads concurrently (B06) | P3 item 7 pilot. Use QuickJS-style isolation with no Node, file system, or network access. Every `tools.*` call must go through the normal broker, permission check, and accounting (section 5.3) |
| Tiered exposure and in-script search | MCP has BM25 search and per-driver deferral; skill descriptions are listed in full (B07, B08) | P3 items 1–2. Add an exposure field to tool and skill metadata. Expose search and describe calls inside the script tool |
| Append-only capability changes | Memory blocks are frozen per session; cache policy exists (B10) | P3 item 2 and P4 item 5. Deliver discovered schemas and configuration changes as appended messages, and measure unexpected prefix changes (section 2.2) |
| Minimal core prompt | Effective prompt not yet audited per engine | P4 item 1. Remove duplicated or ritualistic guidance one change at a time |

Apply these to the native loop first, where CubiQ controls the prompt, tools, and loop. Claude, Codex, and OpenCode support only what their own configuration exposes (section 5.1).

The experiment compares the code tool against existing parallel reads on the P1 coding and Skills/MCP suites. Measure cost per success, model turns per task, input tokens per attempt, and cache-read share. Then test minimal-tool and deferral changes separately so each one's contribution is attributed. Reason did not measure that split.

Reason's benchmark gains motivate this experiment; they do not predict CubiQ's results. Its methodology also discusses historical trace and accounting limitations [R05], which is another reason to record complete cost coverage.

### 4.3 Lazy tools and context

Anthropic's tool-use and context guidance [R06], [R07] supports:

- Progressive discovery of tool schemas and skill instructions.
- Small, clear tool descriptions with minimal overlap.
- Filtering and aggregation before bulk results enter context.
- Stable reusable prefixes and recoverable references.
- Instructions that are specific enough to help but leave room for judgment.

Discovery adds a round trip. A compact, frequently used tool set may be cheaper to expose directly. Select a measured session profile instead of assuming maximum deferral is always optimal.

### 4.4 Eval design across major providers

| Reference | Useful practice | CubiQ application |
| --- | --- | --- |
| Anthropic eval design/hillclimbing [R02] | Representative tasks, grader validation, passable headroom, one attributable change per round, held-out checks | Define scoped experiments and calibrate noise before accepting gains |
| Anthropic agent evals [R08] | Outcomes, multiple trials, transcript inspection, balanced should-fire/should-not-fire cases | Expand beyond single-turn microtasks and grade actual results |
| OpenAI eval practices and trace grading [R09], [R10] | Task-specific tests, tool argument/handoff evaluation, calibrated judges, trace diagnosis | Record where a failure occurred and whether the result satisfied the task |
| Google ADK evaluation/optimization [R11], [R12] | Multi-turn scenarios, efficiency metrics, separate sampler and optimizer | Keep case execution/scoring independent from candidate generation |
| Microsoft Foundry evaluators/observability [R13], [R14] | Tool selection, inputs, execution success, output utilization, completion, operational traces | Diagnose each layer rather than treating any successful call as success |

Google documents both exact-trajectory and rubric-based evaluation. CubiQ should use outcome/rubric approaches for open-ended coding and research, reserving exact sequence assertions for genuine protocol or ordering requirements.

Build these methods into the existing local, provider-neutral runner. Provider-specific eval services can be optional integrations. At the research date, OpenAI's eval guide [R09] also carried a hosted Evals platform retirement notice; validate service availability before adopting a hosted dependency.

### 4.5 Desktop and browser performance

Electron's guidance emphasizes profiling, deferred initialization, and avoiding expensive work on the main and renderer threads [R15]. Agent-browser supplies compact snapshots, isolated sessions, and structural/visual diffs [R16], [R17], [R18].

Browser isolation requires care: sessions launching their own browser instances are isolated; sessions attached to the same Chrome through CDP share browser state beyond their tab selection [R17]. CubiQ's headless test jobs should use appropriately isolated instances or contexts.

## 5. Architecture and shared contracts

### 5.1 Execution paths

```text
Interactive thread       Scheduled run       Integrated eval scenario
        |                       |                       |
        +--------------- shared run setup -------------+
                                |
                      Service / AgentDriver
                                |
           +--------------------+--------------------+
           |                    |                    |
       Native loop         Claude SDK          Codex / ACP
           |                    |                    |
           +--------- CubiQ-provided capabilities ---+
                     skills, MCP, browser,
                     memory, results, teams
                                |
                    run events and accounting
```

The diagram is a target integration model. Extract shared setup in small steps from `index.ts` so the integrated evaluator exercises the same capabilities as the app. Preserve narrow driver-only evals for protocol and model behavior tests.

The native loop is fully controlled by CubiQ. Claude, Codex, and OpenCode expose their own supported configuration and hooks. Record capability and trace-fidelity differences explicitly; identical UI does not imply identical control over every engine's internal prompt or loop.

### 5.2 Run manifest and accounting

Introduce a versioned run manifest containing:

- Root request/run ID, thread/project ID, origin, and parent/member relationships.
- Requested and resolved agent/model, effort, permission mode, and context settings.
- Guide, skill catalog, tool catalog, memory, and expert/team configuration versions.
- Budget profile, price snapshot, app/driver versions, and outcome status.
- Timing spans and usage coverage, including hidden/background work.

Store references to credentials rather than credential values. Reuse existing redaction when persisting events and diagnostic artifacts.

A background completion API should return text plus usage/finish metadata where supported. The current string-only `oneShot` shape makes accurate background accounting difficult; migrate callers deliberately and retain an explicitly estimated path where the driver cannot report usage.

### 5.3 Permission and tool effects

Represent these independently:

| Concern | Example |
| --- | --- |
| Permission decision | Allowed automatically, requires the current user decision, or denied |
| Effect | Reads source, edits files, navigates a browser, writes memory, publishes a result |
| Resource identity | Project/worktree, browser session/target, memory note, destination |
| Scheduling policy | Parallel, exclusive on a resource, or serial |

Browser navigation can be automatically allowed while still requiring ordered execution on one target. A memory read may update a usage sidecar without requiring the same policy as a project-file edit. A generic MCP annotation is a hint to validate, not a replacement for the broker's policy.

Programmatic execution must route each underlying call through the same authorization, cancellation, effect tracking, and accounting path. Its execution environment should expose the tool broker explicitly and avoid exposing unrestricted main-process objects.

### 5.4 Recoverable result references

Generalize the existing bounded-output files into scoped result records:

- Stable ID, owner/run scope, tool/source identity, content hash/version, MIME type, and size.
- Small preview or structured summary.
- A way to read ranges, search, or request selected fields.
- Full backing content with a retention policy and an explicit expired/unavailable response.

The model receives a short result and a retrieval route. Compaction can retain that route. Reuse a prior result only when its source/version is still valid; a cached observation of changing application state must not masquerade as a fresh check.

### 5.5 Background policy

One shared policy should govern memory extraction, lesson work, eligible import/translation work, eval optimization, and scheduled jobs:

- Global defaults with per-project overrides.
- Purpose-specific model/effort choices where useful.
- Capability validation: tool use, vision, supported member models, and runnable credentials.
- Per-run and daily budgets, shared accounting, and configured escalation rules.
- Foreground priority and bounded background concurrency.
- Explicit queued, running, waiting, paused, cancelled, and completed states.

Name hints such as `flash` or `mini` can help suggest a default, but actual availability, measured quality/latency, and known pricing should guide selection.

## 6. Implementation phases

### P1. Measurement and eval integrity

**Objective:** Establish trustworthy measurements before optimizing behavior. Addresses B14-B16 and supplies every later phase's comparison baseline.

#### Changes

1. **Repair trial caching.** Cache individual attempts. A request for three trials with one valid cached trial runs two additional trials. Include task/fixture/hidden-grader hashes, runtime and policy versions, model/provider/protocol, effort, relevant context settings, and grader version in the experiment identity.
2. **Separate measured cost from execution spend.** Preserve original attempt metrics on cached records. Recompute aggregate reports from equivalent cases and trial counts.
3. **Add structured spans and outcomes.** Distinguish model calls, tools, child runs, compaction, and background completions. Preserve technical failures, budget stops, cancellations, and incomplete grading as explicit statuses.
4. **Retain inspectable traces.** Store available inputs, tool definitions, calls/results, outputs, and configuration manifests in local artifacts. Record fidelity limitations for SDK/CLI engines. Preserve provider-returned reasoning summaries or opaque metadata as available; do not invent inaccessible reasoning.
5. **Add integrated scenarios.** Run multi-turn cases through shared service/capability setup, with fixture memory, mock MCP servers, browser fixtures, expert definitions, and scripted user responses where needed.
6. **Expand the case set.** Keep the saved 25 cases as a regression foundation. Add an initial 20-40 representative, passable cases with clear reasons for difficulty; refine that number from measured variance and run cost.
7. **Create a local report.** Show per-case outcome, cost, latency, repetitions, coverage, and trace links; compare candidate and baseline on the same task distribution.

**Primary scope:** `evals/lib/{runner,store,types,agents}.ts`, `evals/run.ts`, `src/main/agents/types.ts`, `src/main/service.ts`, and shared usage/events.

#### Acceptance criteria

- [ ] Increasing requested repetitions cannot silently return fewer completed trials.
- [ ] An effort, grader, policy, or relevant runtime change invalidates the affected cached result.
- [ ] Cached and fresh attempts produce comparable task-cost reports, with current execution spend shown separately.
- [ ] Missing cost is visibly unknown; parent/member totals reconcile without duplication.
- [ ] Infrastructure failures and incomplete runs cannot become a passing quality result through missing checks.
- [ ] A multi-turn fixture exercises memory, one MCP-backed task, one browser task, and one team task through app-equivalent wiring.
- [ ] Known-good reference solutions pass and no-op/broken solutions fail the relevant outcome graders.
- [ ] A reproducible startup/long-thread baseline is available for P2.

### P2. App responsiveness and resource use

**Objective:** Improve the desktop experience as projects, threads, and artifacts grow. Addresses B01-B05 and B12.

#### Changes

1. **Page renderer history.** Add cursor/sequence-based event queries, initially loading recent complete turns. Fetch earlier pages and search targets on demand. Merge fetched events with live events by sequence so hydration cannot overwrite a concurrent update.
2. **Window the transcript.** Render a bounded set of visible turns/segments with stable keys and measured heights. Preserve scroll anchors, expansion state, selection/copy behavior, and full-history search navigation.
3. **Incremental projections.** Maintain tool-result lookup, parent/child relationships, turn boundaries, and final-check replacement indexes as events arrive. Use stable row inputs so a live token does not rerender completed content.
4. **Prioritize startup.** Batch or concurrently load lightweight thread summaries; prioritize the selected/recent workspace; defer heavy panels, import code, and nonessential catalogs.
5. **Bound renderer caches.** Evict inactive history pages and large decoded artifacts while retaining durable data and recoverable UI state. Keep running threads and pending user requests available.
6. **Profile main-process work.** Target expensive synchronous JSON parsing, filesystem operations, and repeated full-history service queries. Use narrower queries, cached statements, asynchronous work, or a worker where measurements justify it.
7. **Selective canvas reload.** Carry changed paths/version information through the watcher. Reload consumers of a changed shared asset, and only the affected page for an isolated page change. Fall back to whole-design invalidation when the filesystem cannot identify the path.
8. **Low-zoom Board rendering.** Evaluate cached thumbnails for many small artboards. Retain live frames where interaction/detail is useful and bound thumbnail/version storage.

**Primary scope:** `src/main/db.ts`, `src/main/service.ts`, `src/main/harness/session.ts`, `src/renderer/src/{store,turns,live}.ts`, `components/ThreadView.tsx`, `design/Board.tsx`, and `src/main/design/watch.ts`.

#### Profiling fixtures

- Small conversation; 10,000-event conversation; 50,000-event conversation.
- Many projects/threads, including archived and running threads.
- Long streaming text/tool output while typing and scrolling.
- A multi-page Board at fitted and detailed zoom levels.
- Browser, terminal, and background jobs active together.

#### Acceptance criteria

- [ ] Rendered transcript work is bounded by the visible window rather than total history length.
- [ ] Loading older history and jumping to a search result preserve correct ordering and scroll position.
- [ ] Live events, plan/permission cards, subagent rows, and stop/queue behavior remain correct during paging.
- [ ] Repeatedly switching threads reaches a bounded memory plateau under the fixture workload.
- [ ] A one-page edit avoids unnecessary reloads of unrelated artboards.
- [ ] Cold and warm timing distributions improve against the same baseline on the tested OSes.

### P3. Lazy capability discovery and efficient execution

**Objective:** Reduce upfront context and intermediate-output overhead while improving relevant automatic tool use. Addresses B06-B09.

#### Changes

1. **Scalable discovery.** Add a small capability index and metadata search for larger skill/tool catalogs. Load selected skill bodies and schemas on demand. Support broader search when the initial matches are insufficient.
2. **Session-stable definitions.** Pin the discovery interface and relevant configuration version for a session. Return discovered details as results. Apply explicit configuration changes at supported boundaries and check current permissions on invocation.
3. **Cold MCP discovery.** Persist useful non-secret catalog metadata, refresh likely relevant servers first, and reuse existing TTL/in-flight/pool mechanisms. Surface unavailable listings distinctly from no matches.
4. **Retrieval quality.** Improve names/descriptions and ranking using should-trigger, should-not-trigger, ambiguous, and typo/synonym cases. Keep the agent able to discover additional capabilities rather than hard-gating on prompt keywords.
5. **Bounded results.** Extend paging/filtering/field selection and result references to shared MCP and browser outputs where useful.
6. **Effect-aware concurrency.** Implement the separation in section 5.3 before expanding batching. Independent reads can overlap; shared-browser actions and conflicting writes require appropriate ordering.
7. **Native programmatic-execution pilot.** Let a tool program invoke brokered tools, combine dependent calls, and reduce large results before returning to the model. Use a bounded execution environment with cancellation and per-call trace visibility. Pi's code tool is a concrete reference design (section 4.2, [R20], [R21]). It uses a QuickJS sandbox with no host APIs, `tools.*` methods, in-script `searchTools`/`describeTool`, an output-token cap, and an optional timeout. Undo is not provided: a failed script's earlier real calls stand. Since CubiQ has effectful tools, record each call made from a script so the user can see what ran.

**Primary scope:** `src/main/skills/`, `src/main/mcp/`, `src/main/harness/{driver,loop}.ts`, `src/main/agents/types.ts`, and the shared tool server.

#### Acceptance criteria

- [ ] Large catalogs have a smaller measured initial context footprint while discovery recall meets the declared target.
- [ ] Simple tasks avoid unnecessary skill/MCP discovery calls in negative-control cases.
- [ ] Disabled/unavailable capabilities produce accurate, actionable results.
- [ ] A warm lookup reuses catalog/connection work; a cold lookup does not unnecessarily block on unrelated servers.
- [ ] Same-target browser mutations execute in the intended order even if their permission policy is automatic.
- [ ] Batched calls retain per-call authorization, cancellation, and accounting.
- [ ] The code-mode pilot demonstrates a useful cost/latency/quality tradeoff against existing parallel function calls before wider adoption.

### P4. Context, memory, and background spending

**Objective:** Reduce repeated work and stale context while retaining the information needed for accurate completion. Addresses B10-B13.

#### Changes

1. **Audit the effective prompt per engine.** Find duplicated guide/skill/memory content and contradictory or ritualistic instructions. Test removals or clearer wording one at a time. Preserve sufficient task guidance and explicit user constraints.
2. **Resolve context budgets consistently.** Account for supported thread/provider/model settings, output reserve, and expected tool-result growth. Use reported usage to calibrate estimates, especially across protocols and languages.
3. **Make retention adaptive.** Tune current fixed pruning/compaction defaults against context size and task type. Preserve exact constraints, unresolved failures, decisions, and hard-to-rebuild details.
4. **Recover old results.** Use stored result references when pruning. A model should retrieve a valid prior result before rerunning an expensive operation. Fresh state checks remain fresh operations.
5. **Respect prefix bindings.** Reuse existing signed-thinking invalidation/repair mechanisms when history changes. Measure the subsequent cache cost and recall impact of each compaction strategy.
6. **Improve memory retrieval.** Start with an indexed, scope-aware lexical/path/recency approach and explicit priority for user corrections. Evaluate semantic reranking only where retrieval errors justify its cost.
7. **Version memory changes.** Keep stable session indexes while delivering relevant corrections/deletions through small once-per-binding updates. A new automation run reads the current preference version.
8. **Unify note identity and scope.** Make extractor lookup/update/deduplication cover project and global notes. Preserve compatibility with the existing Markdown memory format, using sidecar metadata where necessary.
9. **Use the shared background policy.** Batch eligible extraction work, avoid duplicate extraction after explicit memory writes, record actual usage, and honor configured fallback/escalation instead of silently choosing an expensive thread model.

**Primary scope:** `src/main/memory/`, `src/main/harness/context/`, `src/main/harness/driver.ts`, `src/main/cache-policy.ts`, `src/main/learn/background.ts`, settings, and startup wiring.

#### Acceptance criteria

- [ ] Early user constraints and later corrections survive long conversations, compaction, and supported handoffs.
- [ ] Repeating a durable user preference does not create duplicate global notes.
- [ ] Updating a global note resolves the correct scope and is discoverable by subsequent relevant work.
- [ ] Old result references can be retrieved without repeating their original tool call; stale/expired references are identified accurately.
- [ ] Pruning and compaction preserve valid model history and do not replay invalid bound reasoning blocks.
- [ ] Background calls follow the selected model/budget policy and appear in run accounting.
- [ ] Reduced input cost is accompanied by acceptable recall, task success, and correction rate.

### P5. Seamless visible and headless browser testing

**Objective:** Make browser use a reliable part of task execution and verification. Addresses B17 and depends on P3's tool-effect handling.

#### Changes

1. **Automatic opening.** Connect a relevant browser request to the existing pane-opening mechanism, then wait for attachment/readiness before continuing.
2. **Backend contract.** Introduce a browser interface supporting the visible Electron controller and a pinned, tested agent-browser CLI adapter. Normalize target/session IDs, errors, snapshots, actions, assertions, and artifact references.
3. **Session ownership.** Bind interactive work to the correct visible target; give headless jobs isolated sessions. Serialize mutations per target and retain the visible pane's user-takeover behavior.
4. **Readiness and recovery.** Prefer explicit URL/selector/state conditions over fixed sleeps or unconditional network-idle waits. Recover from stale references by observing the current page and confirming the intended target.
5. **Compact observations.** Add scoped/interactive snapshots, log deltas, and structural diffs. Request images when visual evidence is useful; retain full evidence through artifact references.
6. **Dev-server lifecycle.** Reuse an existing suitable project server or start an owned process through the normal execution policy. Track readiness and stop only processes owned by the run.
7. **Test reports.** Return assertions, actual outcomes, error/log summaries, and screenshots/diffs with run and target identity. Verify state changes instead of relying on a success-looking screenshot alone.

**Primary scope:** `src/main/browser/`, the tool server and `Service`, `components/BrowserPanel.tsx`, artifact handling, and a new headless adapter. Agent-browser session and diff references: [R17], [R18].

#### Acceptance criteria

- [ ] A browser task can start from a closed pane without a manual tab-opening round trip.
- [ ] User takeover pauses the interactive run's actions until resumed.
- [ ] Concurrent threads/jobs cannot silently act on one another's target.
- [ ] Delayed navigation, dynamic content, stale refs, and failed requests produce recoverable, accurate results.
- [ ] A representative form/navigation workflow passes through both backends.
- [ ] Headless runs clean up owned processes and preserve only the configured state/evidence.
- [ ] Compact observations reduce measured browser-context cost while preserving test reliability.

### P6. Expert team quality and efficiency

**Objective:** Make specialization useful without forcing every request through a full team. Addresses B18.

#### Changes

1. **Supported member models.** Add optional member/default model and effort choices, using each engine's supported role mechanisms. Validate capability/availability and show the effective choice in the UI.
2. **Flexible delegation guidance.** Let the lead answer small requests directly and delegate meaningful specialist work. Use phases only when dependencies require them.
3. **Focused briefs.** State the objective, inputs, expected outcome, evidence, boundaries, and stopping condition. Pass result IDs/files to downstream members instead of repeatedly retelling full results.
4. **Scoped tools and skills.** Retain private skill indexes. Give roles the tools they need through the normal policy. When adding writable tools to native members, route child authorization through the parent policy; the current always-allow child loop is appropriate only for its restricted toolkit.
5. **Resource-aware scheduling.** Run independent investigations concurrently; coordinate conflicting project writes and shared browser use. Track member activity through stable run/member IDs.
6. **Result reuse and visibility.** Add member result navigation, task status, latency, cost, and escalation history to the team UI.
7. **Solo/team experiments.** Compare equivalent outcomes under a single agent, a selected specialist, and a larger team. Measure coordination overhead and duplicated exploration.

**Primary scope:** `src/shared/experts.ts`, `src/main/experts/`, `src/main/harness/subagent.ts`, Claude/Codex/OpenCode integration points, and `components/experts/`.

#### Acceptance criteria

- [ ] A user-summoned team's effective member models are visible and match the supported configured choices.
- [ ] Narrow tasks do not automatically fan out across every member.
- [ ] Members receive relevant private skills and can use their configured tools without bypassing permissions.
- [ ] A dependent member can retrieve the prior result directly, including its evidence and unresolved questions.
- [ ] Member costs reconcile with parent totals, including failures and escalations.
- [ ] The lead produces a verified final outcome after necessary members finish.
- [ ] Team configurations earn their overhead on the chosen workload distribution.

### P7. Reliable local-first automations

**Objective:** Add scheduled work that survives ordinary desktop interruptions and accurately records what happened. Applies the patterns in [R01].

#### Proposed persistent records

| Record | Minimum responsibilities |
| --- | --- |
| Automation definition | Project, task/template, schedule/time zone, enabled state, model/profile, budget, sources, destination, and configuration version |
| Automation run | Unique scheduled-run key, thread/session reference, manifest, lease/status, checkpoints, cost, timings, and result references |
| Source cursor | Per-source bookmark, tie-breaker/source IDs where needed, last confirmed progress, and latest read status |
| Delivery record | Idempotency key, publishing/confirmed/unknown state, destination receipt, and reconciliation information |

#### Execution behavior

1. Compute the next due run from a time-zone-aware schedule and persist its identity.
2. On startup/wake, apply an explicit missed-run policy. Default to coalescing missed intervals into useful current work rather than launching an unbounded backlog.
3. Queue background work behind interactive work and acquire appropriate project/browser resources.
4. Create a fresh agent session for the run, linked to its automation record. Load current preferences and compact durable state.
5. Read each source from its bookmark. Preserve failed-source bookmarks and identify unavailable sources in the result.
6. Recheck time-sensitive claims needed for the delivered output.
7. Persist the delivery intent, publish, then record the actual acknowledgment. Advance associated cursors/ledger entries only according to confirmed processing/delivery semantics.
8. Reconcile an unknown delivery outcome before retrying it. Local unique keys prevent duplicate scheduling; external exactly-once delivery depends on the destination's idempotency/reconciliation support.
9. Save the result and notify through the Message Center. Group automation runs so routine jobs do not overwhelm the normal thread list.

Use explicit statuses such as `queued`, `running`, `waiting-input`, `paused-budget`, `partial`, `succeeded`, `failed`, `cancelled`, and `interrupted`. On restart, reconstruct continuation from durable checkpoints; an in-memory promise or permission callback is not a durable checkpoint.

Tray behavior and wake handling need explicit Electron lifecycle integration. Local-first scheduling runs while the app/background tray process is alive and handles missed intervals after sleep or a full shutdown.

#### Initial templates

- **Repo health:** Run configured checks, summarize changed status, and link relevant output.
- **Browser smoke:** Visit selected local/test routes, execute assertions, and save evidence.
- **Project brief:** Report relevant changes from configured repositories/connectors, with source availability and prior-report deduplication.
- **Eval regression:** Run an approved suite/profile within its configured budget.

**Primary scope:** New `src/main/automations/` modules; `db.ts`, `service.ts`, `index.ts` lifecycle, settings/contracts, and automation/Message Center UI. New module names are proposed, not existing APIs.

#### Acceptance criteria

- [ ] Restarting or waking does not create duplicate scheduled run identities.
- [ ] A failed source is reported as unavailable, not as having no new items.
- [ ] Partial runs retain correct per-source progress.
- [ ] A crash after publishing but before local confirmation triggers reconciliation rather than blind reposting.
- [ ] Time-zone and daylight-saving scenarios have deterministic tests.
- [ ] User-input and budget pauses are visible and resumable.
- [ ] Foreground work remains responsive while background jobs run.
- [ ] Each run has current preferences, a durable outcome, and attributable cost.

### P8. Bounded hillclimbing and verified learning

**Objective:** Improve selected agent behavior continuously using reliable measurements. Completes the existing learner's replay and lifecycle work from B19.

#### Changes

1. **Case authoring.** Convert selected real workflows, bugs, and corrections into candidate eval cases. Add human-authored difficult cases and negative controls. Make the intended outcome and reason for difficulty explicit.
2. **Grader calibration.** Validate executable graders against reference/no-op outputs. Calibrate model judges on labeled examples; use checkable criteria and blinded, order-randomized comparisons where appropriate.
3. **Independent optimization surfaces.** Start with prompts, skill/tool descriptions, retrieval profiles, and model/effort settings. Version each candidate. Treat broader harness-code changes as separately reviewed implementation work.
4. **Controlled search.** Change one attributable surface per experiment. Let the optimizer inspect training failures, choose candidates using validation, and reserve a final holdout for the release decision.
5. **Budget and stopping.** Stop or diagnose when improvements are smaller than measurement noise, quality regresses, rounds stall, or the configured budget is reached. Record unsuccessful experiments too.
6. **Replay lessons.** Reproduce a captured case in an isolated fixture, compare baseline and candidate lesson, then check transfer to other cases. Keep unverified lessons as candidates.
7. **Lesson lifecycle.** Retrieve a small relevant set of active lessons, track helpful/harmful signals, support retirement/undo, and revalidate when important model/runtime conditions change.
8. **Local UI.** Provide case/run/trace comparison and learned-lesson evidence, status, budget, and rollback controls.

**Primary scope:** `evals/`, `src/main/learn/`, shared background execution, versioned optimization profiles, and Library/settings UI.

#### Acceptance criteria

- [ ] The optimizer cannot inspect final-holdout answers or use them to draft changes.
- [ ] Related/paraphrased cases do not leak across the selected dataset splits.
- [ ] Grader instability and ambiguous cases are diagnosed before being treated as agent regressions.
- [ ] Candidate selection uses declared quality/cost/latency criteria and sufficient repetitions.
- [ ] A changed grader/dataset receives a new version and re-evaluates both baseline and candidate.
- [ ] A lesson is promoted only with replay and transfer evidence; retirement and undo are available.
- [ ] A run that exceeds its budget or stalls leaves a complete record and the selected stable configuration available.
- [ ] The final report states uncertainty, coverage, and actual gain rather than treating a noisy score movement as proof.

## 7. Evaluation design and experiment protocol

### 7.1 Suite matrix

| Suite | Example cases | Primary outcome graders | Diagnostic metrics |
| --- | --- | --- | --- |
| Coding | Multi-file change; async bug; diagnosis from a failing check; legitimate test updates | Hidden/reference tests, build/type checks, required behavior and diff constraints | Rework, calls, cost, duration |
| Context | Early constraint recalled after long history; compaction; agent handoff | Required facts/constraints and completed task outcome | Lost facts, rereads, compaction cost |
| Memory | Repeated preference; global correction; stale project fact; irrelevant note | Correct scoped note/state and correct subsequent behavior | Duplicates, retrieval precision/recall, extraction cost |
| Skills/MCP | Large catalog; ambiguous descriptions; tool unavailable; direct-answer negative case | Correct task outcome and required external action when applicable | Discovery calls, loaded-unused tools, input errors |
| Browser | Dynamic form; delayed route; stale ref; failed request; two concurrent jobs | DOM/app/backend state assertions and evidence | Snapshot/image tokens, recovery calls, elapsed time |
| Teams | Same task solo/specialist/team; dependent verification; member failure | Final outcome, evidence, and required dependency completion | Member cost, duplicate work, escalation, critical path |
| Automations | Missed run; expired source auth; partial read; publish ambiguity; wake/DST | Durable state, correct delivery/cursors, deduplication | Recovery time, repeated source work, cost |
| Desktop | Large histories/projects; streaming plus typing; fitted Board | Functional UI contracts and bounded resource behavior | Cold/warm p50/p95, CPU, RAM, long tasks |

A task that permits several valid approaches should accept those approaches. For example, test that the final code behaves correctly rather than requiring an arbitrary order of search/read calls. Ordering checks are appropriate for dependencies such as confirming a delivery before committing its ledger entry.

### 7.2 Dataset construction

1. Start with representative workflows and a small set of manually described successes/failures.
2. Add production-derived cases with appropriate redaction and retention choices.
3. Include harder cases because their difficulty is meaningful to CubiQ's use cases, not only because one current model fails them.
4. Include negative controls: no skill needed, no browser needed, no new memory needed, no team needed.
5. Keep solved capability cases as regressions; introduce new passable headroom as the capability suite saturates.
6. Isolate attempts. Provide fixture state explicitly and keep reference answers/graders outside the candidate's accessible execution environment.

Record the isolation strength. An engine with unrestricted filesystem access requires an appropriate sandbox/container or equivalent boundary for a benchmark whose hidden answers must be inaccessible; merely placing answers in a sibling directory is insufficient.

### 7.3 Splits and independent evidence

- **Training:** The optimizer may inspect these cases and their failures.
- **Validation:** Select candidates and tune the permitted surfaces using these results.
- **Final holdout:** Use for a release decision after candidate selection, without exposing its answers to the optimizer.

Split by task family, source project, or time where appropriate so near-duplicate cases stay together. Repeatedly choosing a winner from a test set makes that set part of validation; a separately reserved final holdout preserves independent evidence.

For very small datasets, start with an explicit development set and sealed holdout, report the limited statistical power, and collect more cases before claiming small improvements.

### 7.4 Graders

Use the least expensive grader that establishes the requested property:

1. Executable tests, schema/state assertions, reference comparisons, and file/diff checks.
2. Trace diagnostics for wrong arguments, missed information, repeat loops, and inefficient coordination.
3. Calibrated model judges for open-ended research, design, or communication quality.
4. Human-labeled samples to validate ambiguous outcomes and judge agreement.

For model judges, prefer specific claims or pairwise comparison over an unexplained overall score. Record judge model/configuration and run the same output through the judge more than once during calibration. A different judge model from the candidate is preferable when feasible, but still requires agreement checks.

Model/effort comparisons are diagnostic. Stronger models or more effort often help, but a non-monotonic result is a reason to investigate the task, grader, configuration, or model behavior rather than an automatic invalidation rule.

### 7.5 Comparison protocol

1. State the hypothesis and the surface being changed.
2. Freeze the task distribution, runtime configuration, grading, and pricing for the comparison.
3. Run baseline and candidate on equivalent isolated scenarios with declared repetition counts.
4. Inspect traces from failures and surprising gains.
5. Report pass@1, consistency across repetitions, cost per success, latency distributions, and coverage. Label pass@k separately: it answers whether any of several attempts succeeds.
6. Use paired case-level comparisons and confidence intervals where the sample supports them. Include failed attempts and disclose infrastructure availability separately.
7. Accept a candidate only when it satisfies the predeclared quality tolerance and the improvement is useful relative to observed noise.
8. Keep the best validated configuration available for rollback and evaluate the selected candidate on the final holdout.

Do not infer cheaper operation from a report containing more cached eval results. Do not infer better quality solely from an increased number of retries.

### 7.6 Local reporting and interoperability

The first report should make it easy to answer:

- Which real tasks improved or regressed?
- Was the change caused by the harness, a different model/effort, a different price, or an environment failure?
- What did the model actually receive, and where did it get stuck?
- Did lower token use cause worse recall or more user corrections?
- Did a team produce enough benefit to justify its coordination cost?
- How much did the experiment itself spend?

Keep the report and underlying JSON/trace artifacts locally inspectable. A later Harbor-compatible adapter/export can support broader public benchmarks [R05] after the local case set and accounting are trustworthy.

## 8. Delivery order and first implementation package

### 8.1 Dependencies

```text
P1 measurement + eval integrity
 |-- P2 desktop performance
 |-- P3 discovery + effect-aware tools
 |-- P4 context + memory + background policy
       |
       +-- P5 browser workflows (also uses P3)
       +-- P6 team optimization (also uses P3)
       +-- P7 automations (uses P3 and P5)

P8 hillclimbing + verified learning
   uses P1's validated evaluator and P4's background policy;
   expands its scenarios as P3/P5/P6/P7 land.
```

| Delivery | Work | Completion evidence |
| --- | --- | --- |
| 1 | P1 accounting/cache fixes and baseline fixtures | Trustworthy repetitions, costs, traces, and desktop profiles |
| 2 | P2 history paging/rendering and prioritized startup | Better measured responsiveness with preserved interaction behavior |
| 3 | P3 lazy discovery and effect classification | Lower catalog overhead and reliable stateful-call ordering |
| 4 | P4 memory/context/background policy | Better recall/correction handling at a measured cost |
| 5 | P5 visible/headless browser integration | Reproducible browser outcomes and evidence |
| 6 | P6 configurable, efficient teams | Supported model choices and quantified solo/team comparisons |
| 7 | P7 local scheduled jobs | Durable, deduplicated, recoverable automation runs |
| 8 | P8 bounded optimization and lesson lifecycle | Reproducible improvements and verified lesson promotion |

P2 profiling can proceed while P1 accounting is being developed. Each implementation slice should still have a narrow scope and its own validation evidence.

### 8.2 Recommended first package

**Slice A — Baseline and metric definitions**

- Add deterministic large-history/project fixtures and a repeatable profiling procedure.
- Define run/attempt identity, timing spans, usage coverage, and cost ownership.
- Capture current cold/warm startup and thread behavior on representative hardware.

**Slice B — Eval trust fixes**

- Correct requested-trial fulfillment and cache identity.
- Separate cached task measurements from fresh execution spend.
- Preserve incomplete/error states and validate accounting with fake providers/member runs.

**Slice C — Long-thread responsiveness**

- Introduce paged event retrieval and incremental renderer projections.
- Window history and isolate the live region.
- Verify search, scrolling, pending requests, subagents, and queue/stop behavior before expanding to other UI work.

This package produces an immediate user-facing improvement while establishing the evidence needed to judge later context, tool, and model-policy changes.

## 9. Validation and rollout

### 9.1 Repository checks

The existing project scripts provide the implementation checks:

```bash
bun run typecheck
bun run test
bun run design:check
bun run build
```

Apply the appropriate checks to each change. Renderer work follows [DESIGN.md](../../DESIGN.md), including tokens, interaction states, accessibility, and the pre-ship checklist. Use meaningful regression tests for changed behavior and boundaries.

Existing eval inspection commands include:

```bash
bun run eval --agent native --tier smoke --dry
bun run eval --trend
```

Live evaluation profiles need an explicit model, task set, and budget. The roadmap's new scenario/profile/optimizer interfaces are proposed features, not currently available CLI flags.

### 9.2 Layered validation

1. **Deterministic tests:** Event ordering, paging, cache identity, accounting, tool effects, memory scope, scheduler state, and delivery reconciliation.
2. **Fake integrations:** Provider streams, MCP discovery/failures, member runs, delayed browser fixtures, and interruption/restart scenarios.
3. **Live targeted scenarios:** Exercise relevant features on Claude, Codex, OpenCode, and the native driver, recording supported capability differences.
4. **Desktop checks:** Profile and visually inspect the relevant workflows on macOS and Windows; use Linux coverage for supported runtime and CI paths.
5. **Controlled eval comparison:** Compare the implementation with its recorded baseline before enabling an optimization profile by default.

### 9.3 Rollout behavior

- Version changes to context, tool discovery, memory selection, and model policy so a run can be attributed to its configuration.
- Introduce expensive or behavior-changing experiments through selectable profiles until their effects are established.
- Retain a stable configuration and preserve user data when disabling an experimental profile.
- Trigger broader/repeated checks when changes, failures, or unresolved concerns justify them; avoid rerunning unrelated expensive live suites without a reason.

### 9.4 Tradeoffs to measure

| Tradeoff | Evaluation question |
| --- | --- |
| Deferral versus extra discovery calls | Does the catalog save more context than discovery costs for this workload? |
| Pruning versus cache reuse | Does the saved context offset a rewritten prefix and any additional rereads? |
| Memory freshness versus prompt stability | Are corrections adopted promptly without rebuilding large prefixes unnecessarily? |
| More members versus coordination overhead | Does specialization improve completion enough to justify extra calls and summaries? |
| Batching versus shared-state ordering | Are independent operations faster while mutable-resource actions remain reliable? |
| Virtualization versus interaction fidelity | Do search, copy, scroll anchoring, and expansion still behave correctly? |
| Background work versus foreground responsiveness | Can jobs make progress without degrading active work? |
| Optimization versus overfitting | Does the selected configuration generalize to independent cases? |

## 10. Calibration decisions

These decisions need measurements or an implementation-specific choice; they do not block creating this roadmap.

| Decision | Proposed starting approach |
| --- | --- |
| Minimum useful cost/latency improvement | Declare after P1's baseline and variance measurements |
| Quality tolerance | Define per suite; keep known core regressions visible and investigate any backslide |
| Background model IDs and caps | Use the owner's configured cheap defaults; validate engine support and availability |
| Judge model | Select within the eval budget and calibrate against labeled outcomes |
| Discovery threshold | Use measured schema/token overhead and task frequency rather than tool count alone |
| Context/lesson budgets | Start from existing bounded mechanisms and tune on recall/cost scenarios |
| Browser version and lifecycle | Pin a tested agent-browser version and define owned-session cleanup/persistence |
| Missed automation runs | Coalesce by default; offer task-appropriate catch-up behavior |
| Initial automation destinations | Local artifacts and Message Center, followed by explicitly configured connectors |
| Trace/result retention | Local, bounded, recoverable storage with existing secret redaction |
| Final holdout size | Choose from task diversity, observed noise, and the gain worth detecting |

## 11. References

All references below were consulted during the 2026-10-17 research pass. Vendor APIs, SDK support, and documentation can change; confirm the current contract when implementing a provider-specific feature. Vendor-reported benchmark numbers are not CubiQ measurements.

### User-supplied references

**R01 — Anthropic: Building effective agent automations**  
Lance Martin and CJ Avilla, 2026-10-08. Primary vendor reference implementation walkthrough.  
<https://claude.dev/blog/building-effective-agent-automations/>  
Used for: bookmarks, source failure visibility, delivery acknowledgment, current preferences, run state, and budgets. Applies primarily to P7 and the reliability aspects of P4.

**R02 — Anthropic: Automating eval design and hillclimbing with Claude**  
Lance Martin, 2026-09-28. Primary vendor workflow and examples.  
<https://claude.dev/blog/automating-eval-design-and-hillclimbing/>  
Used for: representative cases, grader checks, passable headroom, noise-aware comparisons, scoped changes, and overfitting controls. Applies to P1, P8, and section 7.

**R03 — Reason Machines: Introducing Reason Agent 1.1**  
2026-10-10. Vendor explanation and self-reported benchmark results.  
<https://reasonmachines.com/blog/introducing-reason-agent-1-1>  
Used for: minimal tools, deferred capabilities, programmatic batching, prefix stability, and cost-per-solved-task thinking. Applies to P1 and P3. The article does not isolate each mechanism's contribution. Rechecked 2026-10-17 for the benchmark figures and the Pi foundation in section 4.2.

**R04 — Reason Agent public repository**  
Product documentation and published benchmark data. The README states that the Reason product is not open source.  
<https://github.com/reason-machines/reason-agent>  
Used for: establishing what implementation information is publicly available and locating benchmark references.

### Evaluation and optimization references

**R05 — Reason Machines benchmark methodology**  
Methodology version 1.6.2 as inspected. Primary description of the publisher's benchmark process.  
<https://github.com/reason-machines/benchmark/blob/main/docs/METHODOLOGY.md>  
Used for: attempt slots, reference/no-op preflight, task weighting, reproducible manifests, trace fidelity, cost coverage, and subagent accounting. Applies to P1 and section 7. Historical runs have the limitations documented by that methodology.

**R08 — Anthropic: Demystifying evals for AI agents**  
2026-01-09. Primary engineering guidance.  
<https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>  
Used for: outcomes versus transcripts, deterministic/model/human graders, multiple trials, capability versus regression suites, negative controls, and saturation. Applies to P1 and P8.

**R09 — OpenAI: Evaluation best practices**  
Primary developer documentation.  
<https://developers.openai.com/api/docs/guides/evaluation-best-practices>  
Used for: task-specific evaluation, tool arguments and handoffs, calibrated judges, realistic datasets, and continuous evaluation. Its hosted platform availability notice should be checked before choosing a hosted integration.

**R10 — OpenAI: Trace grading**  
Primary developer documentation.  
<https://developers.openai.com/api/docs/guides/trace-grading>  
Used for: trace-level diagnosis and evaluation of agent workflows and groups. Applies to P1, P6, and P8.

**R11 — Google ADK: Why evaluate agents**  
Primary framework documentation.  
<https://google.github.io/adk-docs/evaluate/>  
Used for: multi-turn scenarios, trajectory and response evaluation, efficiency measurements, and trace inspection. Applies to P1 and section 7.

**R12 — Google ADK: Optimize agents**  
Primary framework documentation; describes simple and GEPA-based optimization components.  
<https://google.github.io/adk-docs/optimize/>  
Used for: separating samplers/evaluators from optimizers, selecting on validation data, versioned candidates, and bounded optimization. Applies to P8. Documented optimizers have explicit scope limitations and are not a drop-in optimizer for every CubiQ engine/tool/team.

**R13 — Microsoft Foundry: Built-in evaluators reference**  
Primary product documentation.  
<https://learn.microsoft.com/en-us/azure/foundry/concepts/built-in-evaluators>  
Used for: task completion, tool selection, tool input accuracy, output utilization, and execution success. Applies to P1, P3, P5, P6, and P8.

**R14 — Microsoft Foundry: Observability in generative AI**  
Primary product documentation.  
<https://learn.microsoft.com/en-us/azure/foundry/concepts/observability>  
Used for: connecting evaluation, operational metrics, and tracing across the development lifecycle. Applies to P1 and section 9.

### Context and tool-use references

**R06 — Anthropic: Introducing advanced tool use on the Claude Developer Platform**  
2025-11-24. Primary engineering explanation of tool search, programmatic tool calling, and examples.  
<https://www.anthropic.com/engineering/advanced-tool-use>  
Used for: progressive schema discovery, processing intermediate data in code, compact tool descriptions, and the latency tradeoff of deferral. Applies to P3. Check current API/SDK support rather than copying historical beta flags.

**R19 — Pi: minimal agent harness (Earendil)**  
Primary project site; MIT-licensed. Reason Agent 1.1 is built on Pi.  
<https://pi.dev/>  
Used for: minimal-core philosophy (no built-in plan mode, to-dos, permission popups or subagents), on-demand skills that keep the prompt cache, and an extension model. Applies to P3 and P4. Pi 1.0 release notes: <https://earendil.com/posts/pi-1-0/> (2026-10-01).

**R20 — Pi docs: Codemode**  
Primary documentation, as inspected 2026-10-17.  
<https://pi.dev/docs/latest/codemode>  
Used for: QuickJS sandbox limits, the `tools.*` call surface, `searchTools`/`describeTool`, `store`/`load`, `max_output_tokens` (default 10,000), `codemode.mode` `on`/`only`, and the ~3,000-token inline declaration budget. Applies to the P3 pilot.

**R21 — Pi docs: Extensions (tool exposure)**  
Primary documentation, as inspected 2026-10-17.  
<https://pi.dev/docs/latest/extensions>  
Used for: the `direct` / `model-only` / `codemode` / `deferred` / `hidden` exposure modes, namespaces, and prompt and tool changes appended to the transcript instead of rewriting the prefix. Applies to P3 and P4.

**R07 — Anthropic: Effective context engineering for AI agents**  
2025-09-29. Primary engineering guidance.  
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>  
Used for: high-signal context, just-in-time retrieval, flexible instructions, compaction, structured notes, and scoped subagents. Applies to P3, P4, and P6.

### Desktop and browser references

**R15 — Electron: Performance**  
Primary framework guidance.  
<https://www.electronjs.org/docs/latest/tutorial/performance>  
Used for: profiling, deferred work, module loading, and avoiding main/renderer blocking. Applies to P2.

**R16 — agent-browser overview**  
Primary project documentation.  
<https://agent-browser.dev/>  
Used for: compact ref-based interaction, CLI/daemon lifecycle, supported capabilities, and platform support. Applies to P5.

**R17 — agent-browser sessions**  
Primary project documentation.  
<https://agent-browser.dev/sessions>  
Used for: session isolation, CDP tab binding, restore behavior, profile persistence, and state lifecycle. Applies to P5 and P7.

**R18 — agent-browser diffing**  
Primary project documentation.  
<https://agent-browser.dev/diffing>  
Used for: scoped snapshot differences, visual comparisons, and readiness limitations. Applies to P5 and browser eval scenarios.

### Repository reference map

- [README](../../README.md): Product overview; verify feature details against current code.
- [HANDOFF](../../HANDOFF.md): Historical implementation notes; older open items can be superseded by later code.
- [DESIGN](../../DESIGN.md): Renderer design contract and pre-ship requirements.
- [AGENTS](../../AGENTS.md) and [CLAUDE](../../CLAUDE.md): Project execution rules.
- [Context survival](03-context-survival.md), [cache hit rate](04-cache-hit-rate.md), [streaming and reasoning](05-streaming-reasoning.md), [context economy](10-context-economy.md), and [harness best practices](12-harness-best-practices.md): Earlier architectural research.
- [Package scripts](../../package.json): Current verification and evaluation entry points.

[R01]: https://claude.dev/blog/building-effective-agent-automations/
[R02]: https://claude.dev/blog/automating-eval-design-and-hillclimbing/
[R03]: https://reasonmachines.com/blog/introducing-reason-agent-1-1
[R04]: https://github.com/reason-machines/reason-agent
[R05]: https://github.com/reason-machines/benchmark/blob/main/docs/METHODOLOGY.md
[R06]: https://www.anthropic.com/engineering/advanced-tool-use
[R07]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[R08]: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
[R09]: https://developers.openai.com/api/docs/guides/evaluation-best-practices
[R10]: https://developers.openai.com/api/docs/guides/trace-grading
[R11]: https://google.github.io/adk-docs/evaluate/
[R12]: https://google.github.io/adk-docs/optimize/
[R13]: https://learn.microsoft.com/en-us/azure/foundry/concepts/built-in-evaluators
[R14]: https://learn.microsoft.com/en-us/azure/foundry/concepts/observability
[R15]: https://www.electronjs.org/docs/latest/tutorial/performance
[R16]: https://agent-browser.dev/
[R17]: https://agent-browser.dev/sessions
[R18]: https://agent-browser.dev/diffing
[R19]: https://pi.dev/
[R20]: https://pi.dev/docs/latest/codemode
[R21]: https://pi.dev/docs/latest/extensions
