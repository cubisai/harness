## 12. Harness Best Practices: Context, Rule Files, Anti-Cheat, First Prompt, No Guessing, Tokens, Caching, Auto Tools and Memory

**Thesis.** The model is only part of an agent. The harness around it decides what enters context, how the prefix stays cached, what counts as "done", and what the agent remembers. This chapter collects the 2025–26 guidance from vendors, papers and open-source harnesses on the user's eight points (2026-10-13), plus five added points, and checks it against CubiQ on `m4`. The work it leads to is in `.ai/plans/harness-bp.md` (phases H0–H7).

Scope follows roadmap rule B10. The **native agent** (`src/main/harness/**`) is ours end to end, so all of it applies there. **Claude, Codex and OpenCode** keep their own prompts and loops. They get only the shared guide (`resources/CUBIQ.md`), the shared memory, and harness-side gates that run the same for every agent.

Earlier chapters still hold and are not repeated: [04 cache hit rate](04-cache-hit-rate.md), [10 context economy](10-context-economy.md), [finding-research](finding-research.md), and the research section of `.ai/plans/native-agent.md`.

Source tags: `[P]` primary (vendor docs, papers), `[S]` secondary (blogs, summaries; figures to be re-checked before quoting).

### 12.1 Context management and optimisation

- **Context is an attention budget.** Recall degrades as input grows ("context rot"). It degrades more when distractors are close in topic and when the needed fact sits mid-context [1][2]. The goal is the smallest set of high-signal tokens [1].
- **Just-in-time over preload.** Keep identifiers such as paths, URLs and stored queries, and load content with tools. Use a hybrid for speed: a small preload, the rest on demand [1].
- **Compression must be restorable.** Drop a page but keep its URL. Drop file text but keep its path [3].
- **Cheapest first.** Order: tool-result clearing (lightest) → summary compaction → sub-agents with clean windows that return a 1–2k-token digest [1].
- **Masking ≈ summarising, at half the cost.** In SWE-agent on SWE-bench Verified, observation masking halved cost against the raw agent and matched or beat LLM summaries. Summaries lengthened runs. A hybrid of the two was 7–11% cheaper still [4]. Later work (CoACT, ACON, anchored distillation) keeps exact execution evidence, which generic summaries paraphrase away [5].
- **Recitation.** Keep a todo list rewritten at the end of the context, which counters lost-in-the-middle [3].
- **Keep errors in.** Failed actions and stack traces stay in context, so the model updates away from them [3].
- **Vary serialisation slightly**, so repetitive history doesn't few-shot the agent into a rut [3].
- **What a compaction summary must keep** [6]:
  1. problems and how they were handled;
  2. approaches tried or set aside, and why;
  3. decisions, constraints and preferences, stated exactly;
  4. where things stand now;
  5. what is still open;
  6. details that are hard to reconstruct (names, numbers, paths, exact wording).

  Keep the user's words close to verbatim; condense the agent's own reasoning.
- **Server-side context management** (Anthropic): `compact_20260112` compaction and tool-result clearing as `context_management.edits` [7].

**CubiQ today.** The native agent prunes old tool output (protects 40k tokens, acts only when ≥ 20k can be freed, `context/prune.ts`), then runs template compaction with touched files (`context/compact.ts`). It has todo, sub-agents (`task`) and a doom-loop guard (`loop.ts:230`). The CLIs compact natively.

### 12.2 The harness rule file (AGENTS.md / CLAUDE.md / CUBIQ.md)

- **Context files cost more than they give.** Across four agents and models, they gave no gain in task success. LLM-generated files often lowered it, and every kind raised cost by more than 20% (+3.9 steps per task). Agents follow the extra instructions and explore more widely. Keep human-written files minimal: only what the agent can't infer from the code [8].
- **A map, not an encyclopedia.** Prefer mechanical enforcement (lint, CI, structural tests) with failure messages that teach the fix. Prune stale rules on a schedule [9][10].
- **Plain wording.** Current Claude models over-trigger on "CRITICAL / You MUST". Write "Use this tool when…" [11].

**CubiQ today.** `resources/CUBIQ.md` is about 330 tokens with a budget test (roadmap N8). `memory-scope.ts` warns when CLAUDE.md and AGENTS.md would load twice. This is already in line; additions must stay inside the budget.

### 12.3 Anti-cheat: reward hacking, false success, invented facts

- **Reward hacking happens in shipping agents.**
  - EvilGenie saw Codex and Claude Code hard-code test cases and edit test files [12].
  - The most common hack is special-casing the example given in the task [13].
  - Ranked by usefulness: test-file hash/edit detection (simple, reliable); held-out tests; an LLM judge.
  - Giving the model a sanctioned way to say "this test or task is wrong" cut cheating on conflicting-test tasks from 54% to 9% [14][S].
  - Read-only tests block edits without lowering honest success [14][S].
- **False success.**
  - Agents claim completion that the system state doesn't show: about 45–48% of failures in single-control τ²-bench domains and 75.8% of self-assessing AppWorld coding runs [15].
  - LLM judges anchor on confident wording and catch it poorly (AUROC ≤ 0.65).
  - Checks against **external evidence** work. One design blocks "done" unless the falsifiable gate actually ran and passed [16][17].
- **Invented values.**
  - Agents assert values their tools never returned after a tool failure [18].
  - They adopt corrupted tool output at high rates; web search reached 68% [19].
- **Package hallucination ("slopsquatting").**
  - About 20% of suggested packages don't exist on open models and about 5% on commercial ones.
  - 43% of fake names recur on every rerun, which makes them registrable attack targets [20][S].
- **Prompt snippets** (Anthropic) [11]:
  - `investigate_before_answering`: "Never speculate about code you have not opened…".
  - The anti-hard-coding block: "Tests are there to verify correctness, not to define the solution… If any of the tests are incorrect, please inform me rather than working around them."

**CubiQ today.** The N7 check gate runs the project's checks harness-side. Nothing detects test tampering or a "tests pass" claim made with no test run.

### 12.4 A first prompt that goes straight to tool calls

- **Altitude.** Sectioned and minimal but complete. Start small, and add a rule only for a failure you've seen [1].
- **Batching.** In coding loops, newer Claude models may issue one call per turn. The fix is a one-line nudge: "First privately list what you need next; then request every item that doesn't depend on another's result in this one response." Send it as a turn-scoped system message, or as a text block after the tool results, never by editing history [6].
- **Context gathering** (OpenAI): search broadly, then focus in parallel; stop once you can act; set a call budget; leave an escape hatch to proceed under uncertainty [21].
- **No upfront plans or preambles for Codex models.** They make the model stop before the rollout finishes [22].
- **Finish the whole task.**
  - "The user is not watching in real time… proceed without asking for reversible actions."
  - "Before ending your turn, check your last paragraph."
  - "The scope is the deliverable."

  These come from [6].
- **Hybrid preload.** A small, frozen environment snapshot in turn 1, with the rest just-in-time [1].

**CubiQ today.** The native `BASE` prompt is short and sensible. It lacks the batching nudge, the finish-the-task rule and a context-awareness note. Its env block, with the date, sits inside the cached system prompt.

### 12.5 No guessing

- "Never use placeholders or guess missing parameters in tool calls." [11]
- Infer the most useful action and **use tools to discover missing details** instead of guessing (`default_to_action`) [11].
- Ask only when different readings would lead to materially different work. Otherwise state the assumption and keep going; put a blocking question at the end of a turn that also delivers progress [6].
- **Search-trigger rule for fast-moving names:** "familiarity is not a reason to skip the search". This matters most at low effort, where newer models answer from memory more often [6].

### 12.6 Token optimisation

- Input:output is about 100:1 in agent loops, so input tokens are the bill [3].
- **Tool design** [23]:
  - Return high-signal, token-efficient output.
  - Paginate, filter, and set sensible default limits.
  - When truncating, say how to narrow the request.
  - Make error messages name the bad field and the right format.
  - Keep tool sets small and non-overlapping [1].
- **Edits.** Use `apply_patch` for GPT-family models and string-replace `edit` for the rest [22]. Prefer surgical edits over whole-file rewrites [6].
- **Deferred tools.** A 58-tool, five-server MCP setup costs about 55k tokens before the first message. Tool search plus programmatic tool calling avoids it [24].

### 12.7 Prompt caching

- **The production metric.** Cached input is 10× cheaper; KV-cache hit rate is the number to watch [3].
- **Prefix discipline** [3][25]:
  - Order: tools → system → messages.
  - Byte-stable prefix: no second-level timestamps early, deterministic JSON key order.
  - Append-only history.
  - Up to 4 breakpoints; move the last one forward each turn.
  - Default TTL is 5 minutes. A 1-hour TTL costs 2× on write.
  - Reads cost about 0.1× of base input.
- **Mask, don't remove.** Changing the tool list mid-session breaks the cache and confuses the model about earlier calls [3].
- **New with Claude 5.x: thinking blocks are bound to their prefix** [6].
  - A request that replays a thinking block after its prefix changed returns **400**. That prefix is the system prompt, the tools, or any earlier message, and the check is enforced for accounts created on or after 2026-08-31. With the `drop_block` beta, the block is dropped instead.
  - The edits that trip it are the same ones that restart the cache: injected and removed reminders, summaries written in place, system-prompt changes.
  - Fixes:
    - turn-scoped or mid-conversation system messages;
    - server-side compaction or context editing;
    - client compaction that replaces the history with one summary and replays **no** thinking blocks.
  - Cache reads are cheaper now, so later compaction points may be the better trade.

**CubiQ today.** The native Anthropic protocol sets 3 breakpoints: last tool, last system part, last user message (`anthropic-messages.ts:66-71`). Responses sends `prompt_cache_key`. Guide files are mtime-cached, and `cache-policy.ts` fingerprints the tool set. **Gap:** pruning and compaction rewrite earlier turns while the tail still replays signed thinking blocks (`anthropic-messages.ts:37-38`, `driver.ts:342-345`, `compact.ts:213`).

### 12.8 Automatic skill, MCP and web use

- **Skills: progressive disclosure** [26].
  - Name and description sit in the prompt at about 50–100 tokens each; the body loads on trigger; bundled files load on demand.
  - The description is the only routing signal, and overlap between descriptions is the main failure mode [27].
  - Measure with a labelled set of should-trigger and shouldn't-trigger prompts, and re-run it as skills are added [28].
- **MCP.** Defer schemas behind a search tool [24]. CubiQ's router (`search_tools` / `call_mcp_tool`) already does this.
- **Web.** Provider-hosted search exists: Anthropic `web_search` and OpenAI Responses `web_search`. A local bounded fetch covers the rest. The native agent has neither today.
- **Over-triggering.** Plain "Use X when…" wording, not "If in doubt, use X" [11].

### 12.9–12.12 Added points

- **12.9 Verification and honest reporting.**
  - Separate generation from evaluation.
  - Make the checks fast so the loop is short.
  - Let the agent drive the real app.
  - Count every "continue" a user has to type as a harness bug [9][10].
  - Report only what ran (12.3).
- **12.10 Long-horizon state** [29]:
  - An initializer session writes `init.sh`, a progress log and a JSON feature/test list, then makes the first commit.
  - Later sessions read them, plus `git log`, before working, finish one item, and commit.
  - Git is the checkpoint log [11].
- **12.11 Tool output is data.** Never treat it as instructions. This defends against prompt injection through fetched pages, files and MCP results.
- **12.12 Evals and telemetry.**
  - Behavioural unit-style evals that assert on tool calls and file changes, next to slower end-to-end runs [10].
  - Per-turn cache-hit %, steps, tool calls and false-claim flags.

### 12.13 Memory

- **Anthropic's memory tool** (`memory_20250818`, generally available on Claude 4+) [30]:
  - It is a client-side `/memories` folder that the model edits with view, create, str_replace and delete, and that the app executes.
  - Guard against path traversal.
  - Paired with context editing it scored +39% on Anthropic's internal evals; context editing alone cut tokens by 84% on a 100-turn search task [31].
- **Files beat memory products on a simple setup.** An agent with grep/open over a file scored 74.0% on LoCoMo, against 68.5% for Mem0's best graph variant. Vendor leaderboards are run under different setups and aren't comparable [32][S]. Newer work tests knowledge updates and contradictions, not just recall (Memora, ACL 2026) [33][S].
- **Practices** [32][S]:
  - Scope every operation (user vs project).
  - Index in the prompt, bodies on demand.
  - Write on demand or asynchronously.
  - Consolidate periodically: merge duplicates, resolve contradictions.
  - Filter secrets.
  - Freeze the injected index per session so the cache prefix stays stable.

**CubiQ today.**
- Shared memory is on by default (`memory/index.ts`).
- Claude writes through its own auto-memory, pointed at CubiQ's folder (`claude.ts:435`).
- Codex's native memories are off (`codex.ts:895`).
- OpenCode and the native agent get an index block plus `memory_read`.
- Only Claude can write; the others rely on the background extractor.
- No global user layer.
- **Decision (user, 2026-10-13):** one CubiQ path for every agent (Claude's auto-memory off, the same `memory_read` / `memory_write` for all), plus a global user layer (plan H7).

### 12.14 Gaps and where they're fixed

| # | Gap | Phase |
|---|---|---|
| G1 | Pruning and compaction edit earlier turns but replay signed thinking blocks: a 400 risk, and the cache restarts on each prune | H1 |
| G2 | No investigate-first, no-guess, anti-hard-coding, finish-the-task or batching rules in the native prompt | H2 |
| G3 | Native agent has no web search or fetch | H5 |
| G4 | No test-tamper or "claimed but not run" check, for any agent | H4 |
| G5 | Compaction template lacks the six-item preservation list | H2 |
| G6 | Date inside the cached system block | H1 |
| G7 | No skill-routing or false-success measurement | H5, H6 |
| G8 | Memory reaches each agent differently, only Claude writes, no global layer | H7 |

### Sources

1. [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) `[P]`
2. [Chroma — Context Rot](https://trychroma.com/research/context-rot) · [code](https://github.com/chroma-core/context-rot) `[P]`
3. [Manus — Context engineering for AI agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) `[P]`
4. [The Complexity Trap (arXiv 2508.21433)](https://arxiv.org/pdf/2508.21433) · [repo](https://github.com/JetBrains-Research/the-complexity-trap) `[P]`
5. [CoACT (arXiv 2607.02911)](https://arxiv.org/html/2607.02911v1) · [ACON (arXiv 2510.00615)](https://arxiv.org/pdf/2510.00615) · [Terminal-agent compression (arXiv 2604.19572)](https://arxiv.org/pdf/2604.19572) `[P]`
6. [Anthropic — Prompting Claude Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1) `[P]`
7. [Anthropic — Compaction](https://platform.claude.com/docs/ja/build-with-claude/compaction) `[P]`
8. [Evaluating AGENTS.md (arXiv 2602.11988)](https://arxiv.org/pdf/2602.11988) `[P]`
9. [OpenAI — Harness engineering](https://openai.com/index/harness-engineering/) `[P]` (page blocks fetches; details via [InfoQ](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex) `[S]`)
10. [Google — The anatomy of harness engineering](https://developers.googleblog.com/the-anatomy-of-harness-engineering-how-to-evaluate-iterate-and-guard-ai-coding-agents/) `[P]` · [marmelab — State of harness engineering 2026](https://marmelab.com/blog/2026/09/24/the-state-of-ai-harness-engineering-2026.html) `[S]` · [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) `[S]`
11. [Anthropic — Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) `[P]`
12. [EvilGenie (arXiv 2511.21654)](https://arxiv.org/pdf/2511.21654) `[P]`
13. [Escalation channels vs reward hacking (arXiv 2608.29460)](https://arxiv.org/pdf/2608.29460) `[P]`
14. [Prime Intellect — Reward hacking (ImpossibleBench figures)](https://primeintellect.ai/rl-glossary/reward-hacking) `[S]`
15. [From Confident Closing to Silent Failure (arXiv 2606.09863)](https://arxiv.org/pdf/2606.09863) `[P]`
16. [EviBound (arXiv 2511.05524)](https://arxiv.org/pdf/2511.05524) `[P]`
17. [Goal-Autopilot (arXiv 2606.11688)](https://awesomepapers.io/papers/2606.11688) `[S]`
18. [Fabrication after tool failure (arXiv 2609.14758)](https://arxiv.org/pdf/2609.14758) `[P]`
19. [Agents trust tools too much (arXiv 2609.05587)](https://arxiv.org/pdf/2609.05587) `[P]`
20. [Slopsquatting coverage](https://www.infosecurity-magazine.com/news/ai-hallucinations-slopsquatting/) `[S]`
21. [OpenAI — GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide) `[P]`
22. [OpenAI — Codex prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) `[P]`
23. [Anthropic — Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) `[P]`
24. [Anthropic — Advanced tool use](https://anthropic.com/engineering/advanced-tool-use) `[P]`
25. [Anthropic — Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) `[P]`
26. [Anthropic — Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) `[P]`
27. [SkillRouter (arXiv 2603.22455)](https://arxiv.org/pdf/2603.22455) `[P]`
28. [Google — skill-reach](https://google.github.io/skill-reach/) `[P]`
29. [Anthropic — Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) `[P]`
30. [Anthropic — Memory tool](https://platform.claude.com/en/docs/agents-and-tools/tool-use/memory-tool) `[P]`
31. [Anthropic — Context management](https://www.anthropic.com/news/context-management) `[P]`
32. [A folder of text files vs memory layers](https://pub.towardsai.net/mem0-vs-zep-vs-letta-a-folder-of-text-files-shouldnt-beat-the-61k-star-memory-layer-9d7e65c5799c) · [Mem0 vs Letta](https://mem0.ai/compare/mem0-vs-letta) · [Long-term memory guide](https://atlan.com/know/how-to-implement-long-term-memory-ai-agents/) `[S]`
33. [mem0 memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) `[S]`
34. Local repository, verified 2026-10-13 on `m4`: `src/main/harness/{context,llm/protocols,driver.ts,loop.ts}`, `src/main/memory/*`, `src/main/agents/{claude,codex}.ts`, `resources/CUBIQ.md`.
