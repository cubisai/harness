# Headless Claude (Agent SDK) usage weighting — research & fix plan

**Status as of 2026-10-16.** Upstream report [anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074) is **open, unacknowledged** (8 comments, last activity 2026-10-08; no Anthropic reply; `km-anthropic` mentioned but silent). No fix or mention of the weighting through Claude Code v2.1.301 / Agent SDK 0.3.301. This document is the plan for CubiQ (this repo), which is directly affected.

## TL;DR — the plan

1. **Measure it on our account** (Phase 0): a controlled A/B via the app's exact SDK query profile vs the interactive CLI, reading `rate_limit_event` utilization. This is the missing local evidence.
2. **Document it** (Phase 1): subscription logins consume ~2× per token on SDK-driven sessions; say so in README/docs and beside the limit meter.
3. **Offer the official route** (Phase 2): opt-in API-key mode for Claude sessions → bills as API usage (Max/Team monthly API credits introduced 2026-10-07), doesn't draw plan limits.
4. **Track upstream** (Phase 3): watch #97074 / release notes; verify each fix with the Phase 0 script.
5. **Do NOT ship** an entrypoint override (`CLAUDE_CODE_ENTRYPOINT=cli`). It's technically possible (proven below) but it misrepresents the usage surface, is unproven to change the weighting, and is metering evasion if the weighting is deliberate. This is the same posture t3code took.

## 1. What the issue is

Same model, same account, same workload: headless runs (`claude -p`, Agent SDK; transcript entrypoint `sdk-cli`/`sdk-ts`) consume **~1.8–2× more of the 5-hour subscription window per token** than interactive runs (`cli`, `claude-vscode`, `claude-desktop`).

- qvarker's controlled A/B (Opus 5, 2.1.282): ~**1.6 $/1%** headless vs ~**3.0 $/1%** interactive of the 5h window.
- Independent reproductions: Z3l20 (Pro, ~**2.0×**), futin (passive transcript audit, **1.30–1.49×**), imnakul (Windows, large effect), Reddit dataset (**~3×**).
- The only wire difference the author found: `cc_entrypoint=sdk-*` vs `cli` in the `x-anthropic-billing-header` system block and the User-Agent. Requests, tokens, retries, betas otherwise identical.
- A Zenn analysis (2026-10-01) fits the data with `5h utilization = interactive + headless × 2` (×1.25 weekly, ×2.86 during a weekday peak). Pattern suggests the weighting is **deliberate and time-varying** — but Anthropic has never confirmed this.
- Official docs remain silent on weighting; the support article still says SDK/`claude -p`/third-party apps "draw from your subscription limits" as one pool.

## 2. Impact on CubiQ (this repo)

CubiQ runs every Claude turn through `@anthropic-ai/claude-agent-sdk` (`src/main/agents/claude.ts`, one `query()` per turn, `pathToClaudeCodeExecutable` to the pinned/installed CLI). Verified locally in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`:

```js
// SDK sets the entrypoint only when unset — a caller-provided env overrides it.
if (!xt.CLAUDE_CODE_ENTRYPOINT) xt.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
```

So **every CubiQ turn is recorded as `sdk-ts`** — the penalized bucket. Users on a Pro/Max/Team subscription login consume the 5h/weekly windows roughly twice as fast per token as the same work in the terminal or VS Code. CubiQ currently always uses the Claude Code login (verified): `settings.credential()` always returns subscription, and `inject/claude.ts` strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` from every plan, so no API-key billing path exists for Claude today. A shell-level `CLAUDE_CODE_ENTRYPOINT` (rare, e.g. inherited from a tmux server) would flow through `process.env` — the pitfall Z3l20 documented.

The app already shows the effect (limit meter via `rate_limit_event` → `limits.ts`, ≥50%; per-turn `total_cost_usd`) but nothing explains it, and `total_cost_usd` is API list price — it doesn't reflect limit weighting.

## 3. How t3code deals with it (same situation, asked 2026-10-16)

Repo: [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Same root surface: sessions driven by the official Agent SDK (`sdk-ts`/`sdk-cli`). Main thread: **issue [#7338 "Extremely high usage"](https://github.com/pingdotgg/t3code/issues/7338)** (opened 2026-08-17, closed 2026-08-28, 55 comments, active through 2026-10-14).

- **Their shipped answer = no code workaround.** Theo (`t3dotgg`) investigated "heavily," attributed the controllable part to harness behavior (many parallel threads, revisiting old threads → cache misses, longer threads, less compaction), shipped **compaction UX improvements (PR #8144)**, and closed the issue demanding rigorous A/B evidence. He rejected the "git-status-in-cached-prefix" cache theory for t3code (via claude-code#78720). There is **no entrypoint spoofing or env pinning in their main** (`makeClaudeEnvironment` only handles `CLAUDE_CONFIG_DIR`); an earlier switch-to-PTY proposal (#2958) was closed. They stayed on the sanctioned SDK.
- **Their community nonetheless proved the weighting inside that thread:**
  - Aug 31 (m-ar-c): same prompt/params, T3 21% vs CC 11% of 5h → ~1.9×.
  - Oct 2 (Mauznemo): controlled, same CLI binary 2.1.287, same account; SDK-style query options vs CLI: **~2.1×** (0.0.34-style) and **~3×** (nightly-style) per identical unit; "T3 did not send more requests or tokens."
  - Oct 14 (gustavohariel): 0.37M weighted tokens per 1% of window through the SDK; **0.86M** per 1% when the same app was routed through the real Claude Code CLI → "Anthropic counts Agent SDK usage against the limit differently than the CLI."
- **The community workaround:** [claude-tty](https://github.com/sleeyax/paseo-plugins/tree/main/plugins/claude-tty) — a plugin that runs **the real interactive Claude Code CLI in a terminal** behind an ACP adapter, "bypassing this issue entirely." Works, but it drives the TUI/PTY and loses SDK features (structured tools, MCP injection, permission modes).
- Users who couldn't wait: switched to API billing or other providers. t3code's public stance remains "not convinced / more evidence needed" (no maintainer comment after Aug 28), which is why the Aug 28 close is still contested in-thread.

Net takeaway: **a peer harness did not fix it client-side; they documented, tuned harness hygiene, and let users measure — while a PTY-CLI provider remained the only working bypass.**

## 4. Root cause synthesis

**Established:**
- The differentiator is the entrypoint string (`sdk-*` vs `cli`/`claude-*`) sent in the billing header/UA; the server does the weighting.
- The entrypoint is caller-settable: SDK sets it only when unset (`sdk.mjs`, quoted above).
- The impact is ~1.8–2× per token in multiple independent measures; a third-party formula suggests deliberate ×2 (peak ×2.86) headless weighting.
- No official acknowledgement, no fix through 2.1.301.
- 2026-10-07 official escape hatch: Max/Team monthly API credits cover "the Claude Agent SDK, `claude -p`, the Claude API" — SDK usage run with an API key from the linked Console org bills as API usage, not plan limits.

**Unknown:**
- Whether `CLAUDE_CODE_ENTRYPOINT=cli` from an SDK client actually restores interactive weighting (nobody has published a controlled test; the recorded value would change, the weighting effect is unverified).
- Whether the server also weighs other SDK fingerprints (betas, UA, request patterns).

## 5. Fix options

| # | Option | What it is | Risk / cost | Verdict |
|---|--------|-----------|-------------|---------|
| A | **Measure & track** | Controlled $/1% A/B on our account using CubiQ's exact SDK query profile vs interactive CLI; follow #97074 + release notes | Low effort | **Do now** |
| B | **Surface it** | README/docs note + limit-meter hint: SDK usage counts ~2× per token against plan limits (community-measured) | Low; cosmetic only | **Do** |
| C | **Official billing route** | Opt-in setting: run Claude sessions on an Anthropic API key → bills to API/credits (Oct 7 pathway), not plan limits. Re-introduces a BYOK path for the Claude agent that `inject/claude.ts` currently strips (key storage infra already exists) | Medium: product decision + settings work | **Design & propose** — only no-risk "fix" |
| D | **Entrypoint override** | Pass `CLAUDE_CODE_ENTRYPOINT: "cli"` in the SDK `env` (one line at `claude.ts:437` / `inject/`) | **High:** unproven weighting effect; misrepresents usage surface; metering evasion if weighting is deliberate (ToS/account risk); fragile to server-side normalization | **Do NOT ship.** Personal experiment only, clearly labeled |
| E | **CLI/PTY wrapper provider** | claude-tty-style: drive the real interactive CLI in a PTY | High effort; loses SDK features; fragile automation-via-TUI | Fallback only |
| F | **Harness hygiene** | Measure/avoid needless session restarts (cache-write re-billing; cf. claude-code#78720), compaction nudges for long threads (t3 PR #8144 precedent) | Low | Cheap wins; measure first |

Note on **D**: the one-line change would make CubiQ's sessions record `cli`, but it would be lying about the client surface to obtain a different meter reading. If the weighting is intentional, that's evasion; if it's a bug, Anthropic will fix the server side. Either way the durable answers are A–C; ship D only if Anthropic states the weighting is unintended *and* upstream won't fix it.

## 6. Phased plan

**Phase 0 — measure (needed first).**
1. Add a script under `evals/` (run via `bun run eval`): fresh worktree, fixed model/effort, fixed multi-turn task (copy the #97074/Z3l20 method: first turn reads ~250K tokens of files, then short no-tool turns). Arm 1: SDK with CubiQ's exact `query()` options; Arm 2: interactive CLI control. Read `rate_limit_event.unifiedWindows.five_hour.utilization` before/after each arm via a tiny Haiku probe; compute `$/1%`.
2. Extend `test/claude-e2e.test.ts` (fake server, currently captures only `authorization`/`x-api-key` at line 30) to capture the User-Agent and the billing-header system block, and assert the entrypoint we send today (`sdk-ts`). Pins our wire behavior against silent changes.
3. Check harness-side hygiene (F) in the same runs: cache read/write ratios per turn, cost of the per-turn process respawn + `resume`, effect of changed `git status` between turns.

**Phase 1 — inform (no behavior change).**
4. Document in README ("Claude uses your existing Claude Code login…") + docs: subscription logins on SDK-driven sessions consume ~2× per token against plan limits (link #97074).
5. Optional: one-line note on the limit meter for subscription logins, same link.

**Phase 2 — official route (design decision).**
6. Evaluate re-enabling API-key mode for the Claude agent as an explicit opt-in ("Claude (API key — billed per token, doesn't use plan limits)"). Max/Team users with monthly API credits get the officially supported path; everyone gets predictable pay-per-use. Touches `inject/index.ts`, `inject/claude.ts`, `settings.ts` credential surface, Settings UI.

**Phase 3 — track upstream (ongoing).**
7. Watch #97074 and Claude Code release notes on every SDK bump. Triggers: *(a)* Anthropic documents intended weighting → update docs, default to C; *(b)* fix/regression note for `sdk-*` weighting → verify with the Phase 0 script, then just bump the SDK pin; *(c)* 30 days of silence → decide E vs accepting it.
8. Optional: post our Phase-0 numbers to #97074 (the t3 thread shows independent hard data is what moves this).

**Non-goals.** Entrypoint spoofing; TUI-scraping provider as a default; any UI promise that CubiQ "uses the same limits as the terminal."

## 7. Verification protocol (Phase 0 detail)

- Same commit, fresh worktree per arm; fixed model/effort (`opus 5`, medium/high); account otherwise idle; ±1% resolution handled with non-overlapping bands.
- Task: 40+ turns, ≤1 tool call after the first turn (per Z3l20/qavarker designs).
- Read utilization via a Haiku probe (`claude -p --output-format stream-json`, reading `rate_limit_event`), before and after each arm, again 10–20 min later.
- Cost from session transcripts (`message.usage`, dedup by message/request id) and `result.total_cost_usd`.
- **"CubiQ is affected" = SDK arm ≥1.5× CLI arm in $/1%, non-overlapping ranges.**

## 8. Open questions

1. Is the weighting deliberate? (Zenn formula + stable ratio suggest yes; #97074 unanswered.)
2. Does `CLAUDE_CODE_ENTRYPOINT=cli` restore interactive weighting for SDK-shaped traffic? (Unproven; do not rely on it.)
3. Does the Oct 7 API-credit path cover third-party harnesses via plain Console API keys? (FAQ wording says API-key SDK usage bills as Agent SDK usage/credits.)
4. Any change in Claude Code releases after 2.1.301?

## Sources

- Issue: https://github.com/anthropics/claude-code/issues/97074 — comments by qvarker (09-25), Z3l20 (09-27), futin (09-28), imnakul (10-08); still open, no Anthropic reply.
- t3code: https://github.com/pingdotgg/t3code/issues/7338 — Theo's close (2026-08-28), Mauznemo measurement (2026-10-02), gustavohariel CLI-routing test (2026-10-14); PR #8144 (compaction); related: claude-code#78720.
- Claude-tty workaround: https://github.com/sleeyax/paseo-plugins/tree/main/plugins/claude-tty
- Support: https://support.claude.com/en/articles/15036540 (updated 2026-10-07) · https://support.claude.com/en/articles/17154008 (monthly API credits)
- Zenn analysis (2026-10-01): https://zenn.dev/tksfjt1024/articles/25c0ab111c277c
- Local: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (entrypoint default `sdk-ts`, set only when unset) · `src/main/agents/claude.ts:437` (env pass-through) · `src/main/inject/index.ts:65-70`, `src/main/inject/claude.ts:7` (subscription-only, key vars stripped) · `src/main/agents/limits.ts` (rate-limit parsing) · `test/claude-e2e.test.ts:30` (header capture point)

---

## Appendix — original write-up (as filed in this repo)

https://github.com/anthropics/claude-code/issues/97074

TL;DR: I ran the same coding task six times through four ways of running Claude Code, with the same model and effort, and checked /usage before and after each run. Interactive use (VS Code extension, terminal CLI) cost about 1.7% of the 5-hour limit per $1 of API-equivalent tokens. Headless use (Python Agent SDK, claude -p) cost about 5.2% per $1. Same tokens, roughly 3x more of the limit. I couldn't find this documented anywhere.

Why I tested it

I run some coding tasks headless through the Agent SDK in a container, and I kept noticing that one mid-sized headless task ate a big chunk of my 5-hour window. The same kind of work in VS Code felt far cheaper. At first I assumed the headless agent was just burning more tokens, so I measured.

Setup

Claude Code Pro

Task: a medium refactor in a Python monorepo. Add an optional field to a shared protocol model, handle it on several failure paths in a worker, update the docs, and write tests across three packages. Roughly 45–75 model calls per run.

Same starting point: the same commit every time, each run in a fresh git worktree.

Model: Opus 5, effort medium, standard tier, no fast mode. I checked this in the transcripts for every run.

Flow: "study the repo and propose a plan" → "plan approved, implement, run tests, commit". The claude -p run got a single prompt covering both.

Nothing else on the account during the runs: no claude.ai, no other sessions.

Measurement: /usage right before and right after each run, then again 10–20 minutes later to catch any delayed accounting. There was none.

Cost: computed from the per-message usage in the session JSONL transcripts at API list prices. It matched Claude Code's own cost tracking to the cent.

Results

Mode	Entrypoint (from transcript)	Steps	Max context	API-equiv. cost	5h usage	% of limit per $1
VS Code extension, run A	claude-vscode	56	119k	$4.01	+7%	1.7
VS Code extension, run B	claude-vscode	76	144k	$5.66	+9%	1.6
Interactive CLI in terminal	cli	63	119k	$4.38	+8%	1.8
Python Agent SDK, run A	sdk-py	54	81k	$2.88	+15%	5.2
Python Agent SDK, run B	sdk-py	61	98k	$3.44	+18%	5.2
claude -p	sdk-cli	44	84k	$2.53	+13–14%	5.1–5.5
What stands out

The headless runs used fewer tokens than the interactive ones: smaller context, fewer steps, cheaper at API prices. They still took about 2x the limit per run, which works out to about 3x per token.

The ratio held steady: 5.2% per $1 in both SDK runs, 1.6–1.8% across all three interactive runs.

It isn't VS Code vs. terminal. The interactive CLI landed right next to VS Code. The split is interactive vs. headless.

It isn't a custom system prompt or odd SDK settings. claude -p on the same machine, with the same CLI version as the VS Code extension and the default system prompt, gave the same ~3x number as the SDK.

Practical takeaway

With these numbers, a headless task costing about $18 at API prices takes roughly 90% of a 5-hour window. The same amount of work done interactively takes about 30%. If you run agents headless on a subscription, budget for that.

Caveats

It's a small sample: six runs, one task, one model, one account ([Pro]).

/usage shows whole percentages, so each reading is ±1%.

I don't know which signal the accounting actually uses: the entrypoint, request patterns, or something else.
