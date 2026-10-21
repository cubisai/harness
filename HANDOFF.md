# Handoff: code-mode defaults, browser tools on demand, run_code hint + arg fixes, cache report — 2026-10-21 — see "Resume here — 2026-10-21 (Mac, session 6)"

## Resume here — 2026-10-21 (Mac, session 6)

m4 = `eb2bdd0` + this handoff, pushed. The main checkout's `D road-map-handoff.md`, `pland.md` and the user's screenshots aren't ours: leave them.

**Commits (all on m4, pushed):**
- `5305317` Code mode defaults to Read-only + MCP for **new installs** (settings schemaVersion 4). An older settings file that never chose keeps Off; pinned in memory only, persisted on the next save (a corrupt file is never rewritten at startup).
- `8d55dbe` `bun run cache:report [db] [--days N] [--json]` (`scripts/cache-report.ts`): hit rate, warm hit rate (without each thread's first turn), reads/writes, cost and miss causes per agent and model; default DB = the installed CubiQ profile on each OS. On the user's profile, warm: Claude Sonnet 95%, Codex Luna 99%, OpenCode DeepSeek ~83% (worth a look).
- `9a1b08d` + `9e86e1e` **Browser tools on demand, always on** (user: no Experiments row). Agents without their own tool search (capability `toolSearch` is set only on Claude) get `browser_tools` (lists the rest with schemas) and `browser_call` (runs one) in place of the 7 browser tools that never ask; `browser_eval` (asks) stays loaded, so no permission changes. ~1.3k fewer tokens per request (pinned by a test against the real tools). Native gets it through `turnTools` in index.ts; Codex and OpenCode through the HTTP tool server's `?b=1` (set when the turn's list has browser_call). Rows read "browser_open · url"; `fetchedUrl` understands browser_call. Design threads keep the full list. Live: TokenHarbor, OpenCode Zen, Codex Luna and Claude all did a type-and-click page task correctly (TokenHarbor 16 s vs 10 s: one extra lookup call).
- `a31380a` **Code mode hint**: when code mode is on, one fixed line (`CODE_HINT`, `src/main/code-hint.ts`) tells Claude (system append), the native agent (system), Codex (developer instructions, when run_code is attached) and ACP agents (inside `<harness-guide>`, not OpenCode 2) to explore with one run_code script and keep the shell for git, builds, tests and edits. run_code's description now says read on a folder lists it. Live "explore this code base": Claude 1, Codex 5, OpenCode 5, TokenHarbor 7 run_code calls, **0 shell calls** (before: the user saw Bash ls/cat/git).
- `eb2bdd0` run_code failure fixes: of 84 script calls in the bench profile, 10 failed; 6 were `tools.glob("x")` / `tools.read(f)` (a bare string became `{}`) and grep `output_mode: "files"`. Now a bare string fills the tool's one required string parameter (`mainArg` in `harness/tools/code.ts`) and grep takes "files" as files_with_matches. The rest were model mistakes (missing path, calling a method on a folder listing).
- Earlier this session: Experiments section, Only removed, sidebar flat view (see session 5 above).

**Full suite 3373 passed.** `test/mcp-http.test.ts` heartbeat test failed once under full-suite load and passed 3/3 alone (timing flake).

**Next:**
1. **First-prompt tokens** (user asked for a clean strategy): Claude's first request is ~27k, with **Skills 7–10k** (the SDK's own skill listing: user skills in ~/.claude/skills plus CubiQ's plugin) and Memory files 3–3.8k; Codex ~23k and OpenCode ~46k are mostly their own prompts (ours: tools ~1.6k after browser on demand, guide 0.45k, skills ~0.5k); native 7.6k. Proposed rule: always load a small core plus a one-line index per category, fetch the rest on demand. Waiting on the user.
2. OpenCode "Web search cancelled": still need where it was seen.
3. Session-3 leftovers: Own worktree, /doctor, ShellDock polish, Windows run.

## Resume here — 2026-10-21 (Mac, session 5)

m4 pushed to origin (session 5 end). The uncommitted `D road-map-handoff.md` in the main checkout still isn't ours: leave it.

- `50d459e` **Settings**: Code mode moved from Agents & Providers to a new last group **Experiments**; the middle stop reads "Read-only + MCP (Recommended)"; the note describes the new Only (Claude and CubiQ's own agents lose direct search tools, Claude keeps Read, shell searches turned away; Codex and OpenCode get a one-line hint). `settings-ia.test.tsx` pins the group and label. Suite 3357 passed; screenshotted dark.
- Sidebar question from a workmate (expanded projects empty): not a bug. In the flat **"All"** Recent view the Projects list only holds archived threads; "By project" (default) lists threads under each project. Fixed per user: in flat view a project starts folded and opening it lists its threads, then Archived (Sidebar-local `flatOpen`; the grouped view's `collapsedProjects` is untouched).

**Only rerun** (session-4 item 2), build `50d459e`, same task and ground truth as session 4 (3 consts; types count as wrong):

| Run (only) | Time | Cost | Cache read | Out | Tools | Correct |
|---|---|---|---|---|---|---|
| OpenCode Zen | 90 s | free | 508k | 6.1k | 15 run_code | ✓ |
| TokenHarbor #1 | 102 s | free | 379k | 12.0k | 21 run_code | ✗ (+11 types) |
| Claude Sonnet (cold, after app start) | 20 s | $0.137 | 27k | 1.4k | 1 run_code | ✗ (+RUN_MANIFEST_VERSION, +11 types; text match on "shared") |
| PGS Grove #1 | 100 s | $0.0065 | 139k | 4.2k | 11 run_code + 2 Bash | ✗ (missed AUTO_OPEN, PROVIDER_MODEL_PREFIX; +9 types) |
| Codex Luna | 47 s | sub | 22k | 0.3k | **5 shell (rg/node), 0 run_code** | ✓ |
| TokenHarbor #2 | 1108 s | free | 355k | 9.9k | 14 run_code + 4 Bash + Write/Edit of `/tmp/*.mjs` | ✗ (no answer: "no activity from TokenHarbor for 10 minutes") |
| PGS Grove #2 | 87 s | $0.0058 | 99k | 5.3k | **8 Bash, 0 run_code** (`cat > /tmp/*.mjs` + node) | ✗ (+10 types) |

- Only, both sessions together: OpenCode 2/2, Codex 2/2, Claude 1/3, TokenHarbor 1/3, PGS 0/3. "On" was 6/6 in session 4.
- The native agent sidesteps Only: `isShellSearch` only catches commands that start with grep/rg/find…, so models write node scripts to `/tmp` through Bash. Codex ignored the hint this time.
- **"Only" removed** (user agreed). Code mode is Off / Read-only + MCP; a settings file that still says `only` reads as `on`. Gone: `code-hint.ts` (hint, `CODE_ONLY_DENY`, `isShellSearch`), Claude's Grep/Glob disallow and Bash search hook, the native read/glob/grep filter and `ToolContext.searchOnly`, the Codex/ACP hint lines. Suite 3355 passed; live "on" turn on Claude, Codex, OpenCode Zen and native TokenHarbor: 1 run_code each, all correct.
- Bench driver (scratchpad, gone after the session): same as session 4, plus 30 s between runs, codeMode set once before all runs, results as JSONL (turn-end payload, top-level tool-use counts, red rows, errors, last assistant text).

**Next:** OpenCode "Web search cancelled" (ask where they saw it); session-4 items 4–5.

## Resume here — 2026-10-21 (Mac, session 4)

m4 = `aaa52ea` + this handoff commit (fast-forwarded from `m5-redrows`), **not pushed**. Worktree removed. The main checkout has an uncommitted `D road-map-handoff.md` that isn't from this session: leave it.

**Commits:**
- `946590c` **fix(claude)** (handoff items 2 + 4):
  - Per-turn cost on resumed sessions. Verified with the SDK: `total_cost_usd` is the session's running total and carries over on resume (turn 2 = turn 1 + its own). Every Claude turn-end now stores `sessionCost: {sessionId, usd}`. `service.ts` passes `priorSessionCostUsd` (`Store.lastSessionCost(thread, session)`), and `turnEndFromResult` subtracts it when the session matches. Live: turn 2 recorded $0.0116 (own share) instead of $0.0400. Old threads keep their inflated rows.
  - Red rows: tool results containing `CODE_ONLY_DENY` / `BACKGROUND_BASH_DENY` are not errors. A grep-led command (`grep|rg|ag|ack…`, optional `cd x &&`) whose result is exactly `Exit code 1` shows "No matches" (exit 1). The SDK already handles a plain `grep` with no match ("(Bash completed with no output)", not an error); the fix covers cases like `grep -q x f && echo yes`. Checked live in dark theme.
  - `run_code` description: "no require or import: reach files only through `tools`". PGS still tried `require` once.
- `aaa52ea` **fix(code-mode): Only** for the native agent and OpenCode:
  - Native: `CODE_ONLY_HINT` goes in the system prompt (before the plan note; cache-stable per thread), and `ToolContext.searchOnly` makes Bash return `CODE_ONLY_DENY` as a normal result for `isShellSearch` commands.
  - OpenCode: the hint is added inside `<harness-guide>` on a new session's first prompt (unless OpenCode has its own code mode). There's no hard block: rejecting an ACP permission ends OpenCode's turn, and its grep/glob can't be hidden per thread.
  - `CODE_ONLY_HINT` now says "run_code" (was "cubiq run_code"), so it fits every agent.
- Item 3 (Codex ignores run_code in "on"): left as is, on purpose ("on" = optional).
- Full suite after both: **3356 passed**, 0 failed; typecheck clean. Live: Claude, Codex Luna, OpenCode Zen, native TokenHarbor and PGS Grove all ran.

**Benchmark** (scratch profile, project = `git clone --depth 1` of m4 @17b3eba). Task: "exported functions/consts in src/shared/*.ts no other file imports". **Ground truth = 3**: `AUTO_OPEN`, `PROVIDER_MODEL_PREFIX`, `VARIANT_RE`; verified by parsing every import/re-export. Not answers: `RUN_MANIFEST_VERSION` (imported by evals/run.ts), `codexCompatible` (re-exported by main/providers.ts). No rate limits hit on any free run.

| Run | Cost | Time | Cache read | Out | Tools | Correct |
|---|---|---|---|---|---|---|
| Claude off #1 / #2 | $0.197 / $0.056 | 26 / 24 s | 108k / 96k | 1.6k / 1.2k | 3 / 2 Bash | ✓ ✓ |
| **Claude on #1 / #2** | **$0.146 / $0.028** | **15 / 15 s** | 30k / 60k | 0.9k / 1.0k | 1 run_code | ✓ ✓ |
| Claude only #1 / #2 | $0.111 / $0.073 | 20 / 22 s | 75k / 49k | 1.5k / 1.0k | 2 / 1 run_code | ✓ ✗ (+RUN_MANIFEST_VERSION) |
| Codex Luna off / on / only | sub | 41 / 28 / 42 s | — | — | 8 shell / 4 shell / 5 run_code | ✓ ✓ ✓ |
| OpenCode Zen off / on / only | free | 51 / 82 / 64 s | 142k / 453k / 223k | 3.0k / 5.7k / 4.1k | 7 shell / 14 run_code / 12 shell | ✓ ✓ ✓ |
| TokenHarbor off / on / only | free | 109 / 67 / 220 s | 195k / 150k / 981k | 8.0k / 5.2k / 13.2k | 14 / 11 / 34 (32 Bash) | ✓ ✓ ✗ (+11 types) |
| PGS Grove off / on / only | $0.029 / $0.006 / $0.029 | 141 / 77 / 441 s | 707k / 125k / 636k | 5.6k / 2.6k / 18.5k | 38 / 10 / 27 Bash | ✓ ✓ ✗ (+10 types) |
| **After `aaa52ea`:** TokenHarbor only | free | **56 s** | 90k | 3.8k | 11 run_code, 0 Bash | ✓ |
| **After `aaa52ea`:** PGS Grove only | $0.010 | **120 s** | 229k | 6.1k | 13 run_code + 3 Bash | ✗ (headline "18 unused by src/"; lists the right 3 as "not imported by anything") |

- Claude #1 runs follow an app restart and pay cache writes; the #2 runs are the fair cost comparison.
- **"On" is the best mode**: 6/6 correct; faster than off for Claude (−40%), Codex (−32%), TokenHarbor (−39%) and PGS (−45%), and cheaper (Claude $0.028 vs $0.056 warm; PGS 5×). OpenCode Zen was the exception (82 vs 51 s: 14 small scripts).
- All misses were in "Only". Before the fix the native agent never used run_code in "only" (Bash for everything).
- The post-fix rerun stopped early: OpenCode Zen only stalled (no activity for 3 min; probably the free tier), and the Claude only, Codex only, TokenHarbor #2 and PGS #2 runs never ran.

Benchmark tooling (scratchpad, gone after this session; recreate from here):
- Driver `bench.mjs`: new thread per run → `updateThread({agent, model, permissionMode:"full"})` → verify the DB row → `send` → poll for a new top-level `turn-end` (`parent_id IS NULL`) every 5 s, timeout 15 min.
- Free providers: at least 90 s between runs of one provider; on `/rate.?limit|429|quota|allowance|exhausted/` wait 180 s and retry once.
- **`execFileSync('sqlite3', …)` needs `maxBuffer: 256 MB`** (ENOBUFS lost one run's stats).
- Code mode is set with `updateSettings({codeMode})` *before* `createThread`; a thread fixes it at creation.
- Register the project by inserting a `projects` row (id, path, name, created_at). Providers via `saveProvider({…, secret:{kind:"envRef", envVar}})` with the app launched after `set -a; source .env`.

**Next, in order:**
1. **Settings UI** (user, 2026-10-21; follow DESIGN.md + `design-system` skill, screenshot in dark theme):
   - Mark "Read-only + MCP" as **(Recommended)** on the Code mode switch.
   - Move Code mode out of Settings → Agents into a **new "Experiments" section**.
   - Rewrite the note under the switch for the new Only behaviour: Claude and the native agent lose direct search tools and have shell searches turned away; Codex and OpenCode get a one-line hint. Today it reads "Only also hides the direct read and search tools where the agent allows it…" (`SettingsSheet.tsx` ~398).
2. **Finish the Only rerun** with the fixed build: OpenCode Zen, Claude, Codex, plus a second TokenHarbor and PGS run. Then decide whether "Only" stays offered, given "on" is better everywhere.
3. **OpenCode "Web search cancelled"** (user pasted: `Tool websearch` input `{"query":"top technology news today October 212026"}` → Error "Web search cancelled"). Not found:
   - in any `unskilled.db` on this Mac (CubiQ, AI Harness, UnSkilled, scratch profiles);
   - in the OpenCode 1.19.3 binary's strings;
   - in our `src/`.

   Ask the user where they saw it (Windows PC? which build/agent?). Suspects: an ACP permission answered `cancelled` (`optionFor` returned null → `{outcome:"cancelled"}` in `acp/driver.ts` onRequest), or a turn abort (`session/cancel`) while the search ran.
4. Still open from the session-3 list: native PGS scripts call `tools.glob` without `pattern`, and Claude used grep `output_mode: "files"`. Consider accepting `"files"` as an alias of `files_with_matches`, and a clearer "missing pattern" error. Also items 5–7 there (Own worktree, /doctor, ShellDock polish, Windows run).
5. Push m4 when the user agrees.


## Resume here — 2026-10-21 (Mac, session 3)

m4 = `7383838`, pushed. All work merged; no open worktrees or branches. Commits this session:
- `90ee2df` **Review & merge** (live-tested): Push, the "Into ▾" target-branch picker, and Settings → Commit messages → Instructions. A target no folder has checked out merges in a throwaway worktree.
  - The default commit instructions are `DEFAULT_COMMIT_INSTRUCTIONS` in `shared/types.ts`: plain Conventional Commits, no AI filler. User: "human readable not ai slop", "easy to trace back". Merges get a `Branch:` trailer.
  - Fixed: Merge stayed disabled after Commit; diff/bar stale; scope toggle stretched.
- `257026a` **Code mode fixes** (from live runs and the benchmark below):
  - Scripts get **typed values**: `glob` → `string[]`, `grep` → `string[]` / `{path: count}` / `[{path, line, text}]`, `read` → raw text. `ToolContext.script` / `ToolResult.data`. Results that come back empty are `[]`, never prose. Past 5000 results the call throws, never a marker line.
  - **QuickJS leak fixed**: pending host promises are disposed before the context. It was the red "Aborted(Assertion failed: list_empty… JS_FreeRuntime)" plus unhandled `newError` rejections.
  - Child rows are capped at 40 per script plus one "Note" row (a Codex script had made 2279 rows).
  - `run_code` text says to batch: one grep `a|b|c`, then filter in JS.
  - Claude: `run_code` is `alwaysLoad` (it sat behind ToolSearch, so Claude never used it).
  - "Only": a PreToolUse hook turns away Bash `grep`/`rg`/`find`.
  - OpenCode: `onceMoreIfLocked` retries "database is locked" once.
- `4cc060e` + `7383838` **Track G, background shells** (plan `.ai/plans/m5-bg-shells.md`, approved):
  - `main/shells.ts` ShellManager: ring buffer, kills the process tree, 4 shells per thread and 12 app-wide, forgotten 1 h after exit.
  - `main/shell-tools.ts`: `shell_start`, `shell_output`, `shell_stop`, `shell_list`, bound to one thread.
  - Every agent gets them. Native in-process; Codex/OpenCode through `?s=<thread>` on the cubiq server; Claude through its in-process server, `alwaysLoad`.
  - **Claude's own background Bash is turned away by a hook** (`run_in_background`, a lone `&`, nohup, setsid, disown), toward `shell_start`. Verified live: Claude's own background task kept the SDK query (and so the turn) "running" for as long as the server lived, and Stop killed it.
  - Guide line in `resources/CUBIQ.md`; the guide is at its 600-token budget exactly.
  - `ShellDock` above the composer: chips, live output (read-only, polled 1 s), Stop, and × to hide.
  - Shells stop on thread delete, worktree removal, project delete and app quit (SIGTERM verified).

**Live-verified 2026-10-21** (dark theme, scratch profile, port 9466):
- Shells: Claude Sonnet 5.5, Codex GPT-6-Luna, OpenCode Zen `deepseek-v4.1-flash-free`, and the **native provider agent** with TokenHarbor `deepseek-v4.1-flash:free` and PGS Grove `deepseek-v4-flash-0731`. All used `shell_start`; the server ran on; the dock showed it. Stop and thread delete killed it.
- Third-party providers go through the **native provider agent, not OpenCode** (user, 2026-10-21). Set them up with `secret: {kind:"envRef", envVar:"TOKENHARBOR_API_KEY" | "PGS_API_KEY"}` and launch the app with `.env` loaded (`set -a; source .env`), so keys never appear in commands or files.
  - Base URLs: `https://tokenharbor.ai/v1`, `https://api.pgsgrove.com/v1`, wire `openai-chat`. They show as agents `provider-tokenharbor` / `provider-pgsgrove`.
- Cache: Claude's second turn hit 94.5% (68k read, 4k write).
- Full suite on the final branch: **3348 passed**, 0 failed; design:check 0 errors.

**Code-mode benchmark** (same task: "find exported functions/consts in src/shared/*.ts nothing imports", answer = 4 symbols; all runs found 4):

| Run | Cost | Time | Cache read | Out | Tool use | Red rows |
|---|---|---|---|---|---|---|
| Claude Sonnet off (before fixes) | $0.162 | 46 s | 186.5k | 3.5k | 5 Bash | 0 |
| Claude Sonnet off (after) | $0.237 | 53 s | 238.6k | 3.4k | 6 Bash | 2 (grep exit 1) |
| **Claude on (after)** | **$0.027** | **14 s** | 60k | 0.9k | 1 run_code | 0 |
| Claude only (after) | $0.092 | 21 s | 116k | 1.5k | 2 run_code + 1 Bash | 1 (hook deny) |
| Codex Luna off (after) | — (sub) | 32 s | 15k | 0.6k | 5 shell | 0 |
| Codex Luna on (after) | — | 81 s | 33k | 0.7k | 9 shell, no run_code | 0 |
| Codex only, before fixes | — | **187 s** | 46k | 0.5k | 20 run_code, **2279 child calls** | 6 |
| Codex only (after) | — | 68 s | 43k | 0.3k | 8 run_code, 110 children | 4 (script bugs) |
| PGS Grove (native) on | $0.016 | 207 s | 381k | 9.9k | 18 Bash + 1 run_code | 1 (`require` in sandbox) |
| PGS Grove (native) only | $0.006 | 71 s | 80k | 2.9k | 8 Bash | 0 |

Caveats:
- The free-model runs (OpenCode Zen, TokenHarbor, PGS off) are **invalid**. The driver's "turn over" check read the screen, so the next run started early and overlapped. Re-run them with the fixed driver (below).
- Codex token figures look like last-request usage, not per-turn totals; compare times only.

Benchmark tooling (scratchpad, gone after this session; recreate from here):
- New thread in project `cubiq` (a `git clone --depth 1` of this repo, registered by inserting a `projects` row into the scratch profile's `unskilled.db`).
- `window.unskilled.updateThread(id, {agent, model})`, then **verify the DB row before sending**. Code mode is set with `window.unskilled.updateSettings({codeMode})`; a thread fixes it at creation.
- Wait for a **new `turn-end` event in the DB** for that thread, not for on-screen text.
- Read usage from `events.payload` where kind = `turn-end` (`usage.cacheReadTokens`, `hitRate`, `costUsd`, `durationMs`).

**Next, in order:**
1. **Re-run the free-model benchmark** (OpenCode Zen, native TokenHarbor, native PGS Grove; off/on/only) with the DB-based wait. Run Claude on/only twice more to check variance.
2. **Red rows still seen:**
   - Code-mode hook denials show as errors. Mark Claude tool results whose text is `CODE_ONLY_DENY` / `BACKGROUND_BASH_DENY` as non-errors in `handleMessage` (claude.ts).
   - Claude's Bash `grep` with no match = exit 1 = red. Consider showing exit 1 from a `grep`/`rg` as "no matches", not an error.
   - Scripts calling `require` / non-functions. The `run_code` text could say "no require/import; only `tools.*`".
3. **Codex in "on" ignores run_code** (9 shell commands). It has no hook. Consider the CODE_ONLY_HINT-style fixed line for "on" too, or leave it (on = optional).
4. **Claude cost on a resumed turn looks cumulative.** Turn 2 showed $0.124 = turn 1's $0.099 + about $0.025 (its own tokens price at about $0.04). `turnEndFromResult` uses `total_cost_usd` (claude.ts ~735). Check whether the SDK's total is per-session on resume; if so, subtract the previous total. Unverified.
5. Untested from the M5 list: **A "Own worktree"** (Settings → Background → Own worktree, Alt+Enter); **D /doctor** "Prune worktrees" (safe). Its Run-fix buttons run real global upgrades (`claude update`, `opencode upgrade`, `npm i -g`): ask the user before clicking. Also review & merge with a picked commit model and co-author On.
6. ShellDock polish: match the composer's width (it sits slightly wider); a sidebar "1 shell running" hint (plan G2, not done); a Terminal-panel tab for a shell (plan G2; the inline dock was built instead).
7. Windows PC run for all of M5 and Track G (`taskkill` tree kill, Git Bash/PowerShell `shellFor`, `backgroundsItself` on PowerShell syntax). The user skipped it this session ("all except 5").

**Research (2026-10-21) behind the code-mode changes:**
- Anthropic, programmatic tool calling docs:
  - "Provide detailed descriptions of your tool's output format… Return structured data… Keep responses concise."
  - Strong fit: fan-out, big results to filter, agentic search. Weak fit: strictly sequential single calls, and a few small calls on the first turn.
  - Numbers: about 38% fewer input tokens on a 75-tool benchmark, +11% accuracy and −24% input tokens on agentic search, about 8% *more* cost on τ²-bench. https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- Anthropic, "Code execution with MCP": progressive disclosure (`search_tools` with detail levels), filter data in code, loops and control flow in code, keep state and skills. One example went from 150k to 2k tokens. Sandboxing has a real cost. https://www.anthropic.com/engineering/code-execution-with-mcp
- Cloudflare Code Mode: MCP tools become a TypeScript API in a V8 isolate per snippet, with no network. Bindings carry credentials, and results come back via `console.log`. No measured numbers. https://blog.cloudflare.com/code-mode/
- CodeAct (ICML 2024): up to +20% success and 30% fewer actions on multi-tool tasks; the gains grow with model strength. https://arxiv.org/abs/2402.01030
- Command Code ("commandcode"): only a directory listing found; it has a "background sandbox mode", no isolation details. Our `run_code` already runs in a QuickJS WASM sandbox (no fs, network, process or timers; tools only through the thread-scoped broker). OS-level sandboxing of shell commands (Claude Code's seatbelt/bubblewrap style) would be a separate feature; ask the user if that's what they meant.
- Takeaways applied: typed results, documented return types (`describeTool` shows `Promise<string[]>`), batching guidance, `alwaysLoad`. Still to try: `search_tools` detail levels for big MCP sets; a fixed "no require/import" line.

## Resume here — M5 (2026-10-20, Mac, session 2)

Plan, status, next tasks and probe tools: **`.ai/plans/m5-five-tracks.md`** (sections "C0 probe results" and "Status at handoff").

**All five tracks are MERGED into `m4`** (user: "just merge all wt", 2026-10-20). Order oc2 → code → doctor → bg → merge, done in an integration worktree `../aiharness-wt/m5-all` (branch `m5-all`), then m4 fast-forwarded to `0b209dc` and pushed.
- Conflicts resolved, all additive:
  - `test/commands.test.ts`: m4 dropped ask/auto-edit/full, doctor adds `doctor`.
  - `settings.ts` / `types.ts` / `store.ts`: agentBinary + background.
  - `db.ts`: `setWorktree(branch: string | null, …, base)` + `clearWorktreePath`.
  - `index.ts` / `preload` / `mock.ts`: doctor + worktree IPC.
  - `service.ts`: chats import + git imports.
  - `SettingsSheet.tsx`: Threads = New threads, Commit messages, Background, Editor.
- One semantic fix in the merge: the Review & merge bar shows only when the thread has a branch (`DiffPanel.tsx`). m4's Chats give chat threads a `worktreePath` with no branch.
- Checks on the merged result (Claude-run): typecheck green, `design:check` 0 errors (48 baseline warnings), full `bun run test` **3309 passed** / 0 failed. The merged app launched (welcome screen with Chats, doctor IPC answers).
- The track worktrees and branches (`m5-{oc2,code,doctor,bg,merge,all}`) were removed after the merge (all clean and contained in m4).

**2026-10-21 (Mac, session 3): item 1 done, `90ee2df` on m4 (pushed).** B clicked through live (Generate, Commit, Squash merge, Remove, conflict + dirty-project refusals, Chat thread has no bar). Fixed: Merge stayed disabled after Commit (message was cleared; now kept, with a hint), diff/bar stale after Commit/Merge/Remove/Refresh, scope toggle stretched full width. Added (user asks): **Push** (`git push -u`, no credential prompt, 60 s), **target-branch picker** "Into ▾" (a branch no folder has out is merged in a throwaway worktree; the project folder never switches), Settings → Commit messages → **Instructions** (default `DEFAULT_COMMIT_INSTRUCTIONS` in `shared/types.ts`: plain Conventional Commits, no AI filler; user: "human readable not ai slop"), and a `Branch: <thread branch>` trailer on merges. Live: Claude, Codex GPT-6-Luna and OpenCode Zen DeepSeek turns OK on this build. Not yet: picked commit model + co-author On live; target list also shows other threads' `harness/*` branches (kept; hide if the user asks).

**Untested in the live app, on the merged m4 (do these first at home):**
1. ~~B, worktree review & merge~~ (done 2026-10-21, see above).
2. **The combined build, end to end:** live turns on all three agents done 2026-10-21; still to check: code mode on (Settings → Agents & Providers) → `run_code` with child rows; OpenCode v2 `execute` rows show the "Code" section (m5-code's own run lacked it until oc2 merged).
3. A: "Own worktree" (Alt+Enter starts in a worktree) was not tried live; Run at once / Stop / Stop all were.
4. D: the Run fixes (`claude update`, `opencode upgrade`, `npm i -g …`) and "Prune worktrees" were not clicked live.
5. Windows PC run for all of M5 (doctor's `where`/`.cmd`, worktree merge, the v2 plugin dir URL, code mode paths).

Done this session (Claude-verified: typecheck, full `bun run test` green on all 5 branches, 3149–3189 tests each, 0 failures):
- **C2** (`m5-oc2` `fd98726`):
  - v2's Code Mode `execute` shows as a `run_code` row: its script under a "Code" section, and one child row per call from `rawOutput.metadata.toolCalls`.
  - `opencode session export <id> --standalone` (v2) has flat `type:"assistant"` messages. `sumExportUsage` reads them, and the sum matched the ACP prompt usage exactly.
- **E2** (`m5-code` `2f9d927`, `d100e26`, `81b994f`):
  - `run_code` on the cubiq MCP server: the `?c=<threadId>` URL flag, put on by the driver; Claude gets it in-process.
  - One broker for native and MCP (`harness/tools/code-broker.ts`, ≤8 in flight).
  - Read-only script tools: read/glob/grep scoped to the thread's folder, the read-only app tools, search_tools.
  - Child rows nest via `Service.scriptParent` (matches the open run_code row by its code).
  - OpenCode 2+ is skipped (`hasOwnCodeMode`). Code mode is fixed per thread for the app run (`codeModes`).
  - Settings → Agents & Providers → Code mode: Off / Read-only + MCP / Only.
  - "Only": native hides read/glob/grep. Claude hides Grep/Glob only, because its Edit needs Read. Claude and Codex get one hint line.
- **D** (`m5-doctor` `6629f62`): a pinned agent now offers "Use the newest automatically" (drops the pin).
- **Live, dark theme** (own worktrees, scratch `--user-data-dir`, port 9466):
  - C: v1 1.19 Ask card + Deny blocks. v2 2.1.0 (its bin dir first on PATH, isolated `XDG_*` dirs) Ask card + Deny blocks, and `execute` renders as run_code with child rows.
  - E: run_code with nested Grep/Read on Claude sonnet, Codex GPT-6-Luna and OpenCode v1 Zen.
  - D: /doctor finds Claude ×3 and OpenCode ×3; pin, re-check, unpin.
  - A: Run at once = 2 → the third Alt+Enter shows "Queued", Stop on one row admits it, Stop all works.
  - B: **not live-tested** (see the Untested list above).

Found, not fixed:
- Claude in "Only" still searches with Bash `grep`, even with the hint. Its Bash can't be hidden, the same as Codex.
- Several OpenCode threads starting at the same instant → "database is locked" (OpenCode's own startup race). Stagger the starts, or retry once on that error.
- The "Code" input section for run_code (renderer) came from m5-oc2. It is now in m4 for native, MCP and v2 rows; check it live (Untested item 2).

**Next:** (1) the Untested list above, on merged m4. (2) **Track G, background shells** (user: "i ask it to run docker or project … like claude code shell bg"): plan below (also in `.ai/plans/m5-bg-shells.md` on the work Mac), awaiting approval. Track A (background *threads*) stays as built. The full M5 plan `.ai/plans/m5-five-tracks.md` is also on the work Mac only; this section carries what's needed.

### Track G plan: background shells (draft, awaiting approval; copied from `.ai/plans/m5-bg-shells.md`, which is gitignored)

Status: **draft, awaiting approval** (2026-10-20). User: "background shell example i ask it to run docker or project … like claude code shell bg". Track A (background *threads*) stays as built.

#### What the user wants
The agent starts `docker compose up`, `bun run dev`, a watcher… The command keeps running after the tool call returns. The thread shows it as a live background shell: name, status, latest output, Stop. The agent can read its output later and stop it.

#### Evidence (2026-10-20)
- **Claude**: Claude Code's Bash already has `run_in_background`, plus BashOutput / KillShell. CubiQ shows the rows but has no place to watch the output or stop the process. Team threads turn it off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `agents/claude.ts:476`).
- **Native agent**: `harness/tools/bash.ts` has no background mode. `server &` only returns early (`bash.ts:162`, a 250 ms grace after exit); the job is orphaned and invisible.
- **Codex**: only `commandExecution` items (`agents/codex.ts:29`). There's no background-terminal API we use.
- **OpenCode v1/v2**: its shell tool blocks until the command exits or times out.
- The Terminal panel's PTYs: `src/main/terminal.ts` (`TerminalManager`, 75 lines: write/resize/close/dispose).
- The cubiq MCP server already carries per-thread tools to every engine (`mcp-http.ts`, `?t=`/`?c=`; see Track E), so one tool set can reach all engines.

#### Design (proposal)
1. **CubiQ-run shells**, `main/shells.ts`: `ShellManager` with `start(threadId, cwd, command, name?)`, `output(id, {since?, tail?})`, `stop(id)`, `list(threadId)`. Each spawn uses the native bash runner's shell choice (`shellFor`, Windows PowerShell/cmd parity) in the thread's folder or worktree. Output goes to a ring buffer (≈256 KB per shell) plus a log file under userData. The whole process tree is killed (`killTree`) on Stop, thread delete, worktree removal and app quit.
2. **Tools** on the cubiq server, for every engine, and in the native loop:
   - `shell_start({ command, name? })` → `{ id, name }`, returns at once;
   - `shell_output({ id, tail?, since? })` → new or last lines, plus status and exit code;
   - `shell_stop({ id })`.

   Permission: `shell_start` is a shell call. It asks in Ask mode and goes through the git guardrail (`checkCommand`), like Run. Output and stop are reads.
3. **Claude's own background Bash**: map its `run_in_background` rows and BashOutput/KillShell into the same model where the SDK exposes the shell id. Otherwise leave them on Claude's own tools and just label the row "Background".
4. **UI**: a "Background shells" strip above the composer for the selected thread: one chip per shell (name · running/exited · uptime), click → its live output in the Terminal panel (read-only tab) with Stop. The sidebar's Running row shows "1 shell running". DESIGN.md row/chip patterns; dark screenshot.
5. **Limits**: at most 4 live shells per thread and 12 app-wide (refuse with a clear message); idle output kept 1 h after exit.
6. **Prompt**: one fixed guide line, "for servers and watchers use shell_start, not `&`", the same every session (cache-safe).

#### Phases
- G1 main: ShellManager + tools + tests (real child processes; a Windows path test).
- G2 UI: strip + Terminal tab + sidebar hint.
- G3 Claude background-Bash mapping.
- Live: on Claude, Codex, OpenCode and native, start `python3 -m http.server`, read its output, stop it, delete the thread → process gone.

#### Questions
1. Should the shells also show in the Terminal panel as interactive PTYs, or read-only output only? (Recommend read-only plus Stop; interactive input is out of scope.)
2. Keep processes alive across an app restart? (Recommend no: kill on quit and say so.)



# Handoff: TGP closed (2026-10-17) — all 6 open items done, live on OpenCode, Codex and Claude, m4 pushed — see "Resume here — session 7"; next: Windows PC run

## Resume here — session 7: TGP closed (2026-10-17, Mac)

Commits on `m4`, pushed (`edd8887`); CI run 39005818223 green on windows-latest + ubuntu-latest.
- `a85a8e2`, the 6 open TGP items:
  1. **Member skill files.** Native members already read them: reads are never path-guarded, member child loops auto-authorize, and the member prompt lists absolute SKILL.md paths. Pinned in `harness-tools-rw` / `harness-loop` tests. OpenCode reads them through `withOpenCodeReadDirs`.
  2. **Strip progress.** `doneMembers` + `stripStatus` in `TeamStrip.tsx`: "1 working · 2 of 3 done", "Lead working · 3 of 3 done". The count resets at each user message.
  3. **Member click → latest result.** `team_write` records `{from, at}` in `index.json` beside the files. The `team:member-file` IPC calls `latestFileBy` and copies the file into the version store as `cubiq:team/<name>.md` (a pseudo artifact, `shared/artifact-kind.ts`). The strip's members are buttons that open it in the File panel; a member with no result opens nothing.
  4. **Portrait tints.** Tokens `--portrait-1..6` (light + both dark blocks). The line-art's white ground multiplies into the tint (`.team-strip-tint`). Strip only; the Library team sheet is untouched.
  5. **Calculator with a broken formula.** `CalculatorSpec.problem` ("unknown P, r, n", "the formula doesn't parse", "no formula"): the inputs render with a "Couldn't compute: …" line. Valid calculators are unchanged.
  6. **Engine text-shape tests** (`test/engine-text-shapes.test.tsx`): Claude blocks, Codex deltas, ACP split fences, CRLF. They found a real bug: a streaming reply ending exactly at its closing fence stayed "Building…". Fixed in `splitStreamingTail`.
- `edd8887`:
  - **Codex members' skill reads no longer ask.** Codex reads with the shell, so in Ask mode each `cat SKILL.md` showed an approval card (user: "it ask for approve"). `agents/skill-read.ts` `isSkillRead` auto-accepts one plain read (cat/head/tail/sed -n/ls/wc, PowerShell Get-Content/type) of an absolute path inside `expertRoot`: no shell syntax, one operand. Verified live: Owen's read ran with no card.
  - File cards for team results say "Team result", not "cubiq:team/".

**Checks at `edd8887`:** typecheck green, **2552 passed**, `design:check` 0 errors (48 baseline warnings).
**Live (dev app, dark):**
- OpenCode Zen DeepSeek V4.1 Flash Free: progress line, tints, Dana click → `dana-yaml-facts.md`, members opened their own SKILL.md, watchdog notice at 3 min.
- Codex GPT-6-Luna: members labelled, all three SKILL.md opened, Victor click → `cross-verifier-toml-check.md`.
- Claude Sonnet 5.5: 3 of 3 done, ui:calculator rendered.
**Worker:** 1 implementer on Zen DeepSeek free wrote item 6's tests in a worktree. Claude fixed its ACP-split case (a missing newline) and the streaming bug it surfaced. Claude did items 1–5 directly (each 1–4 files).

**Windows PC run, still to do:**
- team-runs / `index.json` paths
- `isSkillRead` with a real Codex-on-Windows command shape (the PowerShell wrapper regex is a guess; check the approval card's text)
- Deep Research skills paths
- the watchdog
- the tints in both themes

**Found, not fixed:**
- **OpenCode sub-agent permission asks hang the turn.** Seen when a member `glob`s from the home folder: `external_directory /Users/phumrin/*`, in OpenCode's log as `permission=external_directory ... action=ask`. The app shows "OpenCode is waiting for a permission it can't ask here" and the watchdog fires, but the only way out is Stop. It came from my prompt telling the lead to make members "find" their skill. With the path given ("in your skills list, no searching") it never recurs. Option: answer such child asks with reject so the member gets an error and goes on.
- The OpenCode lead can't see members' skill paths (they're only in member prompts), so it may search for them itself.
- The Library team sheet still says "Members work as subagents on Claude and OpenCode; other agents run the team as one agent". Codex has member roles now.
- Driving the Library left a few empty "New thread" rows in posara_web.
- Carried over: the model picker keeps its search text across opens; experts load once per renderer; the ~1% context ring looks like a spinner.


## Resume here — session 6: teams like WorkBuddy + UI blocks on every engine (2026-10-17, Mac)

Plan: `.ai/plans/team-genui-parity.md` (approved; its "Status 2026-10-17" section has the live matrix). Commits on `m4`, **not pushed** (last push still `e0d7337`): `c450214` (UI blocks), `3a86ce7` (teams).
- **UI blocks (`c450214`)**: before, 1–2 of 4 blocks showed as raw code on every engine. Now all 4 render on Claude Sonnet 5.5, Codex GPT-6-Luna, OpenCode Zen DeepSeek Flash Free, OpenCode AgentRouter deepseek-v4-flash and native (TokenHarbor free model; the Pass is exhausted, never flip pay-as-you-go).
  - chart: negatives diverge from a zero line
  - compare: per-cell `*` best marks (`best: [row, col][]`); ragged rows padded or trimmed; `*italic*` left alone
  - formula: `^`/`**`
  - calculator: `=name = expr` prefix stripped; empty starting values become blank inputs; results ≤2 decimals when ≥1
  - streaming: "Building…" also after prose (`streaming.ts` UI_FENCE boundary)
  - the note now says "max 2 unless asked" (≤150-token budget in `test/guide.test.ts`)
- **Teams (`3a86ce7`)**:
  - Lead protocol (`shared/experts.ts`): phases, scope split, no ghostwriting, single-member routing, plus a "Stay <name>" anchor line.
  - Star topology (`experts/team.ts`): members `team_post` to the lead only; the peer cap is gone.
  - Codex member rows: Codex sends **no thread/started for spawned children** (probed; memory `codex-child-threads`), so `registerChild` holds a team turn's Agent row until `thread/read` returns `agentRole`. The child's first `item/*` or its end emits the row unlabelled.
  - Codex roles carry `maxTurns` as a sentence.
  - `SubagentCard`: member portrait + name + profession; the empty Prompt fold is hidden.
  - `TeamStrip`: the lead lights up while the turn runs and no member works; a working agent wears the send button's `<Beam />`.
  - Stall watchdog (`main/watchdog.ts`, wired in `service.ts`): a notice after 3 min of silence, Stop after 10. Time on permission, plan or question cards is excluded.
  - **Deep Research Team** (built in, original English content): `resources/experts/deep-research-team/`, members `deep-researcher`, `cross-verifier`, `idea-validator`, `insight-editor`, each with its own skill (`deep-dive`, `cross-check`, `demand-check`, `insight-brief`) and portraits.
  - The imported Research Insight was removed at the user's request (user: "i want it as my own").

**Checks at `3a86ce7`:** typecheck green, **2538 passed**, `design:check` 0 errors (48 baseline warnings). Live team runs labelled members on Claude, Codex, OpenCode Zen and AgentRouter.
**Workers:** 2 researchers + 3 implementers on Zen DeepSeek free (worktrees). W3's Codex fix used `thread/started` and passed its fake-server test, but did nothing live. Claude replaced it with the thread/read approach and made the test probe realistic.

**Open — the 6 TGP items left (in this order):**
1. **Member skill files readable on native (verify Codex).**
   - `service.expertInput` returns `expertRoot` (`service.ts` ~289), but only Claude (`agents/claude.ts` ~429 skill roots) and OpenCode (`index.ts` ~611 `withOpenCodeReadDirs`) use it.
   - Native members' read tools are path-guarded (`harness/tools/paths.ts`), so they can't open their own `SKILL.md`. Built-in teams' skills sit under `resources/experts/<team>/skills/`.
   - Add the root to the native read roots for team threads only. Check live that a Codex member can open its SKILL.md too.
2. **Phase progress in the strip** ("2 of 3 done").
   - `TeamStrip.activeMembers` only tracks in-flight calls. Also count member Agent rows that finished in the current turn (events after the last user message).
   - Keep "Lead working" / "N working".
3. **Click a member → its latest result file.**
   - The workspace is `<userData>/team-runs/<threadId>/` (`teamRunDir`, `index.ts` ~503). Models pick free file names (`dana-json-facts-a.md`), and `team_write` stores no author.
   - Record `from` per file (e.g. an `index.json` beside `notes.jsonl` in `experts/team.ts`), then open the newest file for that member in the File panel.
4. **Distinguishable portraits.** All Notionists busts look alike in the strip. Give each member a tinted round background from tokens (use the `token-change` skill for any new token; DESIGN.md §2).
5. **Calculator with a broken formula.**
   - `validate.ts` `validateCalculator` still returns null (raw code) for unknown ids or a malformed formula, e.g. DeepSeek's `P * r/12 …`.
   - Render the inputs plus an inline "Couldn't compute: unknown P, r, n" line instead. Pin that valid calculators are unchanged.
6. **Per-engine text-shape fixtures** (never written; the live runs covered it). Feed `Markdown` (streaming and final) a ui fence the way each engine delivers text:
   - Claude: text blocks split around tool calls
   - Codex: agentMessage deltas, then the final item
   - ACP: chunk accumulation
   - CRLF

   Assert the blocks render.

Then: one live turn each on Claude, Codex and OpenCode. Push `m4` + CI (`gh run list --branch m4 --limit 1`; the Windows acp flake → rerun the failed job). Windows PC run: team-runs / codex-roles paths, the Deep Research skills paths, the watchdog.

**Found, not fixed (outside the plan):**
- The model picker keeps its last search text across opens, so "OpenCode switch" etc. can be filtered out of a new thread's picker.
- The renderer loads the expert list once (`store.loadExperts` when null): a bundled team added while the app runs needs a reload. Dev-only in practice.
- The lead ghostwriting a member's file can't be enforced in code. Seen once on OpenCode's default model; the prompt rule covers the rest.
- AgentRouter returns "sensitive words detected" on some calls. OpenCode retries and the turn finished; the watchdog covers a hang.
- The context ring at ~1% looks like a loading spinner.

Updated 2026-10-13 on the **Mac**, branch `m4`. Read **Resume here — harness best practices (2026-10-13)** first (plan `.ai/plans/harness-bp.md`, research `plan/docs/12-harness-best-practices.md`), then **Resume here — Design v2 Mac test (2026-10-13)**, then **Resume here — Design mode v2** (plan: `.ai/plans/design-mode-v2.md`, Windows PC only), then **Resume here — native agent N2** (plan: `.ai/plans/native-agent.md`), then **Resume here — D4 done, Design mode complete**, then **Resume here — D3 done, D4 next**, then **Resume here — D2 done, D3 next**, then **Resume here — D1 done, D2 next**, then **Resume here — D1 next** (its plan), then **Resume here — P3 done**, then **Windows gate (2026-10-07)**, then **Resume here — C0 + P2 done**, then **Resume here — P1 done, next P2**, then **Resume here — MCP, providers, Design mode**, then **Resume here — Plan mode v2**, then **Resume here — UI refresh**, then `DESIGN.md` (the design system every UI change follows), then `.ai/plans/ui-refresh.md` (phases U0–U6, evidence, blast radius; `.ai/` is gitignored, so it exists on this Mac only), then `CLAUDE.md`. Approved mock: https://claude.ai/artifact/TNGyM5xqgZcrJZne7zdYHN (direction A, "Ink Flat"). Older roadmap: `.ai/plans/harness-roadmap.md`. Memories that apply: `commit-style` (≤150 chars, no attribution trailer, `rm .ai/tmp/*` per phase), `test-app-for-real` (live turn on OpenCode, Codex **and** Claude before every commit), `oc-dispatch-mac`, `context-no-bloat`, `two-machines`, `secrets-handling` (every stored credential safeStorage-encrypted; test keys only in the gitignored `.env`, never in briefs/commits).

## Resume here — session 5: EX4, DM3 Code tab, Present shell (2026-10-16, Mac)

Commits on `m4`, **not pushed** (last push `e0d7337`): `1b477ae`, `87c29f3`, `594c048`. Plans: `.ai/plans/design-expert-center.md` (approved), `.ai/plans/dm3-code-tab.md`.
- **EX4 skill roots (`1b477ae`)**: `SkillCatalogs.forProject(cwd, expertDirs)` adds an `expert` layer (origin `"expert"`, label "Expert") after the project's folders and before the app-wide ones, so the user's own skills win a name. `experts.skillsDir(id)` = a folder expert's `skills/` (null for a bare `<id>.md`). `main/index.ts` `expertSkillDirs(threadId)` / `skillsFor(cwd, threadId)` / `skillsKey(...)`; the thread id reaches Claude `pluginDir`, Codex `skillsDir`, the tool server's `?t=`, the native `skills` hook, `Service.catalogFor` (composePrompt) and the context preview. A thread without an expert gets the same catalog and the same plugin/skills-folder hash as before (no cache change).
  - Live: Research Insight threads on Claude (sonnet), Codex (gpt-6-luna) and OpenCode (Zen deepseek-v4.1-flash-free) all listed the package skills (deep-research-agent, company-research, insight, the validators); a plain Claude thread didn't.
- **DM3 Code tab (`87c29f3`)**: a file picker (IPC `design:files` → `listDesignFiles(root)` in `main/design/pages.ts`: text files ≤3 folders deep, no dot dirs/node_modules, "/" paths, pages first, cap 200), a line gutter, and syntax colours from `design/highlight.ts` (hand-written lossless html/css/js scanner; Claude fixed a hang on a stray quote in a tag and made number matching non-quadratic). New tokens `--syn-keyword/string/number/comment` (light + dark, each ≥4.5:1 on --bg and --bg-subtle; attributes use --text-secondary). `highlight.ts` is listed in `tsconfig.node.json` so tests can import it.
- **Present (`594c048`)**: Present reuses the canvas device shell (mobile → phone, tablet → tablet, desktop → browser window; slides keep the plain frame), scaled with the bezel. The canvas's browser-frame chrome now counts its 1px border, which removes a stray 2px horizontal scrollbar. Tablet and browser frames checked visually in dark theme.
- **Uncommitted**: `resources/skills/design-mobile/SKILL.md` §4 now tells the agent to declare 2–4 tweaks with the `#cubiq-tweaks` manifest (not in the Quick tier). Cause: mobile pages only had loose `--t-*` vars, so the canvas never showed a Tweaks tab. A Claude turn on board-proj thread `42d812ce…` was asked to add tweaks to `02-home.html` per the skill; **check its result first**: `grep -c cubiq-tweaks <board-proj>/designs/42d812ce/02-home.html`, then the Tweaks tab, then commit the skill.

**Checks at `594c048`:** typecheck green, **2340 passed**, `design:check` 0 errors (48 baseline warnings). Elements tab live-checked (layer tree with ids/classes).
**Workers:** 3 implementer dispatches on Zen DeepSeek free (EX4 hooks + tests; DM3 main side; DM3 renderer), all exit 0; Claude reviewed each diff and fixed the issues above.

**Next (in order):**
1. Finish the live check: Tweaks tab on `02-home.html` (after the skill turn), then inspector **Apply writes the file** (Working tier, an element with `data-agent-id`, e.g. `#home-greeting` font-size → Apply → the file changes). Commit the design-mobile skill.
2. One final live turn each on Claude, Codex, OpenCode (code changed after the EX4 run), then push `m4` + CI (`gh run list --branch m4 --limit 1`; the Windows acp flake → rerun the failed job).
3. Windows PC run: importer paths, capture zoom, device shell + Present, System tab (copy-on-write paths), `design:files` paths.

**Found, not fixed (outside the plan):**
- Canvas header: with a narrow canvas the Page picker shrinks to ~20px (`.design-canvas-title` gives way, `.design-tools` don't). Needs an overflow menu for the tools: a design decision.
- Artifact panel preview of a design page renders without its linked `system/tokens.css` (unstyled). One "File not found" on a file card didn't reproduce.
- ArtifactPanel `SourceView` still has no syntax colours (DESIGN.md §129); `highlight.ts` can be reused there.

## Resume here — DM5 done, live-tested (2026-10-16, Mac, session 4)

Plan: `.ai/plans/dm5-system-editor.md` (under the approved `.ai/plans/design-expert-center.md`). Commit `7d1b4b8` on `m4`, **not pushed** (last push `e0d7337`).
- **DM5 System tab** (inspector: Properties | Elements | Code | System | Tweaks): DESIGN.md (rendered, Edit/Save), Colors (Light/Dark hex with swatches, WCAG badge per ink token: `--color-on-X` vs `--color-X`, `*text*` vs `--color-bg`), Type, Space, Radius, Shadows, Other. Commit on blur/Enter, Esc reverts.
  - main: `design/tokens.ts` (`parseTokens`, `setToken`, which rewrites only that declaration; a dark value with no override is inserted or a dark block appended), `systems.ts` `forkSystem` (a built-in → `<project>/.agents/design-systems/<id>-custom/`, an existing copy is reused), `service.designSystemDoc` / `editDesignSystem` (fork + switch the thread, write, then `materializeSystem` into `<design>/system/` so the watcher reloads the canvas and the next turn doesn't announce a switch), IPC `design:system-doc` / `design:system-edit`.
  - renderer: `design/SystemPanel.tsx`, `design/contrast.ts`; the picker re-reads on a value change.
- **Board mobile sizing**: `pageDevice()` (main/design/pages.ts) reads `<meta name="cubiq-device" content="mobile|tablet|desktop|slide">`, else treats a one-screen phone page as mobile (status bar + home indicator or tab bar, at most one `.phone`, no `.board`). `design:entry` returns `pages[].device`; `parsePage(rel, url, device)` prefers it. The design-mobile and design-prototype skills tell the agent to add the meta. Board artboards hide the page scrollbars (`device-chrome` on load).
- **EX2 leftover**: the composer's expert chip has a × while the thread has no messages (`setThreadExpert(id, null)`).
- **User-reported fixes**: the "Crafting…" waiting line now sits right under the last message (sticky at the bottom of the scroller, not docked below it); the + → Skills flyout was full-window wide (no max-width on `.goo-submenu`) → capped at 360px.

**Checks at `7d1b4b8`:** typecheck green, **2327 passed**, `design:check` 0 errors (48 baseline warnings).
**Live (dev app, CDP 9455):** System tab in dark theme (screenshots); editing `text` dark → canvas recoloured live, `clean-custom` created, a one-line diff vs the built-in, picker and panel switched live; Board shows the 2 mobile pages portrait without scrollbars; Claude design turn added the meta to both pages; Codex (GPT-6-Luna) and OpenCode (Zen DeepSeek V4.1 Flash Free) answered; expert × removes it.
**Workers:** 2 researchers + 2 implementers (tokens/fork in a worktree, SystemPanel in the main repo) on Zen DeepSeek free, all exit 0. Claude fixes after them: panel reload flicker (refresh in place), badge squeezing the hex field, markdown sizing, the reload on a system switch.
**Test data:** board-proj now has `.agents/design-systems/clean-custom/` (tokens reverted to the built-in values) and its thread uses it; both pages carry the cubiq-device meta.

**Still open (in order). This is everything left in the whole design + expert plan: DM1–DM5 and EX1–EX5 are built and live-tested apart from these:**
1. **EX4**: an imported expert's package `skills/` (`userData/experts/<id>/skills/<name>/`) still don't join the skill roots for that expert's threads. It needs a per-thread layer in `SkillCatalogs.forProject` and the thread passed at every `skills.forProject(cwd)` call in `main/index.ts` (286, 290, 397, 506, 536, 710, 737). Keep it scoped to that expert's threads (memory `experts-manual-only`).
2. DM3 leftovers: the Code tab has no syntax highlighting and no file list.
3. Present mode (`Present.tsx`) still has its old thin border (reuse `.device-shell`); the tablet and browser device frames haven't been checked visually.
4. Push `m4` + CI (`gh run list --branch m4 --limit 1`; the acp flake → rerun). Windows PC run: importer paths, capture zoom, device shell, System tab (copy-on-write paths).
5. Live-check left from session 2: Elements/Tweaks tabs and inspector Apply writing the file.

## Resume here — EX5 + DM4 done, live-tested (2026-10-16, Mac, session 3)

Plan: `.ai/plans/design-expert-center.md` (approved; user wants no approval stops). Branch `m4`, **not pushed** yet (last push `e0d7337`). Commits this session:
- `7af12e6` **DM4 groundwork**:
  - `design:capture` (a window rect → a PNG ref in the design's `refs/`, returns path + thumb)
  - `design:restore-version` → `service.restoreDesignVersion` (saves the current page as a version first, then writes vN as newest)
  - store `pendingRefs` / `addDesignRefs` / `takeDesignRefs`; the Composer takes them as reference chips
- `afedb9c` **EX5 teams runtime**:
  - `teamAgents(def)` (shared/experts.ts) drops reserved engine names, bad ids and duplicates
  - `TurnInput.team`; `service.expertInput(thread)` replaces `expertOf` at all 3 sites
  - Claude → SDK `agents`; OpenCode → `withOpenCodeTeam` (agent.<id> subagent) via the ACP `injection` ctx (`team`, `teamLead`). The process is per thread, so the team never leaks to other threads.
  - capability `subagentTeams` (Claude, OpenCode preset); other agents get a one-time notice "runs as one agent on X" (`noteTeamFallback`)
  - `clipAgentSummary` keeps the member id in "desc · id" summaries
  - `TeamStrip.tsx` above the composer (lead + members; lit while its Agent tool-use has no result); cost note in the team detail
- `b6681f2` **DM4 UI** (worker + Claude fixes): a floating tool bar (Select, Edit text, Comment [Real app tier only], Draw), `DrawOverlay.tsx` → Attach (capture → composer chip), a device-frame toggle, and "Restore this version" in the version bar
- `c470ec3` **EX5 fix, found live**: the user's global opencode `default_agent: orchestrator` has `permission.task {"*": deny, …}`, so the members were hidden. `withOpenCodeTeam` now also adds `task: {<member>: allow}` to the lead agent (the session mode) and to `build`; OpenCode merges these after the agent's deny (verified with `opencode agent list`).
- `a69bb24` **DM4 live fixes** (the user called the first frame ugly and broken):
  - a real `.device-shell` (tokens `--device-bezel/edge/island`: graphite in dark, so it's visible), dynamic island, home bar and browser bar. The shell is always mounted (`.device-off { display: contents }`), so toggling doesn't reload the frame.
  - Fit fits the whole device (`frameLayout(..., whole)`)
  - the bridge's `device-chrome` message hides the page scrollbar
  - fixed a blank frame after Board → page: the iframe src effect now keys on the mounted element (`frameMount` callback ref), and the stage ResizeObserver is a callback ref (it was stale → a 1px frame on Mobile)
  - `design:capture` multiplies by `getZoomFactor()` (the capture was offset)
  - the design-mobile SKILL: a one-screen page is the screen (no bezel), bars pinned, only `.screen` scrolls. DESIGN-MODE.md is at its 700-token budget; don't add to it.

**Checks at `a69bb24`:** typecheck green, **2298 passed**, `design:check` 0 errors (48 baseline warnings).

**Live (dev app, CDP 9455):**
- Claude (Sonnet 5.5) team turn: the strip showed "1 working", and the step read "CSV history facts · deep-researcher"
- OpenCode (Zen DeepSeek V4.1 Flash Free) team turn: the member ran as a real subagent ("· deep-researcher") after `c470ec3`
- Codex (GPT-6-Luna): the one-agent notice showed and the turn answered
- Design (Claude Sonnet 5.5):
  - the 2-screen prototype was built and the agent pinned its bars per the new skill rule
  - phone frame screenshot OK
  - Draw → Attach → `refs/ref-3.png` = exact frame + stroke
  - Restore v1 → newest v3, file matches
  - Board ↔ page ×4 stays loaded

**Test data:**
- board-proj's folder was recreated at `/private/tmp/claude-501/-Users-phumrin-Documents-ai-agent-aiharness/974ddb30-…/scratchpad/board-proj` (the sidebar still says "Folder missing" until restart)
- extra empty "New thread"s and "Small test of the team" threads in posara_web/board-proj; delete them if you like

**Still open (next session, in order):**
1. **DM5** (design-system viewer/editor): not started. See the plan's Track DM.
2. **Board artboards for one-screen mobile pages render landscape** (desktop-size thumbnails), seen live. The Board should size them as mobile (meta `cubiq-section` / viewport detection in `design/pages.ts` / `board-layout.ts`).
3. Device frame not yet checked visually for tablet and browser (only phone screenshots). The Present mode (`Present.tsx`) still has its old thin border; consider reusing `.device-shell`.
4. DM3 leftovers: the Code tab has no syntax highlighting and no file list. EX2: no "×" on the chip. EX4: package `skills/` don't join the skill roots for that expert's threads (`main/skills/sources.ts`; imported skills live at `userData/experts/<id>/skills/<name>/`).
5. Push `m4` and check CI (`gh run list --branch m4 --limit 1`; the acp flake → rerun). Windows PC run (memory `two-machines`): importer paths, capture zoom, and the device shell.
6. Live-check left: the Elements/Tweaks tabs and inspector Apply writing the file (from session 2), and "+" → Experts/Skills.

**Workers this session:** 2 researchers and 2 implementers (TeamStrip, DM4 UI) on `opencode/deepseek-v4.1-flash-free` in parallel worktrees, all exit 0. Fixes Claude made after them: the DM4 Comment tool reopening the form after Cancel, tooltip text, the `.ts` → `.tsx` test rename, and every live-found bug above. `.ai/tmp` holds `dispatch.sh` (worktree runs) and `run.sh` (main-repo runs).

## Resume here — partial phases finished: DM3, EX2, EX3, EX4-UI (2026-10-16, Mac)

Plan: `.ai/plans/design-expert-center.md` (approved). Branch `m4`, **pushed** at `e0d7337`. A CI run was started on push; check it with `gh run list --branch m4 --limit 1`, and if `test/acp.test.ts` times out alone, rerun it (memory `ci-windows-acp-flake`).

**Commits this session:**
- `73e45f8`, **Windows gate fix:** `test/db.test.ts` "restores a thread without its expert" never closed its Store, so on windows-latest the temp db unlink failed with EBUSY. CI then went green (run 38835034280).
- `d260bca`, **backend for the expert UI:**
  - `threads:set-expert` → `service.setThreadExpert`, which refuses a thread that already has events (keeps the prompt-cache prefix)
  - `experts:pick-source` (folder or .zip dialog)
  - `ExpertDef` gains `sourceUrl`, `author` and `license` (`"none"` when the package has no license)
  - the importer's `pick` also matches the installed id, so Update re-picks from a marketplace
- `f0181b5`, **DM3 write-back:**
  - `design:edit-style` → `service.editDesignStyle` → `applyStyleEdit` (in `main/design/textedit.ts`) merges into the element's `style` attribute by unique `data-agent-id`
  - only STYLE_KEYS are allowed, and only plain values (no `;`, quotes, braces, `url()` or `expression()`); versions are saved before and after
  - Quick tier is refused in main too
  - the inspector's Apply writes on Working and Real app when the element has an id; otherwise, or on error, it drafts the composer message as before. The footer hint says which one happens.
  - Hug/Fill/Fixed for width and height (`fit-content` / `100%` / the measured px)
  - tabs: Properties | Elements | Code | Tweaks. Tweaks reuses `TweaksBody` from TweaksPanel, and the popover button is hidden while the inspector is open.
- `f760bbd` + `1994fa4`, **DM3 Elements:**
  - the bridge posts `outline` (`outlineOf`: pre-order walk, depth ≤ 8, ≤ 400 nodes) on ready and on request; the canvas asks again when the inspector opens
  - `ElementsTree` row click → `set-selection`
  - fixed: DesignCanvas's catch-all `else` (pick-cancel) would have stopped Select on every outline message
- `eaaca24`, **EX4-UI + EX3 rest:**
  - `AddExpertDialog`: GitHub link, Folder…, .zip file…, then a marketplace pick step, then a done step with the skipped reasons
  - the detail shows Source, Author and License, a "No license: for your own use" warning, Update, and a two-step Remove
  - "+" → Experts: an empty thread of the right kind takes the expert in place (`store.setThreadExpert`, which also adds its skills and design system). A thread with messages shows a "Start a new thread with X?" confirm. On a failed set it falls back to a new thread.
  - a new "+" → **Skills** submenu (`SkillsSubmenu.tsx`) adds a skill chip through `addPendingSkills`
- `e0d7337`, **portraits and header chip:**
  - imported experts get a DiceBear Notionists portrait generated at runtime, seeded by id. `@dicebear/core` and `@dicebear/notionists` 9.4.2 are now dependencies (MIT; the art is CC0); see `assets/experts/LICENSE.md`.
  - the expert chip also shows in the thread header (`App.tsx` `.main-header`)

**Checks at `e0d7337`:**
- typecheck green
- **2280 passed** (the full suite)
- `design:check` 0 errors (48 baseline warnings)
- Live in the dev app:
  - the header chip renders beside the title
  - Add expert → `https://github.com/liangdabiao/workbuddy-expert-research-insight` → "Installed 1 expert." It went to `userData/experts/research-insight`.
- **Not yet live-checked:**
  - the imported expert's card and detail (portrait, No-license warning, Update/Remove)
  - the inspector's Apply writing the file, the Elements tab, the Tweaks tab, and Hug/Fill/Fixed
  - the "+" → Experts empty-thread vs confirm flow, and "+" → Skills
  - live turns on OpenCode, Codex and Claude (memory `test-app-for-real`; the plan allows one end-to-end test at the end)
- **Test data:** a stray "Career Coach" thread appeared in `board-proj` during agent-browser clicks. It didn't reproduce, so it was likely a stale ref. Delete it if you like.

**Workers this session:** 1 researcher plus 3 implementers on `opencode/deepseek-v4.1-flash-free`, in parallel worktrees, all exit 0.
- dm3el: one wrong test expectation, fixed by Claude
- ex3rest: Claude added the `.catch` fallback
- Worktrees and branches are removed. `.ai/tmp` holds only `dispatch.sh`.

**Still open** (from "What's left" below; DM3, EX2, EX3 and EX4-UI are now done apart from these):
- DM3: the Code tab has no syntax highlighting and no file list
- EX2: no "×" on the chip (allowed under manual-only)
- EX4: a package's `skills/` doesn't yet join the skill roots for that expert's threads (natural with EX5)
- **EX5 teams runtime** (next), then the live team run on Claude with the imported research-insight team
- **DM4**, then **DM5**
- the Windows PC run (memory `two-machines`)

## Resume here — DM3, EX2b, EX3 + expert identity (2026-10-15, Mac, session 2)

Plan is still `.ai/plans/design-expert-center.md` (approved). Branch `m4`, **not pushed**. Commits this session (on top of `b5d56c4`):

- **DM3 `08636e5` — Inspector:**
  - a Properties | Code panel beside the canvas (toggle: sliders icon, left of Select; opening it also turns on Select)
  - Properties are computed style read by the bridge (23 whitelisted keys, kept in step in `bridge.ts` and `shared/selection.ts` `STYLE_KEYS`)
  - edits preview live in the frame (`preview-style` / `clear-preview`, originals restored)
  - Apply clears the preview and writes "Change the selected element: font-size 32px → 20px." into the composer, scoped by the selection chip; the Code tab is read-only with Copy
- **EX2b `9bb6517` — Expert Center:**
  - the Library's Experts tab now has search, Experts N | Teams N, Sort (Recommended / Most used / Newest), My experts, 6 scenario cards, category chips plus Engines (the old engine cards, unchanged), and cards with Summon
  - the detail modal has Summon, "Can help with" quick prompts, a team roster, stats and the ID
  - usage counts live in `localStorage["cubiq.expertUsage"]` (`readUsage`/`bumpUsage` in `experts/ExpertCenter.tsx`; the submenu reuses them)
- **EX3 `afee0ee` — "+" menu:** items can carry a `submenu`; the Experts flyout has search, 5 recent experts, Enter to pick the top match, and Browse all experts. It opens **upward** from its item (fix in `b786f46`).
- **Fixes after the live test, `b786f46`:**
  - opening the Inspector no longer remounts or reloads the frame (one `.design-stage-row` wrapper always)
  - quoted commas in expert frontmatter lists (`splitList` in `shared/experts.ts`; quick prompts had been split in two)
- **Manual-only experts, `88da8ef`** (user rule, memory `experts-manual-only`): an expert is set **only** by the user's Summon, quick prompt or "+" → Experts.
  - restoring an exported thread now drops `expertId`
  - audit: the catalogue reaches the renderer only over IPC; `expertBlock` is injected only for `thread.expertId`; nothing auto-picks an expert or shows the catalogue to a model
  - keep it that way in EX5: team member subagents exist only inside a thread whose team the user summoned
- **Expert identity, `971dece`** (WorkBuddy-style, from the user's request):
  - portraits for all 30 experts and 12 team members: `src/renderer/src/assets/experts/<id>.svg` and `<team>--<member>.svg`
  - they are DiceBear **Notionists** (CC0 1.0, by Zoish), generated once from the id as seed; see `LICENSE.md` there. They are not a dependency.
  - `experts/ExpertAvatar.tsx` shows the portrait, else initials (imported experts)
  - avatars are used on the cards, the detail header and roster, the "+" flyout, the composer chip and the intro card
  - **ExpertChip:** in the composer bar of an expert thread; opens the detail; no × by design. In a narrow composer (≤ 420 px) it shows only the avatar and the chips drop their chevrons; the model picker keeps at least 44 px.
  - **ExpertIntro:** at the top of an expert thread with no messages yet: avatar, name | persona, profession, description, team avatars, "Try asking" prompts (they pre-fill this thread's composer and don't summon), and an AI disclaimer
- **Composer:** with chips (selection, skills, files), the chips get their own row and the text takes the full width under them (it was squeezed beside a chip).
- **Checks on `m4` at `971dece`:**
  - typecheck green, **2236 passed**, `design:check` 0 errors (the 48 warnings are the same baseline)
  - live in the dev app: Inspector select → live preview → Apply draft, and the Code tab; Expert Center, the team detail with portraits, Escape (modal first, then the Library); the "+" → Experts flyout (search, Enter summons); the chip and intro in a narrow design chat
  - live expert turns, Code Reviewer = "Priya, Staff Software Engineer":
    - Claude `sonnet` and OpenCode `opencode/deepseek-v4.1-flash-free` answered as Priya
    - Codex `gpt-6-luna` named itself "Codex" but confirmed that persona when asked: the developer instructions do arrive
- **opencode workers:** TokenHarbor's Pass allowance ran out (`plan_allowance_exhausted`; don't switch on pay-as-you-go). The user chose **OpenCode Zen `opencode/deepseek-v4.1-flash-free`**. `.ai/tmp/dispatch.sh` uses it (no config injection); memory `oc-dispatch-mac` is updated.
- **Worktrees:** `dm3`/`ex2b`/`ex3` are merged and removed. `uiux-p3` and `uiux-p4a` are also merged into `m4`; delete them if the user agrees.
- **Test data in the dev app:** the project `board-proj` has two design threads; one is the user's own Design-System Architect thread.
- **Known gaps:**
  - a team's quick prompts in the detail open a new thread (Summon); from the intro card they only pre-fill
  - imported experts get initials, not portraits
  - the thread header shows no expert, only the composer chip does

### What's left of `.ai/plans/design-expert-center.md` (checked against the plan, 2026-10-15)

- **DM1 Board, DM2 Flow + Present, EX1 expert model:** done.
- **DM3 Inspector, partial:**
  - **Apply only drafts a message.** The plan wants a `design:edit-style` IPC that patches the element by `data-agent-id` in the HTML on the working and real-app tiers (same safety model as `design:edit-text`); the quick tier keeps the scoped message. The plan's check "inspector apply writes the file" isn't met until this lands.
  - the existing TweaksPanel isn't yet a "Tweaks" tab beside Properties | Code
  - no Hug/Fill/Fixed sizing
  - no **Elements** layer tree (tag + class) synced with the selection
  - the Code tab has no syntax highlighting and no file list for the design folder
- **DM4, not started:**
  - a floating bottom tool bar (Select, Text edit, Comment, Draw; Draw is a pen overlay whose annotated PNG goes with the next message)
  - device chrome (phone with notch/home bar, tablet, browser window)
  - "Restore this version" (copies vN to a new latest version)
- **DM5, not started:** a design-system viewer/editor (System tab: Overview, Colors with WCAG badges, Typography, Spacing, Radius, Shadows, Components); copy-on-write into `.agents/design-systems/<id>-custom/`, writing `tokens.css` + DESIGN.md with a live preview.
- **EX2 Expert Center, nearly done:**
  - no expert chip in the **thread header** (only the composer has it)
  - the plan's "× removes it for the next thread only" isn't built. It's allowed under manual-only, since it's a user action.
- **EX3 "+" submenu, partial:**
  - no **Skills ▸** submenu
  - picking an expert always opens a new thread. The plan says: in an empty thread it sets the expert on that thread; in a thread with messages it asks "Start a new thread with X?"
- **EX4 importer, backend only:**
  - the **Add expert UI** in the Expert Center: a GitHub URL (repo or `tree/<ref>/<subpath>`), a folder or a .zip → `importExperts`; a marketplace pick list; update and remove under "My experts"
  - the detail modal should show source URL, version, author and license, and warn "No license: for your own use"
  - a package's `skills/` should join the skill roots only for threads using that expert
  - the plan's zh fallback is superseded by the user's rule "no Chinese names anywhere" (display fields are English-only already)
  - also: generated Notionists portraits for imported experts (seeded by id), so they don't fall back to initials
- **EX5 teams runtime, not started:**
  - Claude: members as SDK `agents`
  - OpenCode: `agent.<id>` subagents through config injection
  - Codex/native: one-agent fallback with the notice "Teams run as one agent on Codex"
  - a team strip above the composer with member portraits that light up from subagent events (`claude.ts:719,921`, `acp/driver.ts:556`), WorkBuddy-style: "4 team members" with per-member Done/Working and a right-side panel showing a member's task
  - a cost note in the summon dialog (the detail already has a one-line team note)
  - **manual-only**: members exist only inside a thread whose team the user summoned
- **Verification still owed:**
  - live import of `liangdabiao/workbuddy-expert-research-insight` as a team, run on Claude (only the import has been checked)
  - Windows gate: importer path and extraction tests on win32 fixtures, and a green CI windows job

### What next (in order)

1. **Windows gate + push** `m4` (memories `two-machines`, `ci-windows-acp-flake`).
2. **Finish the partial phases, in parallel worktrees** (memory `parallel-worktrees`; briefs ≤ 5 files, no shell commands for workers):
   - **EX4-UI:** the Add-expert dialog, the license/source display, Remove/Update, portraits for imported experts
   - **EX3-rest:** expert in an empty thread vs "Start a new thread with X?", and the Skills ▸ submenu
   - **DM3-rest:** `design:edit-style` write-back, the Elements tree, the Tweaks tab, Hug/Fill/Fixed
   - **EX2-rest:** the expert chip in the thread header
3. **EX5** teams runtime (then the live team import test on Claude).
4. **DM4**, then **DM5**.

## Resume here — Design v2 + Expert Center (2026-10-15, Mac)

Plan: `.ai/plans/design-expert-center.md` (approved: run both tracks in parallel; "clone" experts via an importer plus our own original built-ins; **show no Chinese names anywhere**). References used: Figma Make edit mode, two Claude design artifacts (a design-system viewer and a multi-artboard canvas), WorkBuddy 5.7.6 screenshots and app bundle, and the CodeBuddy expert-package repos. Their licenses: only `techflag/workdsh` is MIT, the rest have none, so **nothing from them is bundled**.

- **DM1 `678cc79` — Board view:**
  - every design page as labelled artboards on a pannable, zoomable board (⌘/Ctrl+wheel zoom 5–200 %, drag or Space-drag to pan, Fit)
  - sections come from file names `<section>--<NN>-<name>.html`: one row per section, numbered flow steps in order, artboard size from the section name (`mobile`/`phone`, `tablet`, `slide`/`deck`, else desktop)
  - labels counter-scale so they stay readable; `fitBoard` widens the section gap so labels never overlap
  - skills `design-mobile` / `design-prototype` teach the naming
  - `DESIGN-MODE.md` is at its 700-token budget (test), so the naming lives in the skills only
  - code: `src/renderer/src/design/{Board.tsx,board-layout.ts}`
- **DM2 `7a4d24a` — Flow + Present:**
  - `design:entry` returns `links` (relative `href`/`data-goto` between pages)
  - the Board's Flow toggle draws arrows routed around the board (`flowPath`)
  - **Present** is a full-canvas clickable prototype with a device frame for mobile, ←/→/Esc, and following in-frame link clicks through the bridge's `ready` message (the frame is cross-origin)
  - live-tested in the app, except that the in-frame link click can't be driven by CDP synthetic input (the old Focus canvas behaves the same)
- **EX1 — the expert model:**
  - `c0a8558` (EX1a+c):
    - `ExpertDef` / `expertBlock` in `src/shared/experts.ts`, with the legacy `EXPERTS` kept for old tests
    - catalogue `src/main/experts/catalog.ts`: bundled `resources/experts/*.md` and `<id>/expert.md` + `members/*.md`; imported experts in `<userData>/experts/` override bundled ones
    - db migration 27 adds `threads.expert_id`
    - IPC `experts:list` / `experts:get`; `threads:create` accepts `expertId`
    - 22 original experts and 3 teams, written by opencode, all English
  - `3efae44` (EX1b): every engine appends the `<expert>` block to its instructions (Claude `systemPrompt.append`, Codex `developerInstructions`, OpenCode/ACP first prompt, native guide). Byte-identical when a thread has no expert.
  - `bcb3402` (EX2a):
    - preload / mock / `UnskilledApi` (`listExperts`, `getExpert`, `importExperts`, `removeExpert`)
    - store `experts`, `loadExperts()`, `summonExpert(id, prompt?)`: closes the Library, opens a design thread for a design expert, adds skill chips, pre-fills the prompt
    - the 5 old design presets (UI Designer, Mobile Designer, Slide Designer, Design-System Architect, UX Critic) ported into the catalogue, so 30 bundled in total
- **EX4 `e11c188` + `b3b0913` — importer:**
  - `src/main/experts/importer.ts` reads a GitHub URL (zipball through the API, `tree/<ref>/<subpath>`), a folder or a .zip
  - formats: CodeBuddy `plugin.json` (agent or team), `marketplace.json` (lists candidates, then `pick`), or bare `agents/*.md`
  - converts to CubiQ's format with `---` frontmatter; `sourceUrl`, `author` and `license` are recorded (`none` when absent)
  - guards: 50 MB download, 3000 files / 150 MB, no `..`, absolute paths or backslashes, atomic rename into `<userData>/experts/<id>`, nothing run
  - **display fields are English-only**: CJK values fall back to a title from the id, and member ids come from agent names. Prompt bodies stay as written (the model reads them; they're never shown as names).
  - live-verified: `liangdabiao/workbuddy-expert-research-insight` (team, 4 members) and WorkBuddy's own cached marketplace at `~/.workbuddy-ai/plugins/marketplaces/experts`, which lists 3 and installs a pick
  - known gap: a multi-agent package that isn't a team (WorkBuddy `design-experts`) imports as one expert, its first agent
  - IPC `experts:import` / `experts:remove` are wired; **no UI yet**
- **Checks on `m4` after merging all branches:** typecheck green, full suite **2199 passed**, `design:check` 0 errors. Not pushed: Windows CI not run yet. Live-tested: the Board, Flow and Present in the app (DM1/DM2). The expert prompt reaching each engine is unit-tested only. The live turn on OpenCode, Codex and Claude with a summoned expert is still to do (memory `test-app-for-real`), best once EX2b gives a Summon button.
- **Next (parallel; briefs ready in `.ai/plans/design-expert-center-briefs/`; copy them to `.ai/tmp/` and run `dispatch.sh <worktree> <name> <delay>`, staggered 20 s, one worktree each):**
  - **DM3** Inspector panel: Properties from computed style with a live preview in the frame, Apply → composer draft; a Code tab
  - **EX2b** Expert Center UI: scenario cards, Experts | Teams, categories, sort, the detail modal with Summon and "Can help with", Engines kept
  - **EX3** "+" menu with an Experts submenu
  - then: an **Add expert** dialog in the Expert Center (paste a URL or pick a folder/zip → `importExperts`; marketplace pick list; the license badge "No license: for your own use"; remove)
  - then: DM4 (floating tools, device chrome, restore a version), DM5 (design-system editor), EX5 (teams runtime: Claude SDK `agents`, OpenCode `agent.<id>` subagents, Codex/native fallback, team strip)
  - imported experts' `skills/` don't yet join the skill roots for their threads (do with EX5)
- **Lessons this session** (saved to memory `oc-dispatch-mac` and `parallel-worktrees`):
  - tell implementers **not to run shell commands**: one rejected `tsc` aborted DM1's worker with a false "nothing changed" report
  - never name sibling files that differ only by case (`Board.tsx`/`board.ts`)
  - a 25-file content brief returned garbage; split into ≤ 11-file batches it worked
  - say "`---` fenced frontmatter" explicitly in briefs
- **Test data left in the dev app:** the project `board-proj` (scratch folder) with one design thread; safe to delete from the sidebar.

## Resume here — self-improve (2026-10-15, Mac)

Plan: `.ai/plans/self-improve.md` (approved 2026-10-15, cheap models only); its **Implementation spec** section at the bottom has the evidence, modules, data, hooks and blast radius. Code: `src/main/learn/`, shared types `src/shared/learn.ts`. Off for every project unless listed in `Settings.learn.enabledProjects` (no UI to switch it on yet: S5).

- **S6 `5ab9072`:** native agent nudges, only when `TurnInput.nudges` is set (the Service sets it for opted-in projects):
  - the same failing call 3× (any order) gets one note in its tool result
  - an answer that claims tests pass with no check run gets one corrective user message, then the loop continues
  - written by an opencode implementer, verified and merged by Claude
- **S1 `4384e23`:** live scorecard, zero tokens:
  - signals: evidence flags, the check failing (or passing only after a fix round), denials, Stop, repeated failing commands, over 3× the project's healthy norm, a correcting next message, edits undone within 10 min
  - fix rounds fold into their root turn's score
  - stored in `turn_scores` (db migrations 23–26 add `turn_scores`, `lessons`, `learn_replays`, `learn_budget`)
  - a health dot on the turn footer (`HealthDot`, `turn-score` LiveUpdate, `learn:scores` IPC)
- **S2+S3 `460a5ca`:**
  - a failed turn is frozen as a case in `<userData>/learn/<projectId>/cases/<id>/`: HEAD sha, the pre-turn dirty overlay, the prompt, and graders derived from the signal (check passes, test file unchanged, no unbacked claim, the file left as the user put it back)
  - secret files and secret-looking content are never captured; a quarter of cases are held out (transfer checks only)
  - a candidate lesson is drafted on the background model (`pickBackground`: Settings pick → native provider flash → the thread agent's cheap tier → any cheap model), idle-only, under the daily token cap (default 50k), deduped by token Jaccard; turns that used web/MCP/browser tools are never learned from
  - a corrected turn waits for the next turn's answer as the contrast
  - `draft.ts` was written by an opencode implementer on **TokenHarbor `deepseek-v4.1-flash`** (the user's choice for `/oc` from now on; see memory `oc-dispatch-mac`)
- **Two deliberate deviations from the plan text** (both in the spec): lessons live in SQLite, not memory files, because CubiQ memory is Claude's native format and a candidate would reach Claude unverified; cases live in app data, not `.cubiq/evals/`, so they don't dirty the repo. "Save to project" will copy one there (S5).
- **Not added on purpose:** a Claude `oneShot`. The memory extractor skips Claude only because Claude has none (no driver sets `nativeMemory`), so adding one would start extraction on every Claude turn. Background drafts on an agent without `oneShot` run as a hidden plan-mode turn in a temp folder instead (`backgroundShot`).
- **Checks:** typecheck green; full suite 2146 passed (run 4× in a row clean after two test-timing fixes).
- **Next:**
  - **S4:** replay a case in a temp copy (`git clone --shared` + checkout sha + overlay + `node_modules` junction) on the background model, without and then with the lesson (k=2 each); promote when fail→pass and other cases hold; the result cache in `learn_replays`
  - **S5:** inject active lessons relevant to the prompt (≤5, ≤800 chars, never twice per session), helpful/harmful counters, retire and re-verify, the Library → Learned tab, the Settings background-model picker and cap
  - then the scripted end-to-end test (agent edits `dist/` → case → lesson → replay fail→pass → promoted → next turn avoids it), live turns on OpenCode, Codex and Claude, and Windows CI

## Resume here — eval E3 done (2026-10-15, Mac)

Plan: `.ai/plans/eval-framework.md` (approved; status block at top). Run with `bun run eval --agent native|claude|codex|opencode --tier smoke|full [--provider pgs|th] [--trials 3] [--task a,b] [--dry] [--save-baseline]`. Results go to `.ai/evals/` (gitignored); the pass/fail baseline is in `evals/baseline.json`.

- **E1 `6371105`:**
  - runner with step, token and time caps
  - deterministic graders
  - result cache (re-runs cost 0 tokens)
  - report and diff
- **E2 `7f17d04`:**
  - 20 tasks; grader tests live in a `<fixture>.hidden/` folder and are copied in after the turn
  - every grader fails on the fixture and passes on its reference solution
  - baseline: native PGS DeepSeek 19/20, TokenHarbor Haiku 20/20
- **Plan-mode fix `1aa8454`:**
  - `PLAN_MODE_NOTE` now says to answer plain questions without `propose_plan` or extra exploring
  - eval with 3 trials: all plan-mode tasks 3/3 on DeepSeek and Haiku
  - the first wording ("answer directly") made Haiku skip loading skills; the eval caught it and the wording was fixed
- **E3 done (2026-10-15):**
  - `evals/lib/agents.ts` builds the Claude, Codex and OpenCode drivers like `index.ts` does: same CUBIQ.md guide and built-in guard, the user's own logins, Claude on `haiku`
  - every agent now gets the guide, the native agent included (parity fix)
  - a plan proposal is recorded the same way for all agents (`event planProposed`)
  - the skill kit is written to each agent's skills folder (Claude reads `.claude/skills`)
  - `StdioRpc` stdin EPIPE crash fixed (`src/main/agents/rpc.ts`, `test/rpc.test.ts`)
  - `--agent opencode --provider pgs` runs OpenCode on PGS Grove DeepSeek V4.1 Flash through an injected `eval` provider (`OPENCODE_CONFIG_CONTENT`, key as `{env:PGS_API_KEY}`). The user asked for this because OpenCode's own default (`agentrouter/deepseek-v4-flash`) began rejecting tool turns on 2026-10-15 with `sensitive words detected` (1/6, an upstream filter, not a harness bug).
- **Baselines saved (2026-10-15):**
  - native full: PGS DeepSeek **20/20** (route-skill-2 now passes; input tokens +369%, ≈13k→62k, from the guide), TokenHarbor Haiku **20/20** (≈337k in)
  - smoke: Claude haiku 6/6, Codex default 6/6, OpenCode on PGS 6/6 (key `smoke|opencode/eval/deepseek-v4.1-flash`)
  - full suite 2061 passed, typecheck green
- **Post-E3 round (2026-10-15, plan `.ai/plans/e4-fixes.md`):**
  - **Deny wording fixed:** `refusal()` now says "don't get the same result another way; tell them it was blocked, or continue with the rest". `permission-deny` ×3: DeepSeek 3/3 (was 2/3), Haiku 3/3.
  - **OpenCode tokens fixed:** OpenCode's ACP usage is its last model call only (verified in the 1.19.0 binary: `cC(messages)`). The ACP driver now runs `opencode export <session>` after the turn (preset `turnUsageVia: "opencode-export"`, 3 s cap, temp-file stdout because OpenCode drops pipe output past 64 KB when the reader lags) and sums every call. Live: 5 calls → in 15,109 / cache 54,909 / out 478, matching the export (before: last call's 110). Upstream issue not filed yet.
  - **E4:** `bun run eval --trend [--tier] [--model] [--last n]` (zero tokens); 5 harder tasks (`csv-quoted`, `month-root-cause`, `async-save`, `slugify-spec`, `generated-dist`) with `<fixture>.reference/` solutions proven by `test/eval-tasks.test.ts` (graders fail on the fixture, pass on the reference); 6 always-green capability tasks retagged `regression`. Rubric grader deferred.
  - **Still saturated:** both DeepSeek and Haiku pass the 5 new tasks too (25/25 each). Next discriminating tasks need longer horizons (multi-file features, a failing CI log to diagnose, a spec with conflicting constraints).
- **Windows CI green (2026-10-15, run 38673293246, 2078 passed)** after two fixes: the root `.gitignore` `dist/` had dropped the `generated-dist` fixture's `dist/` (now `!evals/fixtures/*/dist/`), and its grader normalises CRLF.
- **Next:** self-improving CubiQ, now in progress: see **Resume here — self-improve** above.
- **Remaining:** the Windows PC gate; older items (cubiq-shop live build; H7d memory live checks).

## Where things stand

| Phase | State | Commits |
|---|---|---|
| 0 — Substrate | done (CI workflow not yet run on GitHub) | `f41a196` |
| 1 — Provider registry | done | `8b68753` |
| 2 — Credential injection | done | `f95ceaa` … `f09a2d7` (+ `5ce511c`) |
| 3 — Capability parity | **done**: typecheck, build and `electron . --smoke` green; tests green except the two known Windows-machine items below | A `67bdb46` (+`8b39214`), B `84ed108`, C `3a909dc`, D `3aacc63`, E `c2d10f2` |
| 4 — Streaming + reasoning | **done**: typecheck, build, preview render green; tests green except the two known Windows-machine items | A `6d20cce`, B `8667748`, C `d6686ac`, D `a6ea827` |
| 5 — Cache discipline | **done**: typecheck, build green; tests green except the two known Windows-machine items | A `80a9a31`, B `270c768`, C `793cfdc` |
| 6 — Context survival | **done**: typecheck, build, smoke green; tests green except the two known Windows-machine items; real Codex→Claude handoff checked in the app | A `04c347e` `022bd44` (+ smoke fix `4f80d01`), B `95e616e` `a2da431`, C `5e3e7dd` `4d487ec`, D `ff414c5` `00dd3f9`, E `c3a845a` |
| 7 — Interaction mechanics | **done**: typecheck, build, smoke green; tests green except the two known Windows-machine items; splitters/drawer/collapse checked in the real app | A `d6ecd8e` `9011c87`, B `a535b69`, C `a7340fe`, D `1b94312` `da46d67`, E `8b4c4e7` `50ad9d1`, F1a `59328c9`, F1b `d7b749e`, F2 `d02e49c` |
| 8 — UI refinement | **done** (T8.13 worktrees deferred behind Phase 9 T9.7; T8.15 = T7.12): typecheck, build, smoke green; tests green except the known Windows-machine items; every step checked in the real app | A `d04d0a7`, B `b9466a8`, C `ab804df`, D+F `95b97b7`, E `3153964`, G `89ba506` |
| 9 — Release hardening | **done** except the human rollback drill and a first CI run on GitHub; typecheck, build, dev and packaged smoke green (all four new checks); tests green except the known Windows-machine items | A `1b3a739`, C `839106a`, B+D `b6e76cc`, E `1d4a8e8`, F `9283407` |
| Windows portability | done | `ae0b0cc` |
| bun switch (user's, committed at their request) | done | `ab42bb9` |
| 10 — Skills, MCP scopes, guide, effort, sidebar | **done**; typecheck, build, smoke green; tests green except the known Windows-machine items; every step checked in the real app (OpenCode + Codex turns; one Claude turn at the end) | 10A `0489835`, 10B `a46d5e0`, 10C `92ca50d`, 10E `a00acf0`, 10B2 `cbcc2aa`, schema fix `f937edc`, 10D `3f48d8d`, 10G `6e8f916`, guard `ad338c6`, UI `8848788`, ACP rows `f893297`; then @ mentions `98dced6`, Antigravity CLI + OpenCode variants `4fb54cf`, file:// links `77cb734` |
| T8.13 worktrees (from the stash) | **done**; checked in the app on a throwaway repo | `4638000` |
| M4 round (2026-09-29, Mac) — token breakdown, Plan mode, `$`/`/`, model + binary freshness, test suite | **done**; typecheck + full suite green (875 tests, 0 failed, ~22 s); every item checked in the real app on Claude, Codex and OpenCode | A `65191c7`, B1 `ff5922a`, B2 `8fd157b`, C `ae37baa`, doc 11 `0bcfb08`; models `6a428c8`, binaries `293c478` `05938a8`, menus `cc43588`, bugs `bdbc276`, Stop `fd4c151`, tests `4c596f4` |
| Phase E (2026-09-29, Mac) — shared CubiQ memory, `/context` | **done**; typecheck + full suite green (966 passed, 0 failed); every slice checked live on OpenCode (nemotron free), Codex and Claude (Haiku) | S0 `/context` `1e1bee1`, S1 store + import + Claude `2bff594`, S2 Codex/ACP index + `memory_read` `e3fc39c`, S3 extractor `66020a8`, S4 Library tab `cc58301` |
| Roadmap N1–N9 (2026-09-30 → 10-01, Mac) — mock kit, `/context` pricing, accuracy run, MCP router, provider catalog, Codex subagents, check gate, guide diet, context picker | **done**; full suite 1073 passed; each phase live on Claude (Haiku), Codex (GPT-6-Luna), OpenCode; Windows **CI** green for every phase (last run 36818195119); Windows **PC** gate pending for N7–N9 | N1 `331a6c0`, N2 `c68ca3c`, N4 `d19aef4`, N5 `82487e5`, N6 `cc1ea02`, N7 `f85e45c` + Windows fix `1d6f013`, N8 `9ed5546`, N9 `e72248f` `306c61c` |
| UI refresh U0–U2 (2026-10-01, Mac): DESIGN.md, Ink Flat tokens, one-row composer, /compact, message folds | **done**; typecheck, build, smoke green; full suite 1088 passed; each phase live on Claude (Haiku), Codex, OpenCode; Windows PC/CI not run yet | U0 `6cb7ecb`, U1 `863875f`, U2 `a7583e3` |
| U5a (2026-10-01, Mac): office preview worker (main side only) + U3/U4 API contract | **done, not user-visible yet**; typecheck, full suite 1098 passed, build, smoke 3/4 (one unexplained failure on the first run right after build, then 3 ok); worker probed in a real Electron `utilityProcess`; no live agent turns (nothing reachable from the UI) | `5a3f911` |
| U3 + U4 + U5 wiring (2026-10-02, Mac): inbox sidebar, ⌘K FTS search, artifact panel + file cards | **done**; typecheck, full suite 1153 passed, build, smoke 2/2; live in the built app (temp data dir, scratch repo): OpenCode md (Preview button), Codex html (auto-open), Claude Haiku csv (auto-open via the worker), ⌘K over FTS; Windows not run | one commit (U3/U4 share store/App/db) |
| M1 (2026-10-05, Mac): MCP secret vault | **done**; typecheck, full suite 1249 passed, build, smoke ok; live in the built app (temp data dir, real keychain): plaintext `mcp.json` migrated, Connectors Test mock 1 tool + POSARA 113 tools, Claude Sonnet 5.5 / Codex GPT-6-Luna / OpenCode each called both servers; no secret in any file afterwards; Windows not run | `5ccaf3b` |
| M2 + M3 backend (2026-10-05, Mac), **WIP** | parser, probe, SSE type, shared transport, OAuth module, API contract + preload + preview mocks committed; **not wired** (no IPC handlers, no gateway, no UI yet); typecheck + full suite green (1287 passed); no live run | WIP commit (see below) |
| MCP leftovers (2026-10-06, Mac) | **done**; SSE bridge live on Claude/Codex/OpenCode (local SSE fixture), list_changed, revoke on Remove, McpPanel a11y | `2466589` |
| P1a–c providers (2026-10-06, Mac) | **done**; 1367 passed; TokenHarbor + PGS Grove live on chat/Responses/Anthropic via OpenCode | `3fa2789` |
| P1d providers in the picker (2026-10-07, Mac) | **done**; 1373 passed; live: draft pick, in-place provider switch (resume), Claude→provider handoff | `7383268` |
| C0 per-project `.cubiq/` (2026-10-07, Mac) | **done**; `.cubiq/CUBIQ.md` guide (falls back to `.agents/HARNESS.md`), `.cubiq/skills/` first; project skills now really delivered to Codex (per-project extraRoots) and OpenCode (per-project skill tool) | `ac88d64` |
| P2 translation gateway (2026-10-07, Mac) | **done**; 1488 passed; live on TokenHarbor DeepSeek V4 Flash + PGS Grove GLM 5.3 Flash for Claude **and** Codex | P2b `58eb8a2`, P2c `113c006`, P2d `f4b4ac6` |
| P3 presets, catalog, prices (2026-10-07/08, Mac) | **done**; 1499 passed (one unidentified flake on the first of three runs), build, smoke; live: both presets on Claude, Codex and OpenCode; Claude + Codex on subscription | `5ac596f` |
| D1 Design shell (2026-10-08, Mac) | **done**; 1508 passed, build, smoke; live: design threads on Claude, Codex, OpenCode; Chat/Design filters, ⌘K, light/dark, 900–1280px | `86f71c0` |
| D2 Design live canvas (2026-10-08, Mac) | **done**; 1545 passed, build, smoke; live: canvas follows mid-turn writes on all three agents, no-network probe, pick → chip, v1/v2 | `89530f2` |
| D3 Design brain (2026-10-08, Mac) | **done**; 1577 passed, build, smoke; live: UI Designer on Claude Opus, Slide Designer on Codex, OpenCode Mono → Playful switch; chat threads carry no design skills | `c65337f` |
| D4 evaluator loop + export (2026-10-09, Mac) | **done**; 1733 passed, typecheck/build/smoke green; live: critique+fix on Claude (Opus), Codex and OpenCode; Critique v1/v2 in the panel; HTML/PNG/PDF exports (deck = one slide per page); chat threads show no design tools; Export menu at 900px light/dark; **Windows CI green** (watch fix `7f449f7`, permission fix `9c40392`) | `f15c9df` |
| Harness best practices H0–H1 (2026-10-13, Mac) | **H0 + H1 done**; typecheck, full suite 1886 passed; H1 live: env-gated vitest on TokenHarbor `claude-haiku-5.5` (Messages) + PGS Grove `deepseek-v4.1-flash` (Messages + chat), in-app turns on native TokenHarbor, Codex GPT-6-Luna, OpenCode, Claude Sonnet 5.5; **Windows CI green** (run 38374066244); Windows PC gate not run | H0 `9b3278c`, H1 `821da63` |
| Native agent N1 LLM client (2026-10-09, Mac) | **done**; 17 unit tests + live tool loop on TokenHarbor over chat (deepseek-v4.1-flash), Responses (gpt-5.x) and Messages (claude-haiku-5.5) | `75beae1` |
| Native agent N2 tools + loop + driver + decouple (2026-10-09, Mac) | **code done, NOT committed**; typecheck/build green, full suite 1733+ passed; live in the dev app: TokenHarbor is its own agent, read→edit→run on DeepSeek V4.1 Flash with Ask-mode cards, resume after an app restart; Claude regression turn ok; **Codex + OpenCode regression turns still to run** | — |
| Design mode v2 V1–V7 (2026-10-12, Windows PC) | **done**; each phase: typecheck, build, smoke, design:check green; full suite green except the known live/env tests (`harness-llm-live` ×3, `opencode-guard`; `codex-e2e`/`capabilities`/`check` flake only under full load); every phase checked in the built app (temp data dir, CDP), agent turns on Codex, one short Claude Sonnet turn at the end | V1 `90c3acc`, V2 `4b0cde3`, V3 `4c2c2e0`, V4 `e688327`, V5 `21344ba`, V6a `9952ac0`, V6b `ef7b8d8`, V7 `5a2697f` |
| Design v2 Mac test + fixes (2026-10-13, Mac) | **done**; typecheck, design:check, build, full suite (1873 passed); every V-phase driven in the built app; live turns on Claude (Opus, Sonnet), Codex (GPT-6-Luna), OpenCode (Big Pickle) | fixes `9c3c206`, polish `b9499c2` |

**Uncommitted on purpose (the user decides):** the `CLAUDE.md` notes (Windows notes + the new worker model order) and `SETUP-OTHER-PC.md`. The bun switch is committed (`ab42bb9`). `test/__snapshots__/providers.test.ts.snap` shows as modified: line endings only. Phase commits carry code + tests only, with no attribution trailer.

## What Phase 3 shipped

- `AgentCapabilities` + `SAFE_DEFAULTS` on every driver (ACP: `initialize` is authoritative); `skillsDelivery` replaces `skillCallPrefix` (kept as a deprecated projection).
- Codex Ask **and** Auto-edit on `untrusted` + `workspace-write` (spike: `on-request` runs commands without asking); the harness auto-accepts file changes in Auto-edit and runs the git guard on every command.
- Git guard on ACP (`reject_once` + notice), Codex, and OpenCode (a `tool.execute.before` plugin injected via `OPENCODE_CONFIG_CONTENT.plugin`). `unwrapShell()` catches `/bin/zsh -lc '…'`.
- Dropped-HTTP-MCP and "session reopened" notices.
- `src/main/approvals.ts`: allow-always keyed `(agentId, toolName, canonicalPattern)`, in memory, **one store per project**, consulted after the driver's guard; `permissionTable()` snapshot pins the 9 (mode × driver) rows.
- `Service.applyModel()` → `in-place | new-session | unsupported` via optional `AgentDriver.setModel`; Claude/Codex/ACP in place, back-to-default on Codex/ACP → new session; one notice per switch. Summary replay is phase 6.
- Library capability chips + "What this agent can't do here"; `PermissionCard` shows the guard variant from `capabilities.guardEnforcement[mode]`.
- Credential injector chosen by data (`injectionFor(..., { injector, keyVar, providerEnvOnly })`, preset fields), and `test/no-agent-id-branches.test.ts` scans `src/main`.

## What Phase 4 shipped

- Live-only channel: `TurnInput.onTextDelta(text, itemId?)` plus optional `onReasoningDelta/onReasoningSummary/onToolInputDelta/onToolOutputDelta/onUsageUpdate/onThinkingProgress`; the Service broadcasts each as `LiveUpdate { type: "delta" }` (redacted, never stored).
- Claude keys stream items `${messageId}:${blockIndex}` (blocks counted per message id), keeps opaque reasoning as `{ text: "", signature, opaque: true }`, flushes streamed text before "Stopped.". Codex: reasoning text/summary/command-output deltas (reasoning kept out of `t.deltas`). ACP: live thoughts, tool output as suffix diffs of content snapshots, usage updates; per-run synthetic item ids. `AgentCapabilities.liveReasoning?`.
- Renderer: `live.ts` per-item state (cleared only by its terminal event; items without ids clear their channel), 16 ms batched store writes; `streaming.ts` (`parseBlocks` moved here, `splitStreamingTail`, `memoizeByHash`); `ReasoningBlock`, plan row, compaction divider; preview mock shows them.

## What Phase 5 shipped

- The seven browser tools are offered from the first turn and answer "Browser pane not open" until the tab is open (README + HARNESS.md item 7 updated), so the tool set never changes mid-conversation.
- `src/main/cache-policy.ts`: `stableStringify`, pinned tool-set fingerprint (`toolSetOf`/`pinToolSet`/`queueConfigChange`/`drainConfigChanges`), `isMiss` (≥ 2000 and > 5%), `classifyMiss`, `annotateUsage`, `shouldCompact` + `claudeCompactEnv`/`codexCompactConfig` (built, **not wired** into agents). The Service annotates every `turn-end` usage: a fresh session has no baseline; `TurnInput.onSessionRebuilt?()` (Codex unsubscribe, ACP close+resume) marks an expected `session-rebuild`.
- `src/shared/cache-stats.ts` + `CacheMeter` in the header (one number, detail in `title`, miss cause, warm/cold, live usage ticker); ACP shows `cache —`.

## What Phase 6 shipped

- `Thread.bindings` (`${agent}:default` → `SessionBinding`), migration step 11 backfills from `session_id`; `sessionId` is the current agent's projection and the column still mirrors it. Switching agents keeps every cursor.
- `handoff.ts`: thread export/import (blobs inlined, all-or-nothing; palette *Export/Import Thread…*), `buildCheckpoint`/`renderCheckpoint` (tiers 0–2; no thinking, no CLAUDE.md/AGENTS.md/SKILL.md/Skill output), `fitCheckpoint` (cap min(25% window, 4k), estimate bytes/3, refuse if larger than what it replaces), injection ledger (`injectWithLedger`), `checkpointGit` (`refs/harness-handoff/<seq>`, dirty refusal), `bloatSignal`, `codexSeedItems`.
- Drivers: `capabilities.seeding` (Codex `inject-items`, Claude/ACP `first-message`), `seedNoReply` (false everywhere), `AgentDriver.seed?()` (Codex: open/resume the thread, `thread/inject_items`, never `turn/start`), `countTokens?()` (no driver has one).
- `Service.switchAgent(thread, agent, "handoff" | "fresh" | "back")`: trust reset (default permission mode; approvals are per agent), refusals before any change, git ref only for Hand off, first-message reply stored as a `handoff`/`reply` event, bloat signal on the first turn-end after any switch. `updateThread({ agent })` = back when a cursor exists, else fresh.
- Renderer: `SwitchDialog` (carries / does not carry, Hand off / Start fresh / Switch back) from the agent select and the palette; `handoff` events render as divider rows.

## What Phase 7 shipped

- Pane geometry is a setting (`Settings.paneLayout`, optional; `src/shared/layout.ts` sanitises/clamps): APG `Splitter` for sidebar/inspector/terminal (keys, drag persisted on release, dblclick reset), `clampLayout` auto-collapses the inspector below a 420px main pane and restores on grow; sidebar rail (`PaneRail`) with aria-expanded toggles.
- Terminal is a bottom drawer (⌃`), shells stay mounted (also while the browser is wide); the inspector is Changes + Browser only.
- Tool rows are `<details>` (no name; body only while open; per-thread disclosure state in the store, never persisted); Run output with exit code; one `DiffView` for every agent's edits.
- Browser: device emulation (`browser_open` `device`, toolbar switch), Page/Console view fed in-band, screenshot strip + viewer via a narrow `unskilled-shot://` scheme (screenshots folder, .png only; CSP img-src allows it), "Move to main area" (conversation becomes a rail, emulation cleared). Smoke asserts the pane's sandbox posture.
- Take-over: `takeOverReducer` (exclusive lock), banner (Stop/Resume/Watch only), transparent overlay over the webview turns a click/key into "you took over"; the main process refuses the agent's acting browser tools while paused.
- Four-driver render parity (F2): `diffSummary` ("+a −d") on every adapter's edit result; Claude results carry Run `{exitCode:null, output}` / Edit `{diff}`; ACP execute/edit rows are summarised from `rawInput.command` / the edited path (OpenCode titles calls "bash"/"edit"), and a terminal update recovers its call's kind; `canonical`/`canonical-opencode` mock scenarios, `test/fixtures/canonical-events.ts`.
- One rendering contract: `src/shared/tools.ts` (`canonicalTool`, `clipSummary` 160 + "…"), `src/shared/diff.ts` (`parseUnifiedDiff` moved here, `unifiedDiff`); canonical Run/Edit payloads from Claude, Codex and ACP; Markdown renderer kept (element-building, no raw HTML — asserted by a test) and pinned by `test/markdown-dialect.test.tsx`, plus GFM tables and strikethrough.

## What Phase 8 shipped

- Sidebar: Pinned (session-local) / Active / Settled sections (`src/renderer/src/sections.ts`), agent label and non-default branch on each row (`branchLabel()` in `git.ts`, IPC `project:branch`), Ctrl/⌘1–9 jumps, Ctrl/⌘\ rail toggle; the rail keeps every footer control.
- Palette `>` = actions only. Message Center (`inbox.ts`, `MessageCenter.tsx`): permissions on other threads + turns that finished unseen. Files tab (`FilesPanel.tsx`, `listProjectFiles()`: `git ls-files` or a bounded walk). Context chips for picked elements; mid-turn sends queue (`store.outbox`, delivered once on the turn's end, Stop clears).
- Settings: left-nav groups (`SETTINGS_GROUPS`), `motion` (default instant; gates every entrance animation, reduce-motion wins) and `density` settings. `AgentInfo.credentials` (byok / own / injector) replaces the renderer's agent-id checks; `test/no-agent-id-branches.test.ts` scans the renderer too.
- Windows 10: no Mica there, so main passes `--opaque-sidebar` and the sidebar is painted opaque (it was grey and unreadable). Narrow main pane: the header drops meters, then wraps (title row; agent picker left to the palette); the browser bar wraps. In-thread `.notice` rows no longer float (the toast is `.toast`).

## What Phase 9 shipped

- Antigravity: preset fields `optIn` + `unsupported`; `loadAcpAgents(..., { optedIn })` (also gates an agents.json override); `Settings.antigravity` + `antigravityAck` (versioned, stamped by main, `SettingsStore.antigravityEnabled()`); Settings → Agents & Providers opt-in with the ToS disclosure; amber `UnsupportedChip` in the Library, sidebar rows and Settings; never a BYOK row.
- Settings export/import (Data & Security; keys stay machine-bound ciphertext; opt-in never carried), corrupt settings.json copied to `.corrupt-<ts>`, Linux `basic_text` no longer counts as encryption.
- Rollback: `cumulativeHitRate` / `hitRateRegression` / `prefixStability` + `Store.turnUsage`, `scripts/rollback-check.mjs`, `plan/docs/rollback.md`; frozen M3 `Store` fixture proves the downgrade; `toThread` lets a disagreeing `session_id` win (fixes pre-bindings export imports and post-downgrade cursors).
- Smoke: `src/main/smoke-checks.ts` (providers, migration, handoff, render parity via `window.__unskilledSmokeRender` in `--unskilled-smoke` mode); `scripts/smoke.mjs` finds `AI Harness`; CI env allowlist + Linux packaged-smoke job; `manual/**` excluded from vitest.

## What Phase 10 shipped (2026-09-27)

- **Sidebar**: toggle beside the wordmark; full-width New thread (Ctrl/⌘N); a + on each project row (hover) for a thread in that project; one label style; chevrons for projects and Archived; the splitter no longer covers rail buttons. **Lucide** icons (`icons.tsx`, same export names). Browser pane: "Nothing open yet" and "Can't reach <url> · Retry" instead of a white page; "Main area" labelled. Add Project errors now toast (it worked in the real app; the user's "nothing happened" was not reproduced).
- **Skills** (`src/main/skills/discover.ts`, `sources.ts`, `tool.ts`): Agent Skills SKILL.md frontmatter; sources by precedence project `.agents/skills` > app `<userData>/skills` > `~/.agents/skills` > bundled `resources/skills` > legacy `AIHARNESS_SKILLS_DIR`; per-skill on/off (`Settings.skills.disabled`). Delivery without duplicates (`SkillsDelivery.reads`): Claude plugin (per cwd; skips names in `~/.claude/skills` and `<cwd>/.claude/skills`), Codex extraRoots, dsh envDir, OpenCode/Cursor/Antigravity the `skill` tool on `/mcp-skills`. The `/` menu lists every user-invocable skill (model ones too). Library → Skills: groups by origin, switches, New skill, Folders.
- **Built-in skills** (`resources/skills`, packaged via `extraResources`): browser, docx, pdf, xlsx, pptx, skill-creator — our own text; the Node libraries they name were exercised for real. Anthropic's docx/pdf/pptx/xlsx are source-available, never bundled.
- **Guide**: `resources/HARNESS.md` (+ `<userData>/HARNESS.md`, `<project>/.agents/HARNESS.md`) → Claude `systemPrompt.append`, Codex `developerInstructions`, ACP once in the first prompt of a new session. Confirmed by Claude, OpenCode and Codex in real turns.
- **MCP** (`McpScopes`): global `<userData>/mcp.json` + per project `<userData>/projects/<id>/mcp.json` with `offGlobal`; Connectors tab scope switch, "From All projects" toggles, agents' own servers listed read-only.
- **Tool server**: every schema carries `required: []` (OpenCode + AgentRouter rejected `browser_logs` without it, so every OpenCode turn failed while the browser tools were offered).
- **Effort** (10G): `Thread.effort` (migration **13**), `ModelOption.efforts/defaultEffort`; Claude `options.effort` + `thinking: adaptive/summarized` when supported; Codex `turn/start.effort` + `summary: "auto"`; ACP `thought_level` via `session/set_config_option`. Brain-icon picker after the model; Ctrl/⌘+Alt+, / . cycle. OpenCode 1.18.32's ACP has no thought_level, so no picker there (variants spike in the plan).
- **Reasoning** stays expanded (only the user collapses it). The agent picker is a themed menu (Windows drew the native select popup light in dark mode); native `<option>`s are themed.
- **Git guard always on**: `guard-rules.ts` ports the skilled git-guardrails script (all `git push`, `reset --hard`, forced `clean`, `branch -D`, `checkout/restore .`, DB/infra destroyers); used when there is no script or no Python. `unwrapShell` handles `powershell -Command '…'` and `cmd /c` (Codex on Windows wrapped commands the guard never saw). OpenCode's plugin guard still needs Python + the script.
- **ACP tool rows**: harness tools named like Claude's (`browser_open`, `skill`) with their argument; a call is announced once its arguments arrive (OpenCode sends them on a later update), at the latest at its first output or its end. Closes the Phase 7 carried item.

### Phase 10, second round (2026-09-27, evening)

- **@ mentions** (`98dced6`): `@` in the message box picks project files and folders (`mentions.ts` in renderer and main); the agent gets a checked note listing them (inside the project, existing, ≤ 50); the stored message stays as typed. Checked with OpenCode.
- **Antigravity over ACP** (replaced the bespoke `agy` CLI driver, 2026-09-28): the app drives Google's own Antigravity ACP server (`agy_acp_server.par`, ACP registry `antigravity-acp`) through the generic ACP driver (`agents/acp/driver.ts`); `agents/agy.ts` and `AGY_CAPABILITIES` are gone. It takes HTTP MCP servers only (no stdio), gets per-tool permission prompts, modes, models and session resume from its config options, and cannot load the app's skills. Still behind the Settings opt-in (`OPT_IN_AGENT_IDS`, versioned acknowledgement); an `agents.json` "antigravity" entry is ignored. Phase 2 (2026-09-28) made it cross-platform and usable signed-out: the binary is `agy_acp_server.exe` on Windows and `agy_acp_server.par` on macOS/Linux (`antigravityAcpCommand()`), `onPath` no longer doubles PATHEXT for a name that already carries its extension, and there is no proactive `authenticate` (a valid profile's `session/new` refreshes the token silently; a browser is launched only when `session/new` answers -32000, and the sign-in link the server prints on stderr is relayed as a notice). Reproducible server bug worked around: after a real edit the server sends a terminal `failed` update under the permission's own id ("Tool call was approved but never executed.", ~2.7 s later, with a 2.5 s human-speed approval) even though the tool ran; the driver records permission ids per turn and drops a terminal update for an id that never announced a `tool_call`. Still honest: a real-app turn is unverified — no `agy_acp_server` is on this machine's PATH.
- **OpenCode effort** (`4fb54cf`): per-model variants from `opencode models --verbose` become `efforts`; a pick sets `agent.<mode>.{model,variant}` in `OPENCODE_CONFIG_CONTENT` and restarts the ACP process with the session resumed (notice once). Spike: a fake endpoint saw `reasoning_effort` via run and acp. Checked in the app on free `opencode/space-bunny-free` (high → low, conversation kept). Custom providers (AgentRouter, Token Harbor) define no variants → no picker.
- **file:// links** (`77cb734`): Antigravity writes `[a.ts](file:///D:/…#L2)`; they render as open-in-editor buttons, never file:// anchors.
- **T8.13** (`4638000`): migration **14** (`branch`, `worktree_path`); `createWorktreeThread` (branch `harness/<project>-<id6>`, folder `<userData>/worktrees/<threadId>`), turns/handoff/checkpoint/@-mentions/skills/terminal/Changes/Files use the thread's worktree; delete removes a clean worktree (branch kept); palette "New Thread in Worktree"; Alt+Enter starts the message as a new thread in the background. Checked in the app on a throwaway repo: file landed only in the worktree. The old stash (`stash@{0}`) is fully ported; the user can drop it.

## What the M4 round shipped (2026-09-29, Mac)

- **Token breakdown**: `ThreadEvent` `context-breakdown` (rows, total, estimated). Claude: `q.getContextUsage()` requested at `system/init` and awaited at `result` (the SDK closes a one-shot query at `result`); Codex/ACP: estimated guide + harness-tool rows. Shown in the context meter's tooltip (`Meters.tsx` `breakdownLines`). Measured Claude "hi" ≈ 23k: Messages 10.4k, **Skills 8.2k** (our plugin + `~/.claude/skills` — first trim target), system prompt 3.0k, tools 1.0k, memory 0.5k.
- **Plan mode**: `PermissionMode` `"plan"` (order ask → auto-edit → plan → full = Shift+Tab cycle, `renderer/src/modes.ts`); `TurnInput.requestPlanDecision({plan}) → "auto" | "manual" | {keep}`; Service `pendingPlans` + IPC `plan:respond`, events `plan-proposal`/`plan-decision`, broadcast `plan-approval(-done)`; `PlanApprovalCard.tsx` (never auto-resolves). Claude: SDK `plan` mode, `ExitPlanMode` in `canUseTool` → `updatedPermissions setMode`. Codex: `initialize` with `experimentalApi`, `turn/start.collaborationMode {mode:"plan"|"default"}` + `sandboxPolicy` (plan = readOnly + approval `never`, so reads don't prompt), plan from the `{type:"plan"}` item or `<proposed_plan>`, up to 6 rounds per runTurn, one `turn-end`. ACP: native `session/set_mode` when the agent advertises a plan mode, else emulated (`<harness-plan-mode>` prefix + read-only `pickPermission`). Stop while the card is up ends the turn (`fd4c151`). `capabilities.planMode` is `"native" | "emulated"`.
- **Composer**: `$name` triggers skills; `/` opens CubiQ commands (`renderer/src/commands.ts`: plan, ask, auto-edit, full, model, new; `/model` via store `requestModelPicker()`); running placeholder "Queue a message for the next turn…".
- **Freshness**: model lists re-list on a 30-min TTL (`agents/model-ttl.ts`; Claude's first re-list after 60 s because the CLI's server-side model list is cached); every CLI spawns via `binaries.ts` `resolvedCommandAsync` (warmed at start, async, sequential probes, upgrade-only); Claude uses the installed CLI when ≥ the SDK's bundled `claudeCodeVersion`.
- **Fixes**: notices written right after a user message render above it (`renderer/src/event-order.ts`, storage order unchanged); an ACP turn with no output and 0 tokens becomes an error naming the model (+ agent stderr); agent/effort menu padding.

## After Phase 9: fixes from the user's own testing (2026-09-27)

All checked in the real app on Windows; code paths are cross-platform unless noted.
- **Layout** `03fbe3f`: the app grid row sizes to the window (a long thread list pushed the header away and nothing scrolled).
- **Windows env** `47b249a` `7e572d3`: at startup the app fills user env vars and PATH folders it lacks (from `HKCU\Environment`), so an app started from an old terminal still gets `TOKENHARBOR_API_KEY` (OpenCode's config) and finds CLIs installed since (`agy_acp_server.par`). Windows-only by design.
- **Empty replies / Claude limits**: a turn that ends with nothing says so; Claude's own account-limit text is the error (it was "Rate limited" plus the text posing as a reply).
- **Codex** `8cbf5fa` `d020826`: the long-lived `codex app-server` kept a stale login (401 "workspace routing discovery" on every model); it restarts when `$CODEX_HOME/auth.json` changes, and the model list (Codex's own `model/list`, which is per plan: a free account gets 4) is re-read on login change and on window focus.
- **Threads**: rename / pin / archive / delete from a ⋯ row menu; pins and archive persist (migration 12: `pinned`, `archived`).
- **Model picker** `dc03777`: searchable, grouped by provider (OpenCode lists 87).
- **Streaming** `ad051ea`: replies and reasoning revealed at a steady pace (`smooth.ts`, `useSmoothText`); Claude Code-style waiting line.
- **UI**: header = title + panel toggles; agent / model / permissions and meters live in the message box; the project start screen asks "What should we build in <project>?" (no skill cards); Settings icon is a cog.
- Verified per model: Claude Opus/Sonnet/Haiku/Opus 1M ok (Fable 5.1 = the account's spend limit); OpenCode + 6 of 8 Token Harbor models ok (the two `:free` DeepSeek/MiMo return empty, provider-side); Codex Luna/Terra ok after the login fix.

**Open from this round:**
- **T8.13 WIP is stashed**: `git stash list` → "T8.13 WIP: worktree threads, background start, persisted pins". Its migration must become **step 13** and drop its `pinned` parts (step 12 now owns pins); `sendInBackground` and the worktree service code are in it.
- **Lucide icons**: the user asked for `lucide-react`. Adding a dependency touches `package.json` + the lockfile, which are in the user's uncommitted bun switch; do it (`bun add lucide-react`, replace `icons.tsx`) right after that switch is committed.
- **Antigravity**: Google's own ACP server (`agy_acp_server.par`, ACP registry `antigravity-acp`) must be on the app's PATH; it stays off until the Settings opt-in, then the generic ACP driver runs it with the user's Google sign-in.
- Still to confirm on the Mac: the same smoke/model checks there.

## Resume here — harness best practices (2026-10-13, Mac)

User asked for online research on building our own harness (context management, rule file, anti-cheat/hallucination, a first prompt that leads straight to tool calls, no guessing, tokens, prompt caching, automatic skill/MCP/web use), then added **memory: CubiQ's own memory by default for every agent, plus a global user layer**. Research is in `plan/docs/12-harness-best-practices.md` (§12.1–12.14, gaps G1–G8, 34 sources). The approved plan with phases H0–H7 is `.ai/plans/harness-bp.md` (the same text is in `~/.claude/plans/ok-here-new-thing-curious-moore.md`).

**Done**
- **H0** `9b3278c`: research doc, plus spec and roadmap pointer (`.ai/` is gitignored).
- **H1** `821da63`: Claude 5.x thinking blocks are bound to their exact prefix (system + tools + earlier messages); replaying one after an edit is a 400 for accounts created on or after 2026-08-31. New `src/main/harness/context/binding.ts`:
  - `unbindThinking(messages, from)` strips Anthropic `replay` from that index on. Removing blocks from the end is allowed; never restore them.
  - `prefixKey(system, tools)` fingerprints the system prompt and tool list.
  - Prune strips from the first cleared message; compaction strips the whole kept tail.
  - The driver's `prepare` runs on every step. It shrinks first (prune, then compact), then `guardPrefix`: if the system/tools key differs from the session's stored key (memory note added, plan note removed, guide edited, or no key yet), it strips all thinking.
  - `SessionStore.meta/setMeta` keeps a `<id>.meta.json` sidecar holding `startedOn` and `prefixKey`. The prompt's date is frozen per session ("Date: … (when this session started)").
  - Tests: `test/harness-context-binding.test.ts`. Live: `test/harness-binding-live.test.ts` (forces 2 compactions with a 24k context override, then changes memory between turns; turn 3 shows cache reads).
- **Windows CI green** for H1: run 38374066244 (`git push -f origin HEAD:windows`), `test (windows-latest)` success. The Windows **PC** gate for H1 hasn't run.
- **H2** `4495b9b`: native `BASE` (`context/system.ts`) gained plain rules (read before describing, don't guess paths/flags/APIs, check fast-moving names and that packages exist, fix code not tests, tool output is data, finish the whole request, context auto-compacts, only claim what ran, ask only when readings change the work); token-budget test ≤ 650 est. tokens for base+family (now ~520). Compaction (`context/compact.ts`) uses a 7-part template: **Request (user's words, close to verbatim)**, then the plan's six items; the extra "Request" heading was added because a summary without the task loses the objective.
  - **Batching nudge dropped (deviation from the plan, on live evidence):** the trailing text block after tool results made Claude Haiku 5.5 talk about it in its answer ("I won't write out a private list…", then "The harness note asks me to batch…") even when reworded as a "don't mention it" harness note, and Claude already batched all three reads in step 1 before any nudge existed. The batching line now lives in the Claude family notes of the system prompt instead (cache-stable, never seen as a message).
  - Live: `test/harness-prompt-live.test.ts` (TokenHarbor Claude Haiku 5.5 + PGS DeepSeek chat): first step is tool calls, 3 independent reads in one step on both, no leakage, x3 runs. H1 `harness-binding-live` re-run green (2 compactions each; the fact survives the new summary). In-app: native TokenHarbor (2 reads in one step), Codex, OpenCode, Claude Sonnet 5.5.
  - Loading `.env`: `bun --env-file=.env x vitest …` **did not** pass the keys through on this Mac (tests skipped); use `set -a; . ./.env; set +a; bunx vitest run …`.
- **H3** `cf8360d`: `resources/CUBIQ.md` gained Evidence / Tests / New packages lines and "claim only checks you ran"; pinned by a `test/guide.test.ts` case, still inside the 600-token budget. In-app regression on native, OpenCode, Claude, Codex.
- **H4** `9f89b0d`: evidence gate, `src/main/evidence.ts` (pure: `isTestPath`, `markerCounts` for `.skip/.only/xit/fit`, pytest/Go/JUnit skips and trivial asserts, `claimsPass` with hedge/negation filter, `ranChecks`, `evidenceFlags`) + `turnEvidence` at the end of `Service.send()` after the check gate. Flags: deleted test files; newly added skip/only/trivial asserts (an Edit's own diff when present, else `git diff -U0 HEAD` counts after vs a pre-turn snapshot of already-dirty test files, so the user's earlier skips aren't re-flagged); edits to existing tests unless the request mentions tests; a pass claim with no test/typecheck/lint/build command and no passing project check. One `notice` row "Worth a second look: …"; silent otherwise; never blocks.
  - The pre-turn snapshot now runs every turn (it ran only with a check command before): `dirtySet` uses one `git status` (`dirtyPaths` in `git.ts`) and skips git entirely when no `.git` is found upward (`hasGitDir`), so non-git turns start as before. A switch test that waited a fixed 10 ms for the permission request now uses `vi.waitFor`.
  - Live in-app (scratch `native-proj` is now a git repo with `src/math.test.ts`): seeded "skip the test, claim all pass" fired on native, OpenCode, Claude, Codex. Native and OpenCode refused to make the false claim; Claude complied, so both flags showed; Codex said "Tests not run". Clean question turns showed no notice.
- **H5** `8c8f111`: native `web_fetch` (`harness/tools/web-fetch.ts`): http(s) only, 30 s timeout, 5 MB cap, HTML → readable text with absolute links, JSON/text as is, binary refused, output through `bound()` (full page saved for paging). New `ToolAccess` "web": asks in Ask, Auto-edit **and Plan** modes, runs freely only in Full (a URL can carry data out). Live in-app on TokenHarbor DeepSeek (Fetch row renders; the agent checked with curl instead of inventing a link my prompt wrongly promised).
  - **Hosted `web_search` deferred, on evidence:** TokenHarbor rewrites the Anthropic server tool into an ordinary client `tool_use` (probe: `web_search_20260209`/`_20250305` on claude-haiku-5.5 → `stop_reason: tool_use`, no `server_tool_use` block), and Sonnet isn't on that plan; PGS has no Claude. With no first-party key there's no way to verify the `server_tool_use` / `web_search_tool_result` replay or `pause_turn`, and a wrong shape would 400 every native turn. Revisit with an api.anthropic.com or api.openai.com key; gate it to first-party hosts.
  - `test/harness-skill-routing-live.test.ts`: N1 mock kit, 50 overlapping skills (seed 7), labelled prompts (3 clear, 2 none, 2 ambiguous). Live: TokenHarbor Claude Haiku 5.5 3/3 + 2/2 ambiguous, 0 false calls; PGS DeepSeek chat 3/3 + 2/2, 0 false calls, but it also loads near-miss distractor skills alongside the right one (2–3 loads per prompt).
- **H6** `2198f47`: `/context` gains a "This thread" section (only with a thread open; "No turns yet." before the first turn-end). Pure `threadStats(events)` + `threadStatRows` in `ContextSheet.tsx`, reusing `cacheStats` (`shared/cache-stats.ts`) for the token-weighted hit rate; existing `.context-rows` classes, no new CSS. Rows: Turns; Prompt cache hit (all turns · last turn, "—" when none reported); Model steps (only when a turn reports `steps`); Tool calls; Compactions; Tool outputs cleared to fit (only when reported); Unexpected cache misses; Evidence flags.
  - Additive fields: `turn-end.steps` / `turn-end.pruned` (native agent's final turn-end only), `notice.evidence` (the evidence gate's flags).
  - Tests: `test/context-sheet.test.tsx` (threadStats, rows, render), driver turn-end carries `steps: 2, pruned: 0` / `pruned: 1` in the prune test, service evidence notice carries `evidence`. Full suite 1923 passed / 13 skipped. Tests written by opencode implementers (AgentRouter DeepSeek); parallel `opencode run` starts can fail with "database is locked", so stagger them ~20 s.
  - Live in-app (Mac, dark + light): TokenHarbor DeepSeek 2 turns → 73% all · 96% last, 4 steps · 2.0 per turn, 4 tool calls; Codex, OpenCode (Agent default) and Claude Sonnet 5.5 turns fine, their sheets correctly omit the steps/cleared rows.
- **H7 code done** (spec `.ai/plans/h7-memory.md`, anti-rot/anti-bloat rules B1–B5 / R1–R6): `543f1f7` H7a (global scope `_global`, dated notes, `.usage.json` recency, `blockIndex` global 1200 + project 3600 chars ≤ old 4800, `memory_write` with dedupe/near-dup/secret/caps, `memory_read` scope/query/caps, shorter prompt ≤ 130 tokens); `b4e2fb0` core (`memory(projectId, threadId, sessionKey)` via `MemorySnapshots`, `null` key = new session, the first real key adopts the pending block; pruned at startup); `8ac0357` H7b+c (Claude auto-memory **off**, both memory tools offered to Claude with ctx, block appended to its system prompt; Codex RAM freeze replaced by snapshots; native reads memory after `sid` so the prompt stays stable; ACP once per new session; extractor skips turns with `memory_write`, `user` adds → global; Library "Global · about you" section, scope picker, dated items, "Agents see N of M notes" line; `/context` memory row = the agent block). Full suite 1974 passed. TencentDB-Agent-Memory reviewed: ideas adopted, integration parked as a possible H8 spike ("discuss later", in the H7 spec).
- **H7d live checks — still open (do these before calling H7 done):**
  - [x] OpenCode (Agent default): a stated preference was saved with `memory_write` to the global scope (`_global/code-style-named-exports-jsdoc.md`).
  - [x] Global note reaches a second project: a new `cubiq-shop` thread read it with `memory_read` and applied it.
  - [x] Snapshots written (`memory/projects/_snapshots/*.json`).
  - [x] **Claude** (Sonnet 5.5 write, Opus 5.5 recall, 2026-10-14): `memory_write` landed in CubiQ's `_global`; no `memory` dir under `~/.claude/projects/…native-proj`; a new thread recalled it via `memory_read`.
  - [x] **Codex** (2026-10-14): recalled Claude's note, wrote its own via `memory_write`; no `~/.codex/memories`. It refused a "backup codeword" as a secret (guard works); the near-duplicate guard fired on a second codeword note.
  - [x] **Native TokenHarbor** (DeepSeek V4.1 Flash): recall + write ok. [ ] **Native PGS Grove**: not testable here — only TokenHarbor is configured in Settings → Providers; add PGS Grove with its key and run the same prompt.
  - [x] Cross-agent: Claude's note was recalled by Codex, OpenCode and native TokenHarbor; Codex's by OpenCode.
  - [x] Cache: native TokenHarbor turn 2 after a `memory_write` read 10,752 cached tokens (98%, no miss).
  - [x] Extractor: after `memory_write` turns and a wait, no duplicate or project-scope notes appeared.
  - [x] Library Memory tab checked light + dark (Global section, scope toggles, "Agents see 7 of 7 notes"); `/context` shows the Memory row and "This thread" stats.
  - [ ] Windows CI for H2–H7 (`! git push -f origin HEAD:windows`, then the `test (windows-latest)` job) and the Windows PC gate.
- **Live sweep fixes done (2026-10-14):** `f5b255a` (narrow composer: Send/Stop stays a 30px circle; long URLs in replies/thinking wrap; answered-questions row ellipsizes, no sideways scroll), `6aa5d1e` (design skill: photos in a local `img/`, load every page and fix console errors before finishing), `4402b99`: F1 `startThread` sends only to the thread `newThread` created; F2 per-message × on queued bubbles (`dequeue`); R1 **"Design it"** on the plan approval card (starts a design thread with the plan as brief, plan stays pending); F3/F4 OpenCode runs with `--print-logs --log-level INFO`, its logfmt stderr (`acp/opencode-log.ts`) becomes notices ("OpenCode's model call failed: …", "OpenCode is waiting for a permission it can't ask here: external_directory /tmp/* (often a sub-agent)…"), and `meaningfulStderr` keeps routine log lines out of "Agent said:"; F6 "Agent default" really switches: `Service.lastModel` reads the last `turn-start`, and the ACP driver drops a live session when the thread asks for a fresh one. All live-verified in the app; full suite 1995 passed. F5 (picker provider) and F8 (blank Design canvas) were **not bugs** — F8 only happens while agent-browser's CDP is attached (see findings file). Findings + root causes: `.ai/plans/live-sweep-findings.md`, `.ai/plans/sweep-fixes.md`.

## Resume here — cubiq-shop live build (fresh session)

The user wants this continued in a fresh session, after the sweep fixes (done above).

- **Project:** `~/Documents/ai-agent/cubiq-shop` (git repo; CubiQ project "cubiq-shop"; only README + `designs/` so far). Agent: **OpenCode "Agent default"** = the user's global opencode orchestrator on `agentrouter/deepseek-v4-flash` (delegates to implementer/bug sub-agents). If AgentRouter refuses with "sensitive words detected", switch that thread to PGS Grove (`pga/mimo-v2.6-flash`, lowercase entry under the PGA sub-header).
- **PRD (user confirmed):** chat thread "I want to build a small but real e-commerce web app in this…" in cubiq-shop holds the full PRD + 8-phase plan (Plan mode). Decisions: email+password auth (bcrypt, server sessions in Postgres mirrored in Redis, customer/admin roles, guest cart merges on login); mock payment; server cart in Postgres cached in Redis; ~48 seeded products in 6–8 categories + minimal admin CRUD; no variants; product photos; checkout = address + flat shipping, no tax, one transaction with `SELECT … FOR UPDATE` (stock never negative, 409 on shortfall, idempotency key); order history scoped to the user; Postgres full-text search + category/price filters, sort, pagination; Next.js App Router + Drizzle/node-postgres + zod; docker compose postgres:16 → host **54329**, redis:7 → **63799**; dev server **3100**; Vitest integration (incl. concurrency: N parallel checkouts on stock 1 → exactly one wins) + Playwright E2E smoke; named exports only + one-line JSDoc (user's global memory note), enforced by ESLint. Its plan turn was stopped (no pending card): approve **by message** — switch that thread to **Auto-edit** and say "PRD and plan approved; build it to the designs in designs/6fb93df1 (visual spec), phase by phase".
- **Design (done, working):** Design thread "Design the UI for CubiQ Shop…" → `designs/6fb93df1/` (Clean system): index, catalog, product, cart, checkout, confirmation, orders, order, account, admin + `app.css`/`app.js`/`data.js`, 28 real photos in `img/` (Wikimedia Commons). Checked: all 10 pages load, 0 console errors, every image loads (a plain static server, e.g. `python3 -m http.server` in that folder). In CubiQ's canvas the remote URLs in `data.js` are blocked by design and fall back to `img/`.
- **Then verify the real app yourself** (not the agent's word): `docker ps` shows both containers; migrations + seed ran; in a real browser (agent-browser, own session): register → search/filter → product → add to cart → reload (cart persists) → checkout → order in history → stock decreased; admin edits a product and the catalog cache refreshes; run its lint/typecheck/tests/E2E. Log any CubiQ bug found to a new findings file.
- **Driving tips:** run `agent-browser --cdp 9455 tab t1` before every snapshot (it drifts to the design shooter page); detach agent-browser before judging the Design canvas (it pauses the canvas frame's navigation); new OpenCode threads open on Claude Opus — switch via the picker's "OpenCode switch"; a watcher script that clicks "Allow Once" is needed in Auto-edit for shell commands; stagger parallel `opencode run` dispatches ~20 s ("database is locked").
- **Cleanup when the test is done (user asked; confirm before deleting):** stop/remove the shop's docker containers and volumes; delete `~/Documents/ai-agent/cubiq-shop`; remove CubiQ projects `cubiq-shop` and `inventory-app` (scratch `inventory-app` lives under an old session's scratchpad); ask the user whether the global memory note `_global/code-style-named-exports-jsdoc.md` (named exports + JSDoc) is a real preference to keep or test data.
- **Windows CI not pushed for H2–H7**: the auto-mode classifier blocked `git push -f origin HEAD:windows`. Run it yourself (`! git push -f origin HEAD:windows`) or allow it, then check the `test (windows-latest)` job.
- In-app test threads start in **Ask** mode, so tool calls raise CubiQ's own "Allow Bash?" prompt; the test driver must click "Allow Once" itself (the user shouldn't have to).

**Next (from the plan; H4–H7 are independent of each other, so use parallel worktrees per memory `parallel-worktrees`)**
- ~~H4~~ done (above). Old research map kept for reference:
  - The check gate runs at turn end in `Service.send()` (`service.ts:630-851`, gated by `project.checkCommand`; runner `check.ts:46`).
  - Changed files come from `dirtySet(cwd)` before/after (`service.ts:657,833,1335`) plus the Edit tool-use/tool-result pair (`:726-727`).
  - Commands are in canonical `tool-use` events, `payload.command` (`RunPayload`, `shared/tools.ts:53`). Native Bash is named `Bash`; `canonicalTool` maps it to `Run`.
  - The final answer is the last `assistant-text` after the user event (`service.ts:814`). The check gate emits row kind `"check"` (`types.ts:610`); tests are in `test/service.test.ts` "the project check gate" (`:622`).
  - The new gate flags: test-file edits or deletions, new `.skip`/`.only`, and a "tests pass" claim with no test command in the turn. It's a notice, not a block.
- **H5**: native `web_fetch` (bounded) + provider-hosted `web_search` where the protocol has one; a skill-routing eval on the N1 mock kit.
- **H6**: telemetry in `/context`: cache-hit %, steps, prune/compaction count, evidence flags.
- **H7**: memory. Researcher map, spot-checked:
  - Claude: `harnessToolOptions` drops `memory_read` and calls `t.run(args)` **without ctx** (`claude.ts:45,50`) → must pass `projectId`/`threadId`. Claude auto-memory is set at `claude.ts:435`.
  - `index.ts:1182` filters `memory_read` for `nativeMemory` drivers (`capabilities.ts:85`).
  - Codex freezes the memory block per session in an in-memory `frozenMemory` map (`codex.ts:393,923-954`; lost on restart). ACP sends it once with the guide (`acp/driver.ts:1080-1091`). OpenCode has no native memory of its own to turn off.
  - The HTTP tool server builds ctx from `?p=&t=` (`mcp-http.ts:164-200`).
  - Store layout `<root>/<projectId>/` with `MEMORY.md`, `INDEX_CAP` 200 lines / 4800 chars (`memory/store.ts`). Reuse `parseOps`/`applyOps` (`extractor.ts:122,171`) for `memory_write`.
  - Library UI: `MemoryTab.tsx`, IPC `memory:*` (`index.ts:1188-1196`).
  - Decision (user): turn off Claude auto-memory, give every agent the same `memory_read` + new `memory_write`, add a global `_global` layer for user/feedback notes, and freeze the memory block per session. The extractor stays as a backup.

**Live-test notes (user, 2026-10-13): test Codex, OpenCode, and the `.env` providers** (TokenHarbor, PGS Grove), plus a Claude regression turn.
- Load keys only into the env: `bun --env-file=.env x vitest run test/<live>.test.ts`, or `set -a; . ./.env; set +a` before `bun run dev -- --remoteDebuggingPort 9455`. Never print them.
- PGS Grove's plan allows only `deepseek-v4.1-flash`, `glm-5.3-flash` and `mimo-v2.6-flash`; `deepseek-v4-flash`, kimi, qwen, glm-5.2, minimax and v4-pro are refused. PGS has no Claude models.
- TokenHarbor lists `claude-haiku-5.5`, `claude-sonnet-5.5`, `claude-opus-5.5`, `claude-fable-5.1` and others. In the app, the TokenHarbor agent has only DeepSeek V4.1 Flash saved, so the Claude-binding path is covered by the vitest live test.
- App test project `native-proj` lives at `/private/tmp/claude-501/-Users-phumrin-Documents-ai-agent-aiharness/27463181-e633-4fd4-81f6-39c7f8053c0d/scratchpad/native-proj` (recreated 2026-10-13 with `src/math.ts`, `AGENTS.md`, `big1-3.txt`). It shows "Folder missing" once /tmp is cleared; recreate it.
- Picker: "<Agent> switch" options sit at the bottom of the model list; Codex `GPT-6-Luna`, OpenCode "Agent default", Claude "Sonnet 5.5".

## Resume here — Design v2 Mac test (2026-10-13, Mac)

All of V1–V7 was driven in the built app (temp `--user-data-dir`, scratch git repo, CDP 9455) on Claude Opus, Codex GPT-6-Luna and OpenCode Big Pickle. Everything worked; found and fixed:

- **Tweaks Keep pinned values the page set on itself** (a menu that shows "loading" for 700 ms at start got `data-state="loading"` written as its default and stuck on the skeleton): Keep now sends only changed tweaks (`changedTweaks` in `shared/tweaks.ts`). The panel can still *display* a load-time value (the bridge reports once at DOMContentLoaded); it's never written.
- **Cross-thread file cards**: `filesWrittenSince` attributed any deliverable written in the project during a turn to that thread, so a Build in code thread listed (and versioned) another design's `index.html` and `refs/ref-1.png`. The scan now skips other design threads' folders (`skipDirs`).
- Tier chip was a bare chevron in a narrow composer (it shares `.ds-chip-label`, hidden there): it now has a per-tier icon. Tier and design-system menus have arrow/Home/End keys (`option-keys.ts`). The "handoff first" notice is cleared on the second Build in code click; the "Kept the tweaks" notice is tied to its page. A comment pin stays readable under the hover box and label. Build in code's chat thread now gets the design's model/effort/context window (permission mode stays the chat default).

**Open, plan written, not started (needs the user's go):** files changed by OpenCode `task` sub-agents (and shell edits like `sed -i`) never reach the turn's "N files changed" card or file cards. Plan: `.ai/plans/subagent-edits.md` (touches every agent's turn end, so it's gated and pinned by tests).

Testing notes: agent-browser can't hold Shift or type into the sandboxed design frame; use raw CDP `Input.dispatchMouseEvent` (modifiers 8) / `Input.insertText` on the app page target. The design shooter's offscreen window stays up 60 s as a second CDP page: re-select the CubiQ tab before each snapshot, or a wait loop reads the wrong page. A Build in code agent may read outside the project (it read this repo's source and borrowed its node_modules; nothing written); don't blanket-approve its commands.

## Resume here — Design mode v2 (2026-10-12, Windows PC)

Plan: `.ai/plans/design-mode-v2.md` (research: Open Design, Claude Design, Figma Make, Stitch, Lovable). All seven phases committed:

- **V1** pages + variants: page switcher in the canvas title, in-frame links followed without a reload, Compare (index + up to 3 `variant-*.html`), **Use this** promotes a variant (old index kept as a version).
- **V2** Tweaks: page-declared `<script id="cubiq-tweaks">` manifest (choice/toggle/color/range), live via the bridge, **Keep** writes manifest defaults + `<html data-*>` + an `html:root` vars block (survives export).
- **V3** reference images: paste/drop into a design thread's composer → `designs/<id8>/refs/ref-N.ext` (magic-byte check, ≤ 10 MB), sent as image mentions.
- **V4** selection: persistent multi-select, breadcrumb, `data-agent-id` re-find after rewrites (lost → notice), composer chips + "Selected in …" scope block; cleared after send.
- **V5** inline text edit: double-click text in select mode; written only for a unique, text-only `data-agent-id` whose text still matches, else refused.
- **V6a** tiers Quick/Working/Real app (migration 22 `threads.prototype_tier`, chip beside System); Quick hides tweaks + text edit, comments only in Real app; tier note goes into the prompt once per change (`.tier` marker). **V6b** comments (Real app): pins in the frame, list with resolve/delete, **Send to agent** as one message; `comments.json` in the design folder (the watcher ignores it and `.tier`).
- **V7** five-lens critique (Brief .4, Tokens .2, A11y .2, Copy .2, Layout 0; 8.0 ships; ≤ 2 rounds) and **Build in code** (Real app): writes the handoff first if missing, then a background chat thread implements the design with the codebase's components.

Known gaps: `DESIGN-MODE.md` is at ~698/700 tokens (new rules live in the skills); DeepSeek on OpenCode can't see reference images; AgentRouter often returns nothing (opencode workers and OpenCode live turns), and this PC's `opencode.json` has no fallback model. Pushed to `origin/m4` on 2026-10-12; not run yet: Mac, Windows CI (check the GitHub Actions run for these commits first). On this PC, the opencode workers need `OPENCODE_BIN=~/.bun/install/global/node_modules/opencode-windows-x64/bin/opencode.exe` and the AgentRouter proxy (`~/.config/opencode/start-proxy.bat`); add a `fallback_models` entry to `opencode.json` to stop one dropped stream from failing a whole dispatch. When seeding a test thread, give it a real model id (Codex `default`).


## Resume here — native agent N4 + N5 done (2026-10-09, Mac)

N4 `6c71dae`: `harness/plan.ts` — `propose_plan` (read access, offered only in plan mode) calls `requestPlanDecision`; auto/manual flips a turn-local mode used by `authorize` and splices `PLAN_MODE_NOTE` (last system part) out so the same turn implements; keep → feedback as the tool result; Stop → "Interrupted". `ask_user` via `askUserTool` + `input.requestUserInput`. `harness/subagent.ts` — `task` tool (display "Agent", read access so several run in parallel): child `runLoop` with read/glob/grep only, `EXPLORE_PROMPT`, 30 steps, events re-emitted with `parentId` = task call id (renderer nests them), child usage folded into turn usage. Live on TokenHarbor: plan → approve auto → edit without asking (commands still ask), mode chip → Auto-edit; two parallel explore agents answered correctly, nested.

N5 `a101baa`: deleted `gateway/route.ts`, `anthropic-chat.ts`, `responses-chat.ts` (kept `gateway/chat-stream.ts`, used by `harness/llm/client.ts`), the tool server's `/llm/` route, `codexPin`/`gatewayEnv`/`pin`, `inject/acp.ts`, `inject/codex.ts`, the BYOK injectors in `inject/claude.ts`/`opencode.ts` (kept `CLAUDE_KEY_VARS`, OpenCode variants), `byokModels`, `setCredential` (settings, IPC, preload, API type, mock). `injectionFor(source, agentId, env)` now always returns the subscription plan with provider/Claude key vars stripped (new regression test). `test/opencode-guard.test.ts` e2e kept, now with a hand-built `OPENCODE_CONFIG_CONTENT` plan. README Settings bullet rewritten. Follow-up commit removed the last hooks: `extraModels` (Claude/Codex/ACP), the provider ctx of `injection()`, `InjectionPlan.model`/`.pricing`, the `providerInjection` setting; `spec/README.md` marked superseded. Still in place on purpose: `service.ts` fallback notice for threads on an old `unskilled-*` model (+ `providerOfModel`/`PROVIDER_MODEL_PREFIX` it uses); `settings.credential()` (always subscription); historical spec/plan docs.

Verified: typecheck, 1659 tests (drop = deleted dead tests), build, smoke; live turns on Claude Sonnet 5.5, Codex GPT-6-Luna, OpenCode default, TokenHarbor DeepSeek V4.1 Flash after N5.

opencode workers this session ran on `explabs/deepseek-v4.1-flash`, then (user, low credit) `PGA/deepseek-v4-flash-0731` (PGS Grove); the PGA/pga `apiKey` in `~/.config/opencode/opencode.json` was refreshed from the repo `.env` `PGS_API_KEY` (backup `opencode.json.bak.<ts>`). Twice a worker reported "failed / no work done" while its first attempt had already edited files — always judge by `git status`/diff, never the report.

**Next**: Windows PC gate for the native agent (bash tool → Git Bash/PowerShell, `rg` fallback, CRLF in edit/apply_patch, a live TokenHarbor turn on Windows); optional trim: `CredentialChoice` / stored `credentials` settings data once a migration drops it.

## Resume here — native agent N3 done, N4 next (2026-10-09, Mac)

N2 committed `d05c0c1` (Codex GPT-6-Luna + OpenCode default regression turns passed first; build + smoke green). N3 committed `a995169`: `harness/context/` — `estimate.ts` (chars/4), `prune.ts` (old tool output → marker; protect newest 40k, only if ≥20k frees, never `skill`), `compact.ts` (split at user turns **or** at an assistant step after a tool batch, so one long turn can compact; OpenCode v2 template; summariser input capped at 60% of the window; touched-files index), `files.ts` (AGENTS.md then CLAUDE.md, deduped, 12k cap — `guide.forCwd` never includes them), `system.ts` (per-family notes; gpt family = `patchesNatively`, from the wire id). Driver: limit = max(75%, window − 20k); prune, then auto-compact (at most once until history grows 20% of the limit); compact-and-retry once on an overflow before output; `/compact [focus]` (`manualCompact: true`); first-turn `context-breakdown` (estimated); `skill` tool via the `skills(cwd, design)` dep (`skillsDelivery: tool, reads: []`). Prompt caching note: compaction rewrites the session file, so the cache prefix resets once per compaction.

Live (dev app, test project `native-proj` in this session's scratchpad `/private/tmp/claude-501/-Users-phumrin-Documents-ai-agent-aiharness/27463181-…/scratchpad/native-proj`, has `big1-3.txt` + `AGENTS.md`): TokenHarbor `deepseek-v4.1-flash` with a temporary 24k `contextWindowOverride` (restored to none afterwards) compacted 3× mid-turn and answered correctly; `/compact keep the secret words` 11k → 863 tokens and recall held. Claude Sonnet 5.5, Codex GPT-6-Luna, OpenCode default all passed after the change.

**Next**: N4 plan mode (`requestPlanDecision`, read-only tools in plan mode) + `task` subagent tool (child session, depth 1, read-only explore agent); then N5 cleanup (gateway / `inject/*` provider paths / `codexPin` / `SwitchDialog` provider handling).

## Resume here — native agent N2 (2026-10-09, Mac)

Goal (user, 2026-10-09): a saved provider (TokenHarbor, PGS Grove, …) is **its own agent** next to Claude, Codex and OpenCode, run on **CubiQ's own harness** (`src/main/harness/`, modelled on OpenCode v1/v2), with no link to the other agents. Plan + phases N1–N5 + decisions: `.ai/plans/native-agent.md` (approved; subagents in scope; Windows bash = Git Bash, else PowerShell).

**Done and committed**: N1 `75beae1` — `harness/llm/` (one request/event type; OpenAI chat, Responses, Anthropic Messages adapters; adaptive thinking on Claude 4.6+, budgets elsewhere; 3 cache breakpoints; retry only before output; idle timeout; key masked in errors). `test/harness-llm-live.test.ts` runs live when `TOKENHARBOR_API_KEY` is set.

**Done, uncommitted (commit as N2 once the last two checks pass)**:
- `harness/tools/`: read, write, edit (exact + fuzzy cascade), apply_patch (GPT/o-series/codex models get it instead of edit), glob/grep (JS walker, `rg` if on PATH), bash (Git Bash → PowerShell on Windows, tree kill, guard, answers 250 ms after exit even with a background job), todowrite → thread plan. Contract: `tools/types.ts`, `paths.ts` (read-before-write per session), `bound.ts` (2000 lines / 50 KB, full text saved for paging).
- `harness/loop.ts` (parallel read-only calls, serial edits/shell, doom loop at 3, every call gets a result on Stop), `permissions.ts`, `prompt.ts`, `session.ts` (JSONL per session in `userData/harness-sessions`, no DB migration), `driver.ts` (agent id `provider-<id>`, guide + memory + app tools + MCP router), `register.ts` (`ProviderAgents`), `service.syncDrivers`, wiring in `index.ts` (sync at start and after every provider change).
- Decouple (N2c, opencode worker on `explabs/deepseek-v4.1-flash`, reviewed): Claude/Codex/OpenCode no longer list provider models; `settings.credential()` always subscription; Settings has no per-agent credential rows (new copy); a thread still on `unskilled-*` falls back to its agent's default with a notice; `smokeProviders` rewritten for the new path.
- `.gitignore` now ignores `.env`; test keys live in repo-root `.env` (`TOKENHARBOR_API_KEY`, `PGS_API_KEY`, mode 600). Load with `set -a; source .env; set +a`; never print them.

**Live state (dev app data `~/Library/Application Support/CubiQ`)**: TokenHarbor saved with `deepseek-v4.1-flash` only (user: don't use gpt-5.5; their plan excludes kimi/claude-sonnet-4.6 — included: deepseek flash, gpt-5.x, claude-haiku-5.5). Test project `native-proj` lives in the old session's scratchpad (`/private/tmp/claude-501/…/scratchpad/native-proj`); remove it from the sidebar and use a fresh one.

**Next, in order**:
1. Regression turns on **Codex** (GPT-6-Luna) and **OpenCode** (agent default / free model) in a throwaway project — Claude (Sonnet 5.5) already passed. Launch: `set -a; source .env; set +a; bun run dev -- --remoteDebuggingPort 9455`, drive with `agent-browser --cdp 9455`. Another session can kill the dev app (`pkill electron-vite`); just relaunch.
2. Commit N2 (≤150 chars, no trailer; only the harness files, `index.ts`/`service.ts`/`settings.ts`/`smoke-checks.ts`/`ProviderSheet.tsx`, `.gitignore`, and the changed tests), then `rm .ai/tmp/n2*` (leave other sessions' files).
3. N3 context: per-model-family prompt, staged pruning + structured summary compaction (OpenCode v2 template) before overflow, compact-and-retry once on overflow, `/compact`, context-breakdown, skills via a `skill` tool. Then N4 plan mode + `task` subagents, N5 delete the unused gateway/inject/codexPin/SwitchDialog provider paths.

Workers: user wants opencode delegation with `-m explabs/deepseek-v4.1-flash` (`opencode run --agent orchestrator -m explabs/deepseek-v4.1-flash "<brief>"`, subagents inherit it). Never put keys in briefs (a worker reading `.env` would send them to a third-party model) — drive key entry yourself.

## Resume here — D4 done, Design mode complete (2026-10-09, Mac)

D4 committed `f15c9df` (plan `.ai/plans/d4-evaluator-export.md`, approved 2026-10-09). D4a (lint + inline modules + tests) by the opencode implementer on the first try, reviewed here; shooter, tools, wiring, UI, content here.
- **Design tools (design threads only)**: `design_screenshot` (offscreen window, PNG, width 320–2560, fullPage capped at 4000), `design_lint` (one page script: 4px grid, token colors, contrast 4.5/3, 44×44 targets; ≤40 findings worst-first with selectors), `design_critique_save` (markdown → the thread's Critique artifact, versioned like the plan; unchanged text adds none). Chat threads' tool lists, the Codex tool URL and the guide are byte-identical (regression-pinned in tests). Claude gets them via `input.tools`; Codex via `&d=<threadId>` on the tool-server URL; OpenCode via `?t=` (already there).
- **Shooter** (`main/design/shooter.ts` + `shot-window.ts`): one hidden, offscreen, sandboxed window; loads only `cubiq-design://`; navigation/window.open denied; destroyed 60 s idle and on quit (verified live); Retina captures resized to CSS px; PDF uses the page's own `@page` (deck.css 20×11.25 in → 1440×810 pt slides, verified 3 slides → 3 pages).
- **Export**: canvas toolbar ▸ Export (HTML one file offline, PNG full page at the viewport width, PDF), on the version on screen; saved name from `<title>`, else `design-<id8>`; the HTML inliner reads only inside the design root and never includes the bridge (verified: 0 external refs, 0 bridge markers).
- **Content**: `design-critique` SKILL.md now screenshot 390+1440 → lint → rubric → save → fix, ≤2 rounds, save each round; `DESIGN-MODE.md` one line naming the three tools; README + `plan/docs/HARNESS.md` one line each.
- **Live (built app, temp data dir, save dialog patched through the main-process inspector)**: Claude Opus built a landing page then critique+fix (screenshots 390/1440, lint both, Critique v1 2074 B / v2 1813 B, panel showed "Critique" with Latest/v2/v1); Codex built a 3-slide deck + critique (screenshots, lint, v1 1390 / v2 883 B; deck PDF 3 pages); OpenCode did the same (screenshots ×2, lint rounds, v1 1597 / v2 1758 B) — its first turn delegated to its own implementer subagent and hung ~9 min, a direct "no subagents" prompt worked. Chat threads on Claude (Haiku), Codex, OpenCode each answered "none" to a design_* tool probe. Export menu at 900px: no horizontal overflow, dark + light (screenshots in the session temp dir). OpenCode's free model can't view images (tool returns PNG fine — model limitation).
- **Observed, pre-existing, now fixed**: Claude in Full access carded Bash commands its shell parser can't read (heredocs, code from stdin) — the CLI routes them to `canUseTool` even under `bypassPermissions`. `9c40392`: the driver answers that callback itself in full mode (git guard still runs; unit-pinned in `claude.test.ts`); re-checked live — the heredoc ran with no card.
- **Fixed after the live pass**: the Windows `windows`-branch CI had been red since D2 — `design-watch`'s cleanup removed the project folder because it trusted `mkdirSync`'s returned path (different spelling on Windows). `7f449f7`: compute the created chain from the watched path. Windows CI green (`37881110802`, `37882283968`).

**Next**: the Windows PC gate (live checks for D1–D4 on the PC; CI is green), or the user's pick. The native agent is a parallel workstream (N1 committed `75beae1`; N2 in progress in another session).

## Resume here — D3 done, D4 next (2026-10-08, Mac)

D3 committed `c65337f` (plan `.ai/plans/d3-design-brain.md`, approved 2026-10-08). D3a (skill `mode`, `forAgent` design option, `main/design/systems.ts` + tests) by the opencode implementer on the first try, reviewed here; wiring, content and UI here.
- **Guide**: `resources/DESIGN-MODE.md` (≤700-token test) replaces `designNote` for design threads (`createGuide({ designMode })`, `{dir}` filled in; `designNote` stays as the fallback when the file is missing). Rules: build at `designs/<id8>/index.html`, follow `system/DESIGN.md` + link `system/tokens.css`, 8pt scale, 4px baseline, 44px targets, 4.5:1, states, no network, which `design-*` skill fits.
- **Design-only skills**: six `resources/skills/design-*` (`prototype`, `mobile`, `slides` with `deck.js`/`deck.css`, `system-extract`, `critique` + `references/rubric.md`, `handoff` + template), all `mode: design` in frontmatter. `forAgent(…, { design })` keeps them out of chat threads: Claude gets a separate plugin dir per cwd+design, Codex a separate extra root per cwd+design, OpenCode's skill tool looks up the thread kind from `?t=` (`mcp-http.ts` `extra(pid, tid)`). Context sheet counts them only for design threads; the composer `$` menu hides them in chat (`Composer.tsx` filter on `threadKind`).
- **Claude asks for paths outside its directories even in Full access** (verified live: a Full chat thread prompts for `head -1 <repo>/resources/...`). Design threads now pass `additionalDirectories` = design plugin dir + bundled + harness skills dirs (`ClaudeDriverConfig.skillDirs`), so skill scaffolds read without a prompt. Chat threads unchanged (pre-existing behaviour for chip skills with assets, e.g. pptx).
- **Design systems**: `resources/design-systems/{clean,dashboard,editorial,mono,playful}/{index.md,DESIGN.md (Stitch 9 sections),tokens.css}`, one shared token contract (`--color-*`, `--text-*`/`--leading-*`, `--space-1..24` = 4…96, radius, shadow, motion), light + dark, system fonts only; every text pair ≥4.5:1 (checked). Generated `tokens.css`/`index.md` from one table (script was in the session scratchpad, not kept); hand-written DESIGN.md. Order: project `DESIGN.md` ("Project") → `.agents/design-systems/*` → built-ins; default Project, else Clean. Migration 21 `threads.design_system` (nullable; `Store.setDesignSystem`, not activity; kept on restore; never on chat). `Service.prepareDesignSystem` copies the chosen system into `designs/<id8>/system/` before each turn when changed (sha check, `.system` marker); a switch adds one line to that turn's prompt, once. md/css aren't turn-end artifacts, so `system/` never shows as one. `electron-builder.yml` ships `DESIGN-MODE.md` and `design-systems`.
- **UI** (DESIGN.md §7.3): `components/DesignSystemMenu.tsx` chip beside the mode chip in design threads and design drafts (swatches + name; label/chevron hide in a narrow chat like the mode chip), menu with 4 swatches + 2-line description, re-lists on open. Store `draft.designSystem`, `newThread(skills, { designSystem })`, `setDesignSystem`. Experts data moved to `shared/experts.ts`: UI Designer (prototype, Clean), Mobile Designer (mobile, Clean), Slide Designer (slides, Editorial), Design-System Architect (system-extract, default), UX Critic (critique); "Start design" switches to Design and opens a thread with the skill chip and system. The five non-design cards still open a plain thread (placeholders, unchanged). Main bundle +7.7 kB.
- **Verified**: typecheck, 1577 tests (new `design-brain`, `design-systems`, migration 21, Claude `additionalDirectories`, store design-system opts), build, smoke. Live (built app, temp data dir, Full access): Claude Opus via UI Designer built a landing page linking `system/tokens.css`; Codex GPT-6-Luna via Slide Designer built a 4-slide Editorial deck (copied `deck.js`, arrows navigate in the canvas); OpenCode (Agent default) loaded `design-prototype` through CubiQ's skill tool, built a Mono sign-in page, then Mono → Playful switch restyled it; chat `$design` shows nothing, design shows all six; Claude chat plugin dir has 0 design skills, design one 6; dark 900px with the picker open.
- **Known / not done**: the context sheet's guide estimate still leaves out the design guide (since D2). A deck reloads to slide 1 on live reload (opaque-origin frame has no storage). With a skill chip in the box, `/full` etc. are sent as text, not run as commands (pre-existing). Codex's extra skills root is app-server wide: parallel design + chat Codex turns in one project can briefly see each other's set. OpenCode first tries its own native `skill` tool before CubiQ's (works, one wasted call).

**Next: D4** (`design_screenshot` offscreen window + `design_lint`, critique loop ≤2 rounds saved as a pseudo-artifact, export HTML/PNG/PDF; spec `.ai/plans/mcp-providers-design.md` Part 3 › D4). Write `.ai/plans/d4-*.md` and get approval first.

## Resume here — D2 done, D3 next (2026-10-08, Mac)

D2 committed `89530f2` (plan `.ai/plans/d2-live-canvas.md`, approved 2026-10-08; Export moved to D4; designs live in the project's `designs/<id8>/`). D2a (serve/watch/bridge + tests) by the opencode implementer, reviewed here; wiring and UI here.
- **Agent side**: design threads get a stable design note appended to the guide (`guide.ts` `designNote`, `TurnInput.design`, `guide(cwd, design)` in Claude/Codex/ACP) telling them to build `designs/<id8>/index.html`, no remote assets. D3 replaces it with `DESIGN-MODE.md`.
- **Serving**: `cubiq-design://d/<threadId>/<rel>[?v=N]` (`main/design/serve.ts`): design threads only, `resolveInside` on the design root, CSP with `connect-src 'none'` (no network), ACAO `*`, no-store, nosniff; html gets the bridge (`main/design/bridge.ts`: scroll report/restore, pick mode using the now top-level `selectorFor` from `browser/picker.ts`). Renderer CSP `frame-src` + `cubiq-design:`.
- **Watch**: `DesignWatcher` (recursive `fs.watch`, 150 ms debounce, refcounted per window, released on window destroy/navigation, `closeAll` on quit; removes the `designs/<id8>` folders it created if still empty) → push `design-changed` → store `designReload` nonce → canvas remounts the frame, scroll restored.
- **Canvas** (`renderer/src/design/DesignCanvas.tsx` + `frame.ts`): `iframe sandbox="allow-scripts"`; toolbar Viewport (Fit/Mobile/Tablet/Desktop/Slide, sizes as detail), Zoom (hidden on Fit), Version (Latest/vN via `?v=N`, "Viewing vN" bar), 8px grid, Pick, Reload, Open folder. Bridge messages validated field by field (`readBridgeMessage`), only from the frame's own window. Pick → composer chip in the browser-pick format.
- **Layout**: `clampLayout(…, mainFloor)`; design threads reserve `DESIGN_FLOOR` 620 (chat 260 + canvas 360) so the side panel narrows/collapses first. A design thread's own pages don't auto-open the side panel (other files still do; chat threads unchanged). Collapsed rail and sidebars under 230px get a one-icon Chat/Design toggle (`ModeToggle`).
- **Regression pins** (user: don't break existing features): guide output unchanged without design, `clampLayout` unchanged without floor, chat-thread auto-open, picker/bridge scripts self-contained; live: browser-pane pick still makes its chip, a Claude chat turn writing `hello2.html` auto-opened the panel.
- **Verified**: typecheck, 1545 tests, build (DesignCanvas chunk 11.8 kB), smoke; live (temp data dir): Claude Opus landing page, pick → "make this button bigger" → v2 and v1 view; Codex GPT-6-Luna two-step write showed mid-turn; OpenCode Ling sign-up page mid-turn; probe page: `js-ran top-denied fetch-blocked img-blocked`; Mobile + grid; dark 900px; narrow sidebar toggle.
- **Notes**: the Mac disk filled (ENOSPC) mid-session: other projects' Claude temp dirs (`Kotluy` 5.6G, `cambodia-center` 3.4G under `/private/tmp/claude-501`) — not touched. Two untracked `Screenshot … .png` files in the repo root are the user's, left alone. Ling 3.1 Flash Free sometimes ends a turn with "Upstream request failed: Endpoint is unavailable" (no turn-end → no artifact push; pre-existing).

**Next: D3** (design brain: `resources/DESIGN-MODE.md` guide layer, `design-*` skills, design systems as data + picker, Experts presets; spec `.ai/plans/mcp-providers-design.md` Part 3 › D3). Write `.ai/plans/d3-*.md` and get approval first.

## Resume here — D1 done, D2 next (2026-10-08, Mac)

D1 committed `86f71c0` (plan `.ai/plans/d1-design-shell.md`, approved 2026-10-08). D1a by the opencode implementer (first try, reviewed here), D1b here.
- **Data**: `ThreadKind`, `Thread.kind` (absent = chat), migration 20 `threads.kind` default `'chat'`; create (IPC validates, anything else → chat), worktree and restore keep it.
- **Renderer**: store `threadKind` + `setThreadKind` (switching selects the project's latest thread of that kind, else none); `selectThread` follows the thread's kind (⌘K / Message Center / startup); New thread makes the current kind ("New design" label, design start-screen copy). Sidebar `.segmented.compact.mode-switch` at the right of the brand row (toggle keeps its spot by the traffic lights); `inboxModel({ kind })` filters Pinned/Recent/Archived, Running shows every kind; ⌘1–9 uses the same filter.
- **Layout**: `.app.design-thread` = `sidebar | chat | canvas [| inspector]`; chat = 45% of the room beside the sidebar and panel, clamped 260–420px; canvas `design/DesignCanvas.tsx` via `React.lazy` (own 0.86 kB chunk; main bundle +2.7 kB for the switch/store). Windows caption padding moves to the canvas header.
- **Fixed on the way**: at a 260px chat the context ring's wrapper (also `.model-picker`) shrank to 8px and its button overlapped Send; now `flex: 0 0 auto`, and under 300px the mode/model chips drop their chevrons.
- **Verified**: typecheck, 1508 tests (new `test/design-mode.test.tsx`, db migration/create/restore tests), build, smoke; live in the built app (temp data dir): design threads on Claude Sonnet 5.5, Codex GPT-6-Luna, OpenCode Ling 3.1 Flash Free (twice each, last on the final build), Chat/Design filtering, ⌘K jump flips to Design, light/dark, 900/1100/1280px, no horizontal scroll. Not live-checked: a running design thread listed under Running in Chat mode (unit-tested).
- **Known, for D2**: with the side panel open at ~1100px the canvas is only ~160px (chat 260 + panel 424); D2 should decide whether the canvas replaces the artifact panel for design threads or the panel cap counts the canvas. With the sidebar collapsed the switch isn't reachable (rail has no Chat/Design control).
- The user allows **Opus** for Design-mode live tests (2026-10-08).

**Next: D2** (live canvas: `cubiq-design://`, sandboxed iframe, `fs.watch` reload, toolbar, pick-to-comment; spec `.ai/plans/mcp-providers-design.md` Part 3). Write `.ai/plans/d2-*.md` and get approval first.

## Resume here — D1 next (2026-10-08, Mac)

The user said start Design mode with D1. Plan written: `.ai/plans/d1-design-shell.md` (gitignored, Mac only; summary below). **Ask the user to approve it before any code.** Parent spec: `.ai/plans/mcp-providers-design.md` Part 3.
- **D1a data** (opencode implementer, ≤5 files): `ThreadKind = "chat" | "design"`, `Thread.kind?` (absent = chat); migration 20 `ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'` after step 19 in `db.ts` (`steps` ~:95-200); kind in `createThread` (`db.ts:289`), `restoreThread` (`:627`), `THREAD_COLS` (`:709`), `toThread` (`:807`); `createThread(projectId, agent?, { worktree?, kind? })` through preload (`:14`), IPC `threads:create` (`index.ts:1104`, validate → chat), `service.createThread`/`createWorktreeThread` (`service.ts:168-193`).
- **D1b renderer** (do here; DESIGN.md §2–5, §7.1, §8, §9): store `threadKind` + `setThreadKind`, follows the selected thread's kind; `newThread`/`sendInBackground` (`store.ts:709-753`) pass it. Sidebar brand row (`Sidebar.tsx:321-326`): `.segmented.compact` Chat | Design (`aria-pressed`, no-drag); project lists, Pinned, Archived filtered by kind via `inboxModel` (`sections.ts:27`), Running shows all. Design thread layout: `.app.design-thread` grid `sidebar | chat 420px | canvas 1fr [| inspector]`, existing `main` = chat column, canvas = `React.lazy(() => import("./design/DesignCanvas"))` empty state (real frame/toolbar/live reload = D2). Browser-wide still wins.
- **Verify**: typecheck, suite, build (design chunk separate; Chat bundle size unchanged), smoke; live: a design thread on Claude (Haiku), Codex, OpenCode (free model), filters, ⌘K jump flips the mode, light/dark + 900px screenshots. Then commit D1 (≤150 chars, no trailer), `rm .ai/tmp/*`.
- Then D2 (live canvas: `cubiq-design://`, sandboxed iframe, `fs.watch` reload, toolbar, pick-to-comment), D3 (guide + skills + design systems + Experts), D4 (screenshot/lint tools, critique loop, export).

## Resume here — P3 done (2026-10-08, Mac)

Plan: `.ai/plans/p3-presets.md` (gitignored, Mac only).
- **Presets** (`shared/provider-catalog.ts`): TokenHarbor (`https://tokenharbor.ai/v1`, `TOKENHARBOR_API_KEY`) and PGS Grove (`https://api.pgsgrove.com/v1`, its docs name no key var) on `openai-chat`, so every agent reaches them (Claude/Codex via the gateway). New `alsoServes`: both hosts also answer Messages and Responses on the same `/v1` (probed: 401 there vs 404 on a bogus path); the editor says so.
- **Add from catalog**: `ModelsDev` now keeps models.dev's providers (`catalogProtocol`: `@ai-sdk/anthropic`→messages, `@ai-sdk/openai`→responses, `@ai-sdk/google`→gemini, else chat; no `api` URL or Bedrock/Vertex/Azure/SAP/watsonx/GitLab → left out; OpenAI/Anthropic/Google get their public URL from `FIRST_PARTY_API`). IPC `providers:catalog` → `searchProviderCatalog`. Editor row "Catalog": pick fills id/label/protocol/URL/key hint/docs and opens the model checklist (with prices); a curated preset with the same id wins; note "From models.dev, not tested by CubiQ". The MiniMax/DeepSeek-anthropic/Moonshot/Z.ai and Azure/Bedrock/Vertex presets stay unlisted (no keys); MiniMax is reachable via the catalog.
- **Prices**: `ModelOption.cost`; picker rows show `$in / $out` per 1M (mono, tabular, muted) for provider models only; OpenCode's own copy of a saved model keeps the price (`acp/driver.ts`). Cache-read prices are now kept (models.dev `cache_read`, PGS `cached_input_per_m`, OpenRouter `input_cache_read`), which Claude gateway turns already use (`agents/claude.ts` `priceUsage`).
- Implementer (opencode) wrote the catalog parsing + tests on the first try; reviewed here (reserved ids now imported, empty query sorted).
- **Keys**: the user pasted TokenHarbor + PGS keys in chat on 2026-10-07 (again); entered only through the app editor into temp data dirs; nothing in repo, data dirs, logs, `~/.claude/projects` (non-transcript) or `~/.codex/sessions`. Both revoked by the user 2026-10-08; ask for fresh keys for any live provider test.

**Next: Design mode D1–D4** (see **Resume here — D1 next**). The Windows PC gate below still covers M1…P3 when the PC is at hand (add: P3 catalog search + a preset save on Windows).

## Windows gate (2026-10-07)

**CI (windows-latest): green** — run `37596111446` on `m4` at `16241a4` (after the killTree test fix): 135 files / 1481 passed, 10 skipped; build OK. Real Claude Code through the gateway (`gateway-claude-e2e`), `claude-e2e`, both translators, the route, `.cubiq` guide and skills all ran on Windows. Skipped there (no codex/opencode in CI): `codex-e2e`, `gateway-codex-e2e`, `opencode-e2e`. The first run (`37594861457`) failed only on `winspawn.test.ts` cleanup (EBUSY: Windows keeps a killed process's cwd locked) → the test's child now runs from `tmpdir()`.

**PC run: pending** (needs the Windows PC). Covers everything since M1. Do it in order; a phase isn't done until it passes:
1. `git pull` on `m4`; Node ≥ 22.18 (else `db.test` fails on `.ts` workers); `bun install`; `bun run typecheck && bun run test && bun run build`; `electron . --smoke --user-data-dir=<tmp>`.
2. Real CLIs through the shims: `UNSKILLED_CODEX_BIN=<codex.cmd path> npx vitest run test/codex-e2e.test.ts test/gateway-codex-e2e.test.ts test/opencode-e2e.test.ts` (the gateway one checks Codex's per-thread provider + `CUBIQ_GATEWAY_TOKEN` via `winspawn`). Codex 401 "workspace routing" on this PC = sign in again.
3. Live app (temp `--user-data-dir`, CDP, recipe in **Environment facts**), scratch project with `.cubiq/CUBIQ.md` (codeword) and `.cubiq/skills/cubiq-probe` (probe phrase), checked out with CRLF:
   - **C0**: Claude, Codex, OpenCode each answer the codeword and load the probe skill (OpenCode via its skill tool, Codex from `harness-skills-projects\<hash>`); a project with only `.agents/HARNESS.md` still gets its guide.
   - **MCP M1–M4 + leftovers**: mock stdio server (`test/fixtures/mock-mcp-stdio.mjs`) and SSE fixture (`mock-mcp-sse.mjs`) on all three agents; `/mcp` sheet; POSARA read-only tool only (`get_branches`).
   - **P1/P1d**: provider editor Fetch models + Test before save + a secret header; an OpenCode thread on a provider model.
   - **P2**: Claude thread pinned to a TokenHarbor chat model (tool call + follow-up; it must name the scratch folder as its cwd); Codex thread pinned to it (shell command), then switch to GPT-6-Luna → new session + handoff notice; interrupt a gateway turn.
   - Afterwards `grep`/`findstr` the data dir, app log, `~/.claude/projects`, `~/.codex/sessions` for the key: nothing.
4. Fresh TokenHarbor/PGS keys from the user (the 2026-10-07 ones are to be revoked), entered only in the app.

## Resume here — C0 + P2 done, next Windows gate (2026-10-07)

Plans: `.ai/plans/c0-cubiq-folder.md`, `.ai/plans/p2-gateway.md` (spike results + per-phase notes; gitignored, Mac only).

**C0** (`ac88d64`): project guide `.cubiq/CUBIQ.md` (else `.agents/HARNESS.md`, never both); bundled `resources/CUBIQ.md`; `<userData>/HARNESS.md` renamed to `CUBIQ.md` once (`guide.ts` `userGuidePath`). Skills origin `projectCubiq` (`.cubiq/skills`, first). Live testing showed Codex/OpenCode never got project skills except the ones they read natively: Codex now gets a per-project merged dir (`<userData>/harness-skills-projects/<hash>`, `skills/extraRoots/set` before thread start/resume), tool-mode agents a per-project skill tool (`/mcp-skills?p=`; `TOOL_SKILL_READS` in `index.ts`; OpenCode reads `.claude/skills` natively).

**P2 gateway** (`src/main/gateway/`): `/llm/<providerId>/…` on the tool server with its **own** per-launch token (`llmUrl`/`llmToken`); key + headers added in main, never in an agent's env/argv/files.
- Claude (`/v1/messages`, `anthropic-chat.ts`): a thread on `unskilled-<provider>/<model>` pins it (`injection(ctx)` async; plan `model` = wire id, `pricing` from the saved model's `cost`, else no cost shown). Claude Code sends `HEAD /api/hello`, treats any 404 as "issue with the selected model" (gateway maps 404→400), and puts its environment (cwd, platform) in a **`role: "system"` message inside `messages`** — merged into the system prompt before the first answer, `<system>`-tagged user message after.
- Codex (`/v1/responses`, `responses-chat.ts`; Responses providers pass through): per-thread `config.model_providers.unskilled-<id>` + `modelProvider` + wire model on `thread/start`/`resume`, `env_key=CUBIQ_GATEWAY_TOKEN` set at app-server spawn; one app-server serves subscription and gateway threads. Leaving a gateway provider for Codex's own models → `setModel` returns new-session (OpenAI rejects the gateway's `cubiq:` reasoning `encrypted_content`).
- Picker: provider models listed on Claude/Codex/OpenCode; another agent's copy is hidden when this agent has it. Provider rows say "Through CubiQ's gateway". Model `cost` now survives Fetch models.
- Delegation: the two translators came from the opencode implementer (Responses one on attempt 2; attempt 1 empty, AgentRouter "sensitive words"), reviewed + fixed here.

**Keys**: TokenHarbor `thk_live_…` and PGS Grove `pgsk_plan_…` (`https://api.pgsgrove.com/v1`) were used live 2026-10-07 via the app's encrypted save only; no trace in data/logs/sessions. The user should revoke both now.

**Next**: Windows gate for everything since M1 (MCP M1–M4 + leftovers, P1, P1d, C0, P2: check `.cubiq` paths, the gateway on Windows, Codex per-thread providers with the npm shim) + CI; then P3 presets (+ pricing), D1–D4. Open: weaker models on the gateway don't always follow instructions as well (model quality, not a bug); untracked screenshot in the repo root is the user's.

## Resume here — P1 done, next P2 (2026-10-07)

Plans: `.ai/plans/p1-providers.md`, `.ai/plans/p1d-picker.md` (gitignored, Mac only). All committed; tree clean except `electron.vite.config.ts` (a formatting-only change nobody asked for: keep or `git checkout` it, the user decides).

**Shipped this session**
- `2466589` MCP: SSE bridge keeps a session per agent and forwards upstream `tools/list_changed` (Claude called a tool added mid-turn); the HTTP proxy sniffs `list_changed` in streams; the router pool too; all → `mcpTools.invalidate` + `mcp-status`. `mcp:remove` revokes the sign-in first. McpPanel keyboard/a11y (focus into/out of the review form, Escape no longer closes the whole Library: form is `.editing` + `preventDefault`). Fixture `test/fixtures/mock-mcp-sse.mjs` (`--port`, `--key`, tools `whoami`, `add_tool`). No public no-auth SSE server exists any more (DeepWiki/Cloudflare 410; Atlassian `/v1/sse`, Asana `/sse` need sign-in).
- `3fa2789` P1a–c: `Provider.authStyle` (`anthropicAuthStyle` in `provider-rules.ts`, also used by probes), `smallModel` (Claude `ANTHROPIC_SMALL_FAST_MODEL` + haiku slot; OpenCode `small_model`), `secretHeaders` (safeStorage per header; view shows names only; `inject/headers.ts` `headerPlan`: Codex `env_http_headers`, OpenCode `{env:VAR}`, values only in env), `${env:VAR}` header values, `contextWindowOverride` in `catalogFor`. OpenCode takes every protocol (`opencodePackage`: `@ai-sdk/openai-compatible|openai|anthropic|google`). `src/main/models-catalog.ts`: discovery per protocol (OpenAI/OpenRouter/TokenHarbor/PGS field variants, Anthropic paging, Gemini) + models.dev cache 24 h, `pickSmallModel`. IPC `providers:discover`, `providers:test` on unsaved drafts (`settings.draftProvider`: saved key only while the host is unchanged). Probe triage shows the server's own error (`upstreamMessage`). Editor: Fetch models picker, Small model, Advanced (key header, headers + Secret, query params, retries, context). `Select` popup no longer closes itself inside a scrolled sheet.
- `7383268` P1d: every saved provider is offered on OpenCode as `unskilled-<provider>/<model>` (`extraModels` dep, `providerModelOptions` in `index.ts`); the thread's model id pins the provider (`providerOfModel` in `provider-rules.ts`; `injectionFor` `opts.providerId` overrides the agent credential); a changed provider restarts that thread's OpenCode and resumes the session. Picker: a "Providers" section lists other agents' provider models ("on OpenCode"); picking one moves the draft/thread there (`openSwitch(agent, model)`, `switchAgent(…, model)` so a handoff seeds on that model). Claude and Codex stay on their subscriptions.

**User decisions (2026-10-06/07)**: never switch Claude or Codex to a BYOK provider in tests; test third-party providers through OpenCode (or a per-thread pin); use a free OpenCode model for non-provider OpenCode checks (Big Pickle worked; Ling 3.1 Flash Free was down; AgentRouter DeepSeek fails on thinking mode). Skipped for now: Azure/Bedrock/Vertex, the MiniMax/DeepSeek-anthropic/Moonshot/Z.ai presets (no keys). The note under Small model was reworded so it doesn't read as routing through OpenCode.

**Next: P2 translation gateway (user said do it, after P1d).** Research map (2026-10-06, spot-checked):
- Hook: `startToolServer` (`mcp-http.ts:128-213`) has a fixed path allowlist (`/mcp`, `/mcp-skills`, `/mcp-routed`) plus the `/mcp-up/` callback; add an `/llm/<providerId>/…` branch (same per-launch Bearer, 127.0.0.1). Request bodies there are uncapped today (`readJson` `:82-90`); cap LLM bodies (e.g. 32 MB).
- Claude: point `ANTHROPIC_BASE_URL` at `<tool server>/llm/<id>` with the per-launch token as `ANTHROPIC_AUTH_TOKEN` (proven shape: `test/claude-e2e.test.ts:180-247`); serve `POST /v1/messages` (SSE) translated to the provider's chat-completions. Codex: `base_url` at the route, `wire_api="responses"`, serve `POST /v1/responses` SSE (`test/codex-e2e.test.ts:204-262`).
- Translators are new (no raw chunk parsers in `src/main`); reuse `normalizeUsage`, `buildHeaders`, `endpointsFor`, `wireIdOf`. Fakes to reuse: `test/claude-e2e.test.ts:20-63` (Anthropic SSE), `test/fixtures/fake-openai.mjs` (Responses SSE), `test/opencode-e2e.test.ts:22-52` + `opencode-guard.test.ts:110-154` (chat chunks with tool calls).
- Build-or-buy: `@musistudio/llms` is ~8 MB with fastify + 3 SDKs and stale since 2026-01 → own minimal translators, golden fixtures recorded from TokenHarbor.
- Product shape to keep: per-thread pin (Claude/Codex never globally switched). Likely: offer provider models on Claude/Codex too when the protocol needs translation, gated by `injectorCompatible` "via gateway".

**Delegation note:** on 2026-10-06 the opencode `researcher` failed twice with "reasoning_content in the thinking mode must be passed back" (AgentRouter DeepSeek); with no `oc-run.mjs` on the Mac there's no model fallback, so do the research directly after two such failures. Implementers worked earlier the same day.

**Test keys**: TokenHarbor `thk_live_…` and PGS Grove `pgsk_plan_…` (PGS plan includes `glm-5.3-flash`, `mimo-v2.6-flash`, `deepseek-v4.1-flash`, not `deepseek-v4-flash`) were still valid on 2026-10-07; the user will revoke them after testing, so ask for fresh ones for P2. Never write them to files.

**Pending**: Windows gate (M1–M4, MCP leftovers, P1, P1d) + CI; then P3 (TokenHarbor/PGS presets, Add from catalog), D1–D4. Small: chat renderer italicises intraword underscores; provider editor "Options" label isn't top-aligned; Antigravity `providerEnvOnly` vs `test/inject-acp.test.ts:57`.

## Resume here — MCP, providers, Design mode (2026-10-05, Mac)

Spec: `.ai/plans/mcp-providers-design.md` (user-approved; `.ai/` is gitignored, so on the Windows PC use this summary). User decisions: providers get native support **and** a translation gateway; the 8px rule is for **generated designs only** (CubiQ chrome stays 4px, `DESIGN.md` §4); order **MCP → Providers → Design**; credentials must be encrypted properly; follow the MCP auth spec + security best practices.

**Phases** (each: research → edits → own verification → live turn on Claude Sonnet 5.5, Codex, OpenCode → commit ≤150 chars, no trailer → `rm .ai/tmp/*`):
- **M1 vault — done (`5ccaf3b`).** `src/main/mcp/vault.ts`: one safeStorage ciphertext per server in `<userData>/mcp-secrets.json` (0600, atomic); `mcp.json` holds `"$vault"` in place of each header/env value; `${VAR}`, `${VAR:-d}`, `${env:VAR}` stay in the file and are filled by `resolveSpec` in `McpScopes.effective` (also `mcp:test`); plaintext files migrate on first read (`migrateMcpSecrets` at startup); undecryptable → `locked` (row warning, value left out); no keychain (Linux basic_text) → new secrets refused; vault values join `knownSecrets` (events show «redacted»). Tests: `test/mcp-vault.test.ts`.
- **M3 backend — done (`74f4e58`).** `src/main/mcp/gateway.ts` `McpGateway`: `/mcp-up/<scope>/<name>` on the tool server (6th `startToolServer` param), same Bearer. Streamable HTTP = byte proxy (forwards content-type/accept/mcp-session-id/mcp-protocol-version/last-event-id, adds resolved headers + `McpAuth.accessToken`, 401 → one refresh + retry, 403 `insufficient_scope` → `noteStepUp`, strips www-authenticate/set-cookie, same-origin redirects only, aborts upstream when the agent hangs up); SSE = SDK client (`clientTransport(spec, authedFetch)`) behind a stateless SDK `Server` forwarding tools/prompts/resources. `McpScopes.setRemote` maps every URL server to its gateway spec (left out until the tool server listens; it now starts at launch); `McpScopes.store(scope)`; `McpToolsCache.invalidate`; `viewOf(entry, vault, key)` fills `args`/`publicValues`/`hasClientSecret`. IPC `mcp:probe|status|connect|disconnect|client-secret|import` in `index.ts` (`mcpStatusOf` lists URL servers through the gateway; `mcpChanged` resets gateway + cache + broadcasts `mcp-status`). `readExternalSpec` in `external.ts` (Claude/Codex TOML incl. `.env`/`.http_headers`/`bearer_token_env_var`/Gemini httpUrl vs url/OpenCode). Tests: `mcp-gateway`, `mcp-oauth` (mock AS in `test/fixtures/mock-oauth-server.ts`), `mcp-external`.
- **M2 + M4 UI — done (`c05a20a`).** `components/McpPanel.tsx` (+ `styles/mcp.css`), used by Library › Connectors and the `/mcp` sheet (`McpSheet.tsx`, store `mcpSheetOpen/Prefill`; `/mcp <url|command|json>` from the composer pre-fills): smart add → review form (name, command/URL, env/headers as password fields, `${VAR}` allowed), URL probe ("Wants a sign-in" → "Add and sign in" auto-starts Connect; SSE-only endpoints saved as `sse`), **stdio consent** (exact command, env keys masked, `commandWarnings`, "I trust this command" gates Save; re-asked when an edit changes the command), Sign-in settings (callback URL + Copy, client id/secret, scopes, port), rows with status dot + tool count → tool list, Connect/Reconnect/Sign out, Edit, Remove, "Use here" for globals in a project, Import on importable external rows, built-in row. Featured = 16 real remote servers checked 2026-10-06: DCR sign-in for Linear, Notion, Sentry, Figma, Canva, Stripe, Supabase, Vercel, Cloudflare, Asana (sse), PayPal, Atlassian (no PRM, AS at the origin has DCR); GitHub = PAT header (no DCR); HubSpot left out (no DCR); Context7, DeepWiki, Cloudflare Docs need no key. Router: `search_tools`/`call_mcp_tool` list with 15 s (npx servers were timing out at 5 s and reported "Unknown tool"); a failed listing now says "Couldn't reach MCP server".
- **Live-verified 2026-10-06 (Mac):** POSARA by static token and by **Connect** (DCR + consent + 60-min token, 113 tools), DeepWiki http, mock stdio and `npx -y @modelcontextprotocol/server-everything`, each called in a real turn on Claude Sonnet 5.5, Codex GPT-6-Luna and OpenCode; leak scan of the data dir clean (token, canary header, OAuth tokens, upstream URL only in mcp.json). DeepWiki's `/sse` now answers 410, so the SSE bridge is covered only by `test/mcp-gateway.test.ts` (find a public SSE server to live-test). POSARA's own "Registered connectors" are locked to claude.ai's callback, so they can't be used with CubiQ's loopback callback; DCR works instead.
- **Pending for MCP:** Windows gate (DPAPI vault + migration, loopback callback on 33418, gateway, consent UI) with the older gates; not built: re-list on `notifications/tools/list_changed`, revoke on Remove, keyboard/a11y pass of McpPanel (§9.5).
- **Known, unrelated:** the chat markdown renderer italicises intraword underscores (`read_wiki_structure` → read*wiki*structure).
- **M2 (original scope) — smart add:** one input that detects a URL (POST initialize; 401 + `WWW-Authenticate` → offer Connect; 404/405 → SSE), a command line (`npx`/`uvx`/`bunx`/`docker`, via `cmdline.ts` `splitCommandLine`), or pasted JSON (`.mcp.json`, `mcpServers`, VS Code `servers`); one-click import from `external.ts`; auto name; `type: "sse"` in `McpServerSpec`; **stdio consent** (exact full command, flag sudo/rm -rf/curl|sh/~/.ssh, explicit approve — spec MUST); edit existing servers (`Library.tsx` `previous` is always null today); auto tool list after save/enable (status dot, count, expandable names + descriptions, re-list on `list_changed`); replace the made-up Featured Connector packages (`Library.tsx:100-160`) with real ones, each verified live.
- **M3 — OAuth Connect + gateway:** `mcp/oauth.ts` = SDK `OAuthClientProvider` over the vault (SDK 1.30.1 has `auth()`, discovery, `registerClient`, `refreshAuthorization`); pre-registered Client ID/Secret first, then DCR; PKCE S256, `state`, RFC 8707 `resource`; loopback callback on a fixed configurable port; **check RFC 9207 `iss` ourselves (the SDK doesn't)**; open only https/loopback-http URLs via `shell.openExternal`; SSRF guard on discovery URLs; refresh at 80% lifetime + on 401; 403 insufficient_scope → step-up (max 2). Remote servers reach agents only through `mcp-http.ts` `/mcp-up/<scope>/<name>` (reverse proxy injecting the token; SSE upstreams via an SDK client/server bridge), so tokens never reach agent configs; `McpToolsCache` keyed by server id + URL, not spec.
- **M4 — `/mcp`:** command in `commands.ts`; sheet like `/context` (status, scope, tool count, Connect/Reconnect/Disable/Tools/Remove, smart-add input); `/mcp <url|command>` pre-fills; shares the Connectors component.
- **P1 providers, native:** editor exposes headers (secret ones encrypted), query params, env-key/`${env:VAR}` secret, retries, context override, Bearer vs `x-api-key`; Test before save; model discovery (`/models` + models.dev, 24 h cache); OpenCode picks the AI-SDK package per protocol (`@ai-sdk/anthropic|openai|google|openai-compatible|azure|amazon-bedrock|google-vertex`, `inject/opencode.ts:54` hard-codes openai-compatible today); Codex `env_http_headers`/`env_key`/Azure; Claude `ANTHROPIC_SMALL_FAST_MODEL`, Bedrock/Vertex.
- **P2 translation gateway** `src/main/gateway/`: loopback `/anthropic/v1/messages` (Claude) and `/openai/v1/responses` (Codex) → upstream chat; streaming, tools, images, reasoning, usage, errors; key stays in main; injectors route through it instead of erroring on a protocol mismatch. Start with a look at claude-code-router's transformer lib; default is our own translators + golden fixtures.
- **P3 presets** (anthropic-messages ones pending since N5, Responses, Gemini, Azure, Bedrock, Vertex), each after a live turn; "Add from catalog".
- **D1–D4 Design mode:** `Thread.kind` chat|design + migration; Chat | Design switch in the sidebar brand row; canvas-first layout (browser-wide/`ConversationRail` pattern), lazy chunk; `cubiq-design://` protocol + CSP no network + iframe `sandbox="allow-scripts"`; live reload via debounced `fs.watch`; viewports 390/768/1440/1920×1080, zoom, 8px grid overlay, pick-to-comment; `resources/DESIGN-MODE.md` guide layer (8pt scale 4·8·12·16·24·32·40·48·64·80·96, 4pt baseline, ≥44px targets); skills `design-prototype|mobile|slides|system-extract|critique|handoff` with assets/scripts; 4–5 own design systems (Stitch 9-section DESIGN.md + tokens.css); Library Experts wired to real presets; `design_screenshot` (offscreen window) + `design_lint`, critique loop ≤2 rounds; export HTML/PNG/PDF.

**Test hosts** (credentials only via the app UI or env at test time, never in files/briefs; the user should rotate both after testing):
- POSARA MCP `https://posara-horizon-t1.dcn01.ctdn.dev/api/v1/mcp`: Streamable HTTP, ~113 tools, DCR + PKCE + `iss` supported; token in `POSARA_MCP_TOKEN` (referenced as `Bearer ${POSARA_MCP_TOKEN}`). **Call read-only tools only** (`get_branches`, `search_products`); it has `void_invoice`/`refund_invoice`.
- TokenHarbor `https://tokenharbor.ai` (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models` with pricing/context metadata); key in `TOKENHARBOR_API_KEY`; cheap models (`deepseek-v4-flash`, `qwen3.7-flash`); `x-th-confirm-spend: true` header for big calls.

**Live-test recipe (Mac, worked for M1):** `bun run build`; temp dir with `mcp.json` (+ the mock `test/fixtures/mock-mcp-stdio.mjs`, which echoes `MOCK_GREETING`); `sqlite3 <tmp>/unskilled.db "INSERT INTO projects (id,path,name,created_at) VALUES ('p1','<tmp>/scratch','scratch',strftime('%s','now')*1000)"` (app closed); launch `POSARA_MCP_TOKEN=… node_modules/.bin/electron . --user-data-dir=<tmp> --remote-debugging-port=9455`; drive with `agent-browser --cdp 9455`; type `/full` then the prompt; afterwards `grep -rla <secret> <tmp>` must find nothing.

**Noted, out of scope:** the Antigravity preset lacks `providerEnvOnly` while `test/inject-acp.test.ts:57` assumes it.

## Resume here — Plan mode v2 (2026-10-05, Mac)

Spec: `.ai/plans/plan-mode-v2.md` (user-approved). Roadmap research round (other harness apps, ranked R1–R12) appended to `.ai/plans/harness-roadmap.md` §3. User decisions: every "waiting on you" card docks **above the composer**; agents may ask in **every** mode; Plan mode v2 goes before P1/P3.

**Why:** before this, CubiQ dropped agent questions. Claude's `AskUserQuestion` hit the generic permission card and "Allow" returned no answers; Codex's `item/tool/requestUserInput` was rejected (`-32601`); OpenCode's `question` tool isn't sent over ACP (upstream #30343, closed not planned).

**Built (on `m4`, commit `4641861`):**
- One question type end to end: `Question`/`QuestionRequest`/`QuestionAnswer` (+ `notes`), `PendingState` in `shared/types.ts`; event `questions` (history row, secrets masked as •••); LiveUpdates `question` / `question-done`; IPC `question:respond`, `pending:get`.
- `src/main/questions.ts`: mapping for Claude (`fromClaudeQuestions`, `claudeAnswers` keyed by question text, `claudeAnnotations` = notes + picked preview), Codex (`fromCodexQuestions`, `codexAnswers`, notes as `user_note: …`, `fromCodexAsyncQuestions`), `answersText`/`answersMessage`, and the **`ask_user` harness tool** for ACP.
- Service: `pendingQuestions`, `ask()` (dismiss on Stop), `askFromTool()` (ACP tool path), `respondQuestion()`, async delivery (`deliverAsync`: `driver.steer` → else `afterTurn` queue → else next message), **`pendingState()`**, so a reloaded window gets back running threads and open permission/plan/question cards. That fixes the HANDOFF gap "renderer loses `running` on reload", which the user saw as "Codex shows no loading/waiting".
- Claude (`claude.ts` canUseTool): `AskUserQuestion` → card → `updatedInput {questions, answers, annotations}`; skip → deny "proceed with your recommended defaults". `toolConfig.askUserQuestion.previewFormat: "markdown"`.
- Codex (`codex.ts`): handles `item/tool/requestUserInput` (blocking, answer by id). **Found live:** GPT-6-Luna's model catalog advertises `send_user_message_async` → Codex also registers `request_user_input_async`; the model asks via an agentMessage (`delivery:"async"`, `questions`) and **ends its turn**, so the answer had to become a new message (user: "should be within that chat"). Fix: at app-server spawn, `catalogArgs()` writes `<userData>/codex-models.json` = `models_cache.json` minus the async tools (`blockingQuestionCatalog`) and passes `-c model_catalog_json="…"` (process-level; a thread-level `config` override did NOT work, probed). Skipped for BYOK. Async items are still caught as a fallback (card with "answer anytime", answer via `turn/steer` or the next message). `AgentDriver.steer?` implemented for Codex.
- ACP/OpenCode: tool server serves thread tools on `?t=<threadId>` (`withThread`, `mcp-http.ts`), `ask_user` auto-allowed in every mode (Plan included). `PLAN_MODE_PREFIX` rewritten (~150 tokens, distilled from Codex's plan template: explore first, ask only user decisions via ask_user, decision-complete plan: Summary · Key changes · Test plan · Assumptions); native plan mode gets the short `PLAN_MODE_HINT` only when the tool server is attached (`l.askUser`).
- Guide `resources/HARNESS.md`: one "Questions" line (budget test passes).
- UI: `RequestDock.tsx` (permission → question → plan, one at a time, "+N more waiting") between ThreadView and Composer; cards no longer inline in the thread. `QuestionCard.tsx` + pure `question-card.ts` reducer: stepper "1 of N", number keys, ↑↓/Enter/Space, Esc = Skip, "Other…" text, multi-select, markdown preview pane, **"+ Note" (N) per question** (user request: add a note beside a recommended pick). With a note open, a pick doesn't auto-advance. History row "Answered 2 questions · Header: answer" (notes shown when open). Sidebar sub-line "Needs your answer" for question-only waits. `.button:disabled` now dims globally (opacity .4, as icon buttons already did). Tool rows for AskUserQuestion/ExitPlanMode/async show the question or plan title, not JSON (`summarize.ts`).

**Verified by me:** typecheck; full suite **1212 passed** (124 files); build; `electron . --smoke` ok. Live in the built app (temp `--user-data-dir`, scratch repo `notes-app`, project inserted into the temp DB):
- **Codex GPT-6-Luna, Plan:** card shown, turn kept running, answered "Fixed list" → plan "Add Fixed-List Tags to Notes" **in the same turn** (events: user → turn-start → questions → plan-proposal). Stop while the plan card is up ends the turn and clears the card.
- **Claude Sonnet 5.5, Plan** (user: test Claude with Sonnet 5.5): AskUserQuestion card → answered "Fixed list" → ExitPlanMode plan "Tags on notes (fixed list)", same turn.
- Preview (`?state=question`, added to `mock.ts`): light/dark, keyboard flow, multi-select + Other.

**OpenCode live run (done, 2026-10-05 afternoon):** `agentrouter/deepseek-v4-flash`, Plan: ask_user card → answer + note → plan card (Summary · Key changes · Test plan · Assumptions), same turn. **Found:** OpenCode times an MCP call out after 60s (`MCP error -32001`; tool timeout = `mcp.<name>.timeout` ?? `experimental.mcp_timeout`, else the SDK's 60s), so a card left unanswered a minute broke the turn. OpenCode calls tools with `resetTimeoutOnProgress: true`, so the fix is scoped to the tool server: a call to a thread tool (ask_user) answers as SSE and sends `notifications/progress` every 15s (`HEARTBEAT_MS`, `mcp-http.ts`); every other call stays plain JSON. The body is now parsed up front (bad JSON → 400). Re-checked live: card held 3+ min, then answered fine; Codex cubiq tool call and a Claude Sonnet turn also green. Notes UI checked live (+ Note opens under the pick; note reached the model).

**Plan artifact (Q5b, done 2026-10-05 evening; spec `.ai/plans/plan-artifact.md`):** every plan proposal is also the next version of a virtual artifact `PLAN_ARTIFACT = "cubiq:plan.md"` (`shared/artifact-kind.ts`), kept only in the version store (nothing written to the repo; ":" can't be a Windows file name). `recordPlan` in `artifacts.ts` (deduped; stores the secret-masked event text), `readArtifact`/`artifactDiff` serve it from the store (v1 diffs against empty, never git; diff header "Plan"). Service records it in `requestPlanDecision`, so Claude, Codex and ACP all get it. No auto-open: the docked plan card and the history "Plan" row have **Open in panel**. Panel names it "Plan", hides "Open in", says "Latest"; an open panel on "Latest" reloads when a version lands (any file). Live-checked: Claude Sonnet 5.5 (v1), Codex GPT-6-Luna and OpenCode (v1 → Keep planning → v2, panel moved to v2 itself, Diff tab), light and dark.
Also fixed in that round: plan-card buttons wrapped their text at panel-open widths (user screenshot) → `nowrap` + the row wraps whole buttons; markdown links to bare absolute paths (`[notes.js](/abs/notes.js:12)`, `C:\…`, as Codex writes them) rendered raw → now file links; sidebar dot label says "Needs your answer" for question-only waits (`answering` status).

**Blob pruning (`65aca62`):** `Store.pruneBlobs()` removes blob rows + files no event (`payload_ref`) or artifact version references; runs after thread/project delete and once at startup (`setImmediate`). Only 64-hex names in `blobs/` are touched; a locked file (Windows) is retried next prune. Live: delete took 7 → 5, planted orphan gone on restart.

**P1 wide panel (`a419cc7`):** side panel up to 80% of the space right of the sidebar (`inspectorCap`, `shared/layout.ts`); `PaneLayout.inspectorWide` is set when a drag/keyboard width leaves the chat under 420 (`isWideInspector`): then the chat may shrink to `chatFloor` (max 260, 20%), else the old 420 rule holds (panel narrows on window shrink). Splitter gets the drawn width + window-relative max. Narrow chat (container `main` ≤ 420px): composer stays one row (mode chip icon-only, effort hidden, model name ellipsizes, placeholder one line; selectors scoped under `.composer` because the base rules come later in app.css), turn meta wraps whole items. Live at 1280: panel 764, chat 260, no sideways scroll (user screenshot of the wrapped composer fixed).

**P3 multiple skills (`0932b8a`):** P3a (types, `shared/skill-list.ts` `skillsOf`, `composePrompt` one `<skill>` block per skill + one Arguments line, single skill byte-identical, `titleFrom` "/a /b text") was done by an opencode implementer in a worktree, reviewed and re-run by me. P3b (me): store `pendingSkills`/`addPendingSkills`/`takePendingSkills`, `send/enqueue/startThread/sendInBackground/newThread` take `skills?: string[]`, `SendRequest.skill` removed (old stored `skill` still read). Composer: chips inline in `.composer-input` before the textarea with ×; `$` at any word start (`skillQueryAt`), picks toggle (✓ in menu), Esc closes the skill menu keeping text, Backspace on empty removes the last chip; ⌘K/Library add to the list; bubbles/queue show every chip. Live: two skills ($pdf $docx) on OpenCode, Codex and Claude (that one ran on Opus 5.5, the Sonnet click missed) → each replied "OK, pdf, docx".

**Not done yet:**
0. **Windows CI** run 37291725048 on `m4` (`gh workflow run ci.yml --ref m4 -f os=windows`): `test (windows-latest)` **passed** 2026-10-05; codex-e2e and packaged smoke were skipped (extras off).
1. Windows PC gate for everything since `4641861` (CI covers unit tests only, not these live checks): `bun run typecheck/test`, smoke; Codex Plan question card (model_catalog_json path); OpenCode ask_user wait > 60s; plan panel v1 → v2; delete a thread and watch `%APPDATA%\CubiQ\blobs` shrink; drag the side panel to 80% and check the narrow composer; two skill chips on a send. Or push `m4` and let CI `windows-latest` run (never run yet; needs the user's OK to push).
2. A plan proposed before the plan artifact has no saved copy: its "Open in panel" shows "No plan yet".
3. `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` on stderr is expected (auto-allowed harness tools in `allowedTools`).

**Gotchas from this session:** don't `location.reload()` mid-turn when testing, or (before this fix) the UI lost the running state; with `pending:get` it now restores. In zsh, `AB="agent-browser --cdp 9455"; $AB …` doesn't word-split: use a function `ab(){ AGENT_BROWSER_SESSION=cubiq-live agent-browser --cdp 9455 "$@"; }`. The preview server binds `localhost`, not `127.0.0.1`. The memory extractor wrote a note into the temp data dir's project during testing (harmless; temp dir).

## Resume here — UI refresh (after U2)

**Shipped this session (2026-10-01):**
- **U0** `6cb7ecb`: `DESIGN.md` (Ink Flat: tokens, signal roles, type, spacing, components, motion, pre-ship checklist); `CLAUDE.md` + new `AGENTS.md` point every agent at it. `app.css` tokens rewritten: ink primary (`--primary`/`--on-primary`/`--focus`), acid only as signal (`--signal-fill` #A8FF55 with ink on top, `--signal-ink` #357A08 for text, `--signal-line` #4A9A12 for graphics in light mode; #A8FF55 on white is 1.23:1). No static shadows (`--shadow-float` on popovers/menus/sheets only). Geist + Geist Mono bundled (`src/renderer/src/assets/fonts`, OFL). Provider editor no longer overflows (rows wrap, `min-width: 0`); saved providers are list items (name over `protocol · host · models`).
- **U1** `863875f`: composer bar = `+` (insert @ / $ / /) · mode chip menu (⇧Tab still cycles; Full access in danger) · spacer · **model menu** (this agent's models grouped by provider, other agents as "switch" rows → existing Switch dialog, Thinking and Context segments inside; button shows the effective effort, e.g. "Sonnet 5.5 · Low"; a model without levels says "Not offered by …") · **context ring** (popover: first-turn breakdown, 5h/weekly limits, usage, cache, cost, Compact now, Open /context) · send. Running beam on the composer (`--signal-line`; reduce-motion → static). `AgentPicker`/`EffortPicker`/`ContextPicker` deleted; `ThreadControls.tsx` exports `ThreadMode/ThreadModel/DraftMode/DraftModel`. **/compact [focus]** everywhere: `SendRequest.compact` → `TurnInput.compact`; capability `manualCompact`; Claude sends the SDK's `/compact`; Codex `thread/compact/start` (resolves on `thread/compacted`, 3-min timeout); ACP sends `/compact` when the agent advertises it **or** the preset declares `manualCompact` (OpenCode 1.18.33 runs it without advertising: context 13k → 483 in a probe). Codex "default" now carries its real model's efforts.
- **U2** `a7583e3`: `src/renderer/src/turns.ts` `segmentEvents()` folds each turn's tool calls (plus narration between them) into one "Worked for 41s · read 2 files · edited 1 file · ran 1 command" disclosure (`work-<seq>` in `disclosures`); a run still in progress stays as rows. Changes card per turn ("2 files changed +38 −0 · Review" → Changes tab; counts hidden when no edit reported a stat). Turn footer: Copy reply, Retry (resends the prompt), mono meta line; hover-only except the last turn. User bubble: hover Copy / Edit (store `setComposerDraft`) / time. Code blocks get a header (language + Copy); `parseBlocks` keeps `lang`.

**Shipped late evening (2026-10-01), U5a:**
- Deps (user approved): `mammoth` 1.13, `jszip` 3.10, SheetJS `xlsx` 0.20.3 **from cdn.sheetjs.com** (the npm `xlsx` 0.18.5 has unfixed CVEs).
- `src/main/preview/office.ts` (docx → sanitized HTML, xlsx/xls/ods/csv/tsv → sheets capped at 5k rows, pptx → per-slide title/text/images from slide XML, 8 MB image budget), `worker.ts` (utilityProcess entry), `host.ts` (`PreviewHost`: lazy fork, 25 MB cap, 10 s timeout kills + re-forks, exit fails in-flight requests, mtime+size cache of 20; never rejects; `utilityFork(utilityProcess, path)`). `electron.vite.config.ts` builds `out/main/preview-worker.js`. pptx on macOS uses the slide-XML path too: `qlmanage -t` only renders the first slide, so Quick Look was dropped.
- Contract for U3/U4 in `src/shared/types.ts` (search + artifact types, `artifact-ready` LiveUpdate, `Settings.sidebarGroupByProject`, API `search/listArtifacts/readArtifact/artifactDiff`), preload channels `search:query`, `artifacts:list|read|diff` (**no ipcMain handlers yet** — calling them rejects), mock implementations + `?state=artifact`.
- Built by opencode workers (U5 implementer, two researchers), verified by Claude (diff read, typecheck, suite, build, utilityProcess probe).

**Shipped 2026-10-02, U3 + U4 (+ U5 wiring), one commit:**
- Sidebar v2 (`Sidebar.tsx`, `ThreadRow.tsx`, `sections.ts` `inboxModel`): nav rows New thread / Search / Library; Running (live dot, elapsed, project · agent or "Needs approval"), Pinned, Recent "By project" ⇄ "All" (`Settings.sidebarGroupByProject`, default grouped; flat mode lists projects below). Row = status dot (running/waiting/unread) · title · mono time; hover shows archive + ⋯. ⌘1–9 follow this order across projects. Settled section is gone.
- Search: migration **18** `search_fts` (FTS5 + triggers) and `Store.search`; `SearchDialog.tsx` (filters All / This project / Running / per agent / Files); ⌘K opens it, `>` or ⌘⇧P opens the palette with `>`.
- Artifacts: migration **19** `artifact_versions` (content in blobs, `writeBlobBytes`); `src/main/artifacts.ts` (record at turn-end, `resolveInside` realpath containment, read/diff, never throws); `cubiq-file://f/<thread>/<path>` serves pdf/images only (CSP `img-src`/`frame-src`); `PreviewHost` in `index.ts` for docx/xlsx/pptx/csv. Inspector gets a **File** tab (`ArtifactPanel.tsx`: Preview/Source/Diff, versions, Open in, Copy). Tool-row file links and reply links open the panel. File cards with **Preview** under each turn.
- **User decision 2026-10-02**: the panel opens by itself only for html, svg, pdf, image, csv, docx, xlsx, pptx (`shared/artifact-kind.ts` `AUTO_OPEN`); markdown and code never auto-open, their file card has Preview. DESIGN §7.5 updated.
- Built by four opencode implementers in parallel (db, artifacts, panel, search; all passed first try); sidebar, wiring and fixes by Claude.

**Known gaps (not done):** no syntax colouring or mermaid in the panel (no new deps); "Generating…" file card while writing; a message search hit opens the thread but doesn't scroll to the message; older versions of pdf/image/office files can't be previewed (latest only); Codex writes `[x](/abs/path)` links that render as raw text (pre-existing); the renderer loses `running` on reload (pre-existing).

**Shipped 2026-10-02, U6 part 1** (user-driven, several rounds):
- **Beam** (`Beam.tsx`, `.beam` in app.css): rebuilt after libraries.dev border-beam (its computed styles were read from the live page): colour blobs glowing inside the edges + 1px highlight ring + blurred sparkle, rotating conic window 1.96s, fade-in 0.6s. On the composer while running, the Stop button while running, Send when there's something to send, and the ⌘K search **text field** (not the card). Own layer (`contain: strict; translateZ(0)`), no animated filter (the hue drift was dropped after the user saw flicker). Send/Stop are raised surface circles (`--send-*` tokens: white light, #23262c dark), not ink/white.
- **Orb** in the waiting line is tinted `--signal-line` via `useCssColor` (follows theme changes).
- **Select.tsx**: themed listbox replacing all 9 native selects (Library scope, Memory type, provider credentials/preset/protocol/alias, Settings default agent/editor, project auto-fix); Settings/Library ignore Escape while a list is open (`selectPopupOpen`). Library/Memory emoji → Lucide; avatars neutral.
- Built by two opencode implementers (selects + emoji) in parallel; beam/orb/Select by Claude.

**Open from U6 part 1:** the user reported a screen flicker while chatting; 30-frame bursts showed no full-window flash, the beam was made cheaper (above) — **ask the user whether it's gone**, and if not, where it flickers.

**Shipped 2026-10-02, U6 part 2:** `GooeyPlus.tsx` (the composer + splits into @ / $ / / with a goo merge, recipe read from libraries.dev/gooey), popover morph on `.model-menu.up`; sweep of Files, Message Center, About, provider editor at 760 px in both themes found nothing to fix. Both are gated by the Motion setting; its default became **full** (`15a9c26`, user decision).

**Shipped 2026-10-02, U6 part 3** (user-driven):
- `b739c6e` + `efc694b`: model picker **Thinking** is a Faster ↔ Smarter step slider (`StepSlider.tsx`, now its own component; firefly dot grid, green `--signal-line` from Xhigh); **Context** is the same slider (Default ↔ Max, green on Max). Track 20px, lit fill `color-mix(--text-secondary 16%, --bg-chip)` so the trail reads.
- `d406cef`: **Text size** in Settings › Appearance = the same slider (80/90/100/110/125/140%, green from 125%, Reset). The app owns zoom (`shared/zoom.ts`, `Settings.zoom`): main `setZoomFactor` on load / settings change; ⌘= ⌘− ⌘0 (Ctrl elsewhere) caught in `before-input-event`, Ctrl+wheel via `zoom-changed`, custom mac View menu items. macOS traffic lights move with zoom (`setWindowButtonPosition`, y = round(22.5·z − 7)), Windows caption overlay height scales; CSS insets that clear native chrome divide by `--zoom`. Sidebar toggle sits at the same spot open or collapsed (ChatGPT/Claude style), New thread beside it when collapsed. Measured: lights vs icons within 1px at 80–140%.
- Not verified: real ⌘−/⌘=/⌘0 keystrokes (CDP keys bypass `before-input-event`; no accessibility permission) — **ask the user**; Windows caption spacing at zoom; Claude live turn after `d406cef` (OpenCode + Codex ran; Claude ran on `efc694b`).
- Gotchas: Chromium remembers zoom per origin, so the old dev origin came back at 91% before the setting existed. `screencapture -l <wid>` of an occluded window returns stale content (Chromium stops painting); measure page content with `agent-browser screenshot` instead. Window ids: a small Swift `CGWindowListCopyWindowInfo` script.

**Approved plan, not started** (`.ai/plans/zoom-wide-panel-multi-skill.md`, Mac only; P2 = text size is done):
- **P1 artifact panel to 80%**: today `BOUNDS.inspector.max = 720`, `BOUNDS.main = 420` (`shared/layout.ts:6`), enforced by the Splitter `max` (`App.tsx:219` → `splitter.ts:53`), `clampLayout` (`renderer/src/layout.ts:17-35`), `sanitizeLayout`. Make the max window-relative: up to 80% of the space right of the sidebar, chat keeps ≥ 20% (floor ~260px) so it can be dragged back; composer must not overflow at that width. Tests: `pane-layout`, `splitter`, `splitter-markup`.
- **P3 multiple skills as chips inside the input** (user picked "inline in input", ChatGPT-style): single-valued today end to end — `Composer.tsx:35` `SkillEntry|null`, `store.ts:159` `pendingSkill`, `SendRequest.skill?: string` (`types.ts:726`), `composePrompt(…, skillName?)` (`main/skills/compose.ts:15`, one `<skill>` block), chip rendered in the bottom bar (`Composer.tsx:440`). Change to `skills: string[]` at each layer (old `skill` still read), one `<skill>` block per skill, `$` at any word start, ✓ in the menu toggles, chips (skills + context) inline before the text with ×, Backspace removes the last; ⌘K / Library add instead of replace.

**Next, in order:**
1. P1, then P3 (above); each its own commit after typecheck, full suite, app screenshots and a live OpenCode / Codex / Claude turn.
2. **Windows pass** for U0–U6 (see the Windows PC gate below), now including Text size zoom (caption buttons, Ctrl+= / Ctrl+− / Ctrl+0).
3. Look into the one smoke failure seen on the first run after a fresh build (not seen again: 2/2 ok on 2026-10-02).
4. Then the **native provider agent** spec (`.ai/plans/native-provider-agent.md`, user decision): plan first; nothing built before approval.
5. **Windows PC gate** for N7–N9 and U0–U5 (bun install, typecheck, test, dev; composer, model menu, ring, /compact, sidebar, ⌘K, artifact panel incl. `cubiq-file:` on a `C:\` path and the preview worker).

**Working notes:** drive the dev app with `bun run dev -- --remoteDebuggingPort 9455` + `agent-browser --cdp 9455` (`AGENT_BROWSER_SESSION=cubiq-real`); live turns via `window.unskilled.createThread/updateThread/send` on project `sambor-prei-kuk` (tool-free prompts only), then delete the threads. Mock preview `bun run preview:ui` (port 5199, `?state=thread|settings|…`) is quickest for visuals. The OpenCode ACP command probe script pattern: spawn `opencode acp`, `initialize`, `session/new`, read `available_commands_update`.

## Resume here — after N9

**Shipped this session (2026-10-01):**
- **N7 Windows fix** `1d6f013`: `check.ts` `pwshScript()` — PowerShell `-Command` couldn't run a quoted program path (needs `& `) and collapsed exit codes to 0/1; now appends `exit $LASTEXITCODE` (or 1 for a failed cmdlet).
- **N8 guide diet** `9ed5546`: `resources/HARNESS.md` 707 → 332 tokens (bytes/3; `/context` row 249). `guide.ts` normalizes CRLF on read; `test/guide.test.ts` enforces the 600-token budget.
- **N9** `e72248f` `306c61c` (spec `.ai/plans/n9-context-picker.md`, has the live probe table):
  - Codex context picker: windows come from `~/.codex/models_cache.json` (`$CODEX_HOME`; `model/list` has no window fields), `codexWindows()` in `codex.ts`; "Codex default" gets the `isDefault` model's windows. `Thread.contextWindow` (migration 17) → `config.model_context_window` on thread start/resume (rides the config signature, so a change reloads the thread). Picker in `ContextPicker.tsx`, shown for threads **and drafts** only when `maxContextWindow > contextWindow` (GPT-6-Luna / 5.6: 272K → 872K; Codex clamps above max, reports 95%). Model change clears it.
  - No Claude/ACP picker: Opus/Sonnet 5.5 already report 1M; `supportedModels()` has no `[1m]` values; ACP exposes no option.
  - Missing project folder: `Service.send` checks `existsSync(cwd)` first → one `error` event + `running:false` + `projects-changed`; `projects:list` adds `missing`; sidebar "Folder missing" + **Locate folder…** (`projects:relocate`, `Store.setProjectPath`).

**Next, in order:**
1. **Windows PC gate for N7, N8, N9** (roadmap §W step 2): `bun install`, `bun run typecheck`, `bun run test`, `bun run dev`, then live: a failing check command under PowerShell (N7), `/context` guide row (N8), Codex Max → footer `/ 828k` and a project with a deleted folder (N9). Record "Windows: ✅ date" on each roadmap line.
2. Pick from the backlog (roadmap §2, B1–B12, each with its promotion trigger) — ask the user which.
3. Small follow-ups found in N9 (not done): the typed message is dropped when the folder is missing (could stay in the composer); Locate folder… dialog not driven live (CDP can't drive native dialogs; path setter is unit-tested); empty "New thread" leftovers in `sambor-prei-kuk` / `n2-live` from testing.

**Test projects:** `n2-live`, `n3-live`, `mem-sandbox` point at deleted session scratchpads (they now show "Folder missing") — use them to test N9, or remove them. `sambor-prei-kuk` is the user's real project: only tool-free prompts in Ask mode.

**Working notes from this session:**
- Restarting the dev app: `pkill -f "electron-vite dev"` leaves the Electron child alive on the CDP port — also `kill $(lsof -tiTCP:9455 -sTCP:LISTEN)`. Main-process changes need that restart. Launch: `bun run dev -- --remoteDebuggingPort 9455`; drive with `agent-browser --cdp 9455` (plain `connect` launches a separate browser).
- Delegation: a 12-file implementer brief timed out at 40 min (DeepSeek v4 Flash, ~2/3 done). Keep implementer briefs to ≤ ~5 files, or do mid-size phases directly; researcher briefs are fast and reliable.
- The auto-mode classifier blocks `git push -f origin HEAD:windows` and `gh run …` until the user grants it in-session.

## Resume here — after Phase E (older)

**Phase E shipped (how it works):** per-project notes are markdown files in `<userData>/memory/projects/<projectId>/` (`MEMORY.md` + one file per fact, Claude's auto-memory format; not in the repo, not in the DB). `src/main/memory/`: `store.ts` (cap 200 lines / 4,800 chars; `rebuildIndex` keeps Claude's own lines verbatim), `import.ts` (one-time copy from `~/.claude/projects/<key>/memory` + `~/.codex/memories/MEMORY.md`, `.imported` marker, sources untouched), `index.ts` (`memoryOn`, `memoryPrompt`), `tool.ts` (`memory_read`, project from the tool-server URL `?p=`), `extractor.ts` (after a Codex/ACP turn, debounced 30 s, the thread's own agent on its cheapest same-provider model via hidden `oneShot` → add/update/delete ops), `api.ts` (Library IPC). Claude: `settings.autoMemoryDirectory` (native read/write; capability `nativeMemory`, so no extractor and no `memory_read`). Codex: `memories.use_memories/generate_memories=false` in the thread config (keys confirmed in 0.157: typed `[memories]` table; `features.memories` defaults off) + index in `developerInstructions`, frozen per Codex thread. ACP: `<harness-memory>` block after `<harness-guide>` in the first prompt only. Settings `memory: { enabled, disabledProjects }` (on by default). `/context` sheet lists the whole first-turn breakdown, the agent's own share, and what CubiQ adds.

**Next, in order:**
1. **On the Windows PC:** full `bun run test` + one OpenCode turn in a project with notes (path/CRLF logic has unit tests with `path.win32` cases, but it hasn't run there).
2. doc 11 §11.3 extension import (MCP/skills/plugins "Import from Claude/Codex/OpenCode", `.claude-plugin` bundles) and §11.4 guide diet to ≤ 600 tokens, measured with `/context`.
3. Ideas not started: the ACP `oneShot` runs the user's global default OpenCode agent (here `orchestrator`; it worked) — ask for a plain agent/mode; a small thread notice when the extractor saves a note.
4. Then the previous resume list below and the human release checks (rollback drill, first CI run).

**Test setup that exists:** project **mem-sandbox** (id `cubiq-mem-sandbox`, inserted straight into `projects`) points at a *session scratchpad* path that will be gone — delete it in the app (project ⋯ → delete). Its notes live in `~/Library/Application Support/CubiQ/memory/projects/cubiq-mem-sandbox/`. Drive the app with `REMOTE_DEBUGGING_PORT=9455 bun run dev` (another session's app may hold 9444; wait until the old instance is fully gone before relaunching) and `agent-browser --cdp 9455` with `AGENT_BROWSER_SESSION=cubiq-verify`.

**How to work on this Mac:** dispatch per memory `oc-dispatch-mac` (no `oc-run.mjs`; `perl -e 'alarm N; exec @ARGV' opencode run --agent orchestrator …`; start briefs with "dispatch immediately with your task tool…"; no git in briefs). Main-process changes need an app restart (no hot reload). App data: `~/Library/Application Support/CubiQ/unskilled.db` (events are JSON in `events.payload`, `json_extract(payload,'$.kind')`). Threads created via `window.unskilled.createThread` don't show until `location.reload()`. `api.send` returns when the turn is queued, not finished. Live checks: Claude on Haiku, one short turn (user's limit); OpenCode free model that works here: `opencode/nemotron-3-ultra-free`; `opencode-go/*` need a paid Go plan and some Zen models are region-locked.

### Previous resume list (Windows PC, 2026-09-27)

State then: everything committed. Uncommitted on purpose (the user's): `CLAUDE.md` notes, `SETUP-OTHER-PC.md`, and a line-ending-only snapshot. Before any commit: `git diff --cached --stat` must show only your files.

In order:
1. **Keep polishing the UI toward T3 Code** (ongoing user request): check every screen in both themes; Settings/ProviderSheet still use native selects (their options are themed).
2. **On the Mac**: `electron . --smoke`, packaged smoke, one turn per agent (Python is there, so the script guard path runs; also check the built-in path), an Antigravity turn if its ACP server (`agy_acp_server.par`) is on PATH there.
3. **Ideas not started**: an "Open in worktree" choice on the per-project + button; a toggle to stop the per-thread Antigravity "only plans" notice once the user knows; per-agent default agent for Alt+Enter background threads (today it uses the last agent picked).
- Needs a person: rollback drill (`plan/docs/rollback.md`), first CI run on GitHub, dropping `stash@{0}` (superseded by `4638000`).

**Testing note (user, 2026-09-27):** the user's Claude limit is low — do live checks with OpenCode (DeepSeek via AgentRouter) and Codex (Luna/Terra; Sol is not on their ChatGPT plan), and keep Claude to one short confirming turn. Everything must still work with Claude.

**Worker routing (user, 2026-09-27):** every opencode worker: AgentRouter DeepSeek v4 Flash → Token Harbor paid DeepSeek v4.1 Flash → Qwen3.7 Flash (backup of the old config: `~/.config/opencode/opencode.json.bak-2026-09-27`). The AgentRouter proxy must listen on 127.0.0.1:3900 (`~/.config/opencode/start-proxy.bat`). DeepSeek via AgentRouter answered most briefs first try (10B, 10E, 10B2, 10D, 10G, T8.13); in the evening it also failed with "socket hang up" and "content[].thinking must be passed back" (the Antigravity brief failed twice, so Claude wrote that driver), and Token Harbor paid v4.1 picked up 10H and 10K. oc-run counts a bare "Task cancelled" reply as success: read the output before trusting exit 0. Headless workers get auto-rejected on anything outside the repo (external_directory), so say "stay inside the repository" in every brief.

## Windows portability (`src/main/winspawn.ts`)

`spawnCommand`/`execCommandSync` resolve a bare name on PATH and run `.cmd` shims through cmd.exe with cross-spawn-style double escaping (Codex `-c` values survive); `killTree` uses a synchronous `taskkill /T /F` (a plain `kill()` left `opencode.exe` running). Non-Windows paths are unchanged.

## Open items

- ~~**Flaky under full-suite load**~~ **fixed 2026-09-29 (`4c596f4`)**: on macOS `git` is the `/usr/bin/git` xcrun shim, ~150 ms/call inside vitest workers vs ~5 ms for the real binary; `test/setup-git.ts` puts a symlink to `xcrun -f git` first on PATH (darwin only), `testTimeout` is 15 s for CLI e2e, and the db worker fixture resolves extensionless `.ts` imports. Full suite 0 failed twice on the Mac. Re-check on the Windows PC (no shim there; Node 22.17 `db.test` item below may still apply).
- **This Windows PC:** Node 22.17 → `db.test` worker test fails (`Unknown file extension ".ts"`); needs Node ≥ 22.18. `codex-e2e` "offers the browser tools…" fails under full-suite load only: its first request goes out before the mock stdio `docs` MCP server is up (passes alone) — consider `startup_timeout_sec` for app MCP servers.
- **Phase 6 carried forward:** T6.5 stale-cursor path (mark the binding `lost`, re-seed) and T6.11's lighter model-switch card; small threads can't be handed off (the checkpoint would exceed what it replaces — by design).
- **This PC's accounts:** Codex returns 401 "workspace routing unauthorized" (sign in again); a Codex "retrying" status notice stays on screen after the turn ends (seen in the app, pre-existing) — Phase 7/8.
- Manual checks still pending: Claude on a BYOK provider in-app; `dsh` receiving its key; model-picker search/provider name (user request, unscheduled).
- `CLAUDE_CODE_PROMPT_CACHE_TTL` / gateway model discovery have no Provider field; OpenCode BYOK is openai-chat only.

## Environment facts

- **Windows PC:** bun 1.4.2, Node 22.17, codex-cli 0.157.1 (npm shim, ChatGPT login), opencode 1.18.32 (npm shim), no `python` in Git Bash, delegation proxy on `127.0.0.1:3900`.
- Headless preview check without agent-browser (no `AGENT_BROWSER_EXECUTABLE_PATH` in Git Bash): `chrome --headless=new --enable-logging=stderr --v=0 --virtual-time-budget=6000 --dump-dom http://localhost:5199/?state=thread`.
- **Mac:** Node 24.3, bun 1.4.2, codex 0.157.0, Claude Code 2.1.284 (`~/.local/bin`, self-updating; also 2.1.222 fnm + 2.0.56 `/usr/local` installed), OpenCode 1.18.33 (fnm; also 1.0.126 `/usr/local`, 0.0.55 Homebrew — no `acp`), agy 1.2.12; delegation proxy on `127.0.0.1:4141`; no `oc-run.mjs`. The app picks each CLI by `binaries.ts` (PATH-first baseline, only upgrades to a copy that answered `--version` and is strictly newer); Library → Experts → Engines shows the path, version and other installs.
- **Never** touch `~/.config/opencode/opencode.json` (powers the delegation workers) or `~/.codex` in tests. Use temp `XDG_*` / `CODEX_HOME`. Run `electron . --smoke --user-data-dir=<tmp>`.
- **Delegation status (2026-09-27, Phase 8):** two implementer dispatches (T8.3, T8.9) both landed on Token Harbor's qwen3.8-flash after deepseek-v4.1-flash and mimo-v2.6-flash returned empty output; T8.9 took ~40 min. Parallel dispatch works when the brief lists files the worker must not touch and the orchestrator edits only others. **Earlier (morning):** the Token Harbor free models started failing on long briefs (empty output, 40-min timeouts); `oc-run` fell back to Qwen3.8 Flash / GLM 5.3 Flash (Agent Pass). `oc-run` now also drops a model after `--idle` seconds with no activity (default 480; tested with a fake opencode), so a hung model no longer holds the chain for the whole `--timeout` — dispatch F2 with e.g. `--timeout 1800 --idle 300`. If models keep failing, write the brief shorter or do the step directly. A capabilities test ("turns off a preset's claimed capability…") flaked once under full-suite load; passes alone.
- **Delegation:** dispatch with `node ~/.config/opencode/oc-run.mjs --worker <agent> --brief … --out … --log …` (walks the model chain itself — `opencode run` exits on the first model error, so the fallback plugin never fires headless). Write briefs with the Write tool (a bash heredoc with backticks broke once). No key-like strings, "dispatch exactly once". Routing and setup: `SETUP-OTHER-PC.md`.
- **Git Bash heredocs collapse `\\` to `\`**, so JSON or regex with backslashes written that way breaks; use the Write tool for such files. Stage only your hunks of a file that also carries the user's uncommitted edits by writing HEAD + your replacements to the index (`git hash-object -w` + `git update-index --cacheinfo`); `git add -p` isn't available.
- **Packaging on this PC:** the repo path has a space, so node-gyp can't rebuild node-pty; package with `bunx electron-builder --dir --publish never -c.npmRebuild=false` (the dev `node-pty` binary already targets Electron). The packaged app is `dist/win-unpacked/AI Harness.exe` and uses the real `%APPDATA%/AI Harness` data folder.
- **Driving the real app:** launch `electron . --user-data-dir=<tmp> --remote-debugging-port=9333 --inspect=9339`; drive the window over CDP (`Input.dispatchKeyEvent/MouseEvent`, `Page.captureScreenshot`; clicks are CSS px = screenshot px / 1.25 on this PC); patch `dialog.showOpenDialog/showSaveDialog` through the main-process inspector **every launch**, or a real file dialog opens off-screen. Native `<select>` popups can't be driven — use the palette.

## Next

MCP, P1, C0, P2 and P3 are done and live-tested (see **Resume here — P3 done**). D1 done (`86f71c0`), D2 done (`89530f2`), D3 done (`c65337f`). Next: D4 (plan first, needs the user's approval); the Windows PC gate for everything since M1 whenever the PC is available.
