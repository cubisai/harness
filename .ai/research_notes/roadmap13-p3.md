# P3 "lazy capability discovery" — code map

Findings
- Tool calls are batched by a single rule: consecutive calls whose loop-level `access === "read"` run together (up to 8), everything else runs alone. `HarnessTool` has no `readOnly`; only `autoAllow`, which is mapped to `access = "read"`/`"edit"` for app tools — so state-mutating auto-allowed tools (browser_click, team_write, memory_write…) are batched as if read-only.
- Skill catalog is a flat `- name: description` list in the `skill` tool description, per-description capped at 160 chars; no total-size threshold and no search over skills.
- MCP tool cache is in-memory only, TTL 10 min (ok) / 1 min (failure); `search_tools` silently drops unreachable servers (reported as "no match"), while `call_mcp_tool` distinguishes unreachable from unknown.
- Long native-tool output is bounded (2000 lines / 50 KB) and saved to `<userData>/harness-output/<callId>.txt`; app/MCP/browser results bypass `bound()`.
- No QuickJS / `node:vm` / isolated-vm anywhere. No generic feature-flag system: the closest gates are `Settings.mcpRouter` and the Antigravity opt-in.

---

## P3.1 Tool effects & scheduling

**Parallel vs serial today.** The loop executes one model step's calls in `runCalls` (loop.ts:217). It walks calls in order; a run starting at `i` extends while `planned[j].tool.access === "read"` and `j - i < READ_CONCURRENCY` (loop.ts:231-233); the run is executed with `Promise.all` (loop.ts:235) and results are written back in call order (loop.ts:236). Non-read calls fall into a batch of one. `READ_CONCURRENCY = 8` (loop.ts:77). Comment: "Read-only calls in a row run together; edits and commands run one at a time, in order." (loop.ts:2-3).

**Types.**
- `HarnessTool` (agents/types.ts:32-39): `name`, `description`, `input` (Zod shape), `autoAllow` ("Safe to run without asking in ask mode", agents/types.ts:36), `run`. There is **no** `readOnly` field (grep for `readOnly|autoAllow` found only `autoAllow` on HarnessTool; the `readOnly` matches at codex.ts:157/167 are Codex sandbox strings).
- `NativeTool` (tools/types.ts:47-59): `name`, `displayName`, `description`, `parameters`, `access`, `summarize`, `run`.
- `LoopTool` (loop.ts:14-24): `definition`, `displayName`, `access`, `summarize`, `inputPayload?`, `outside?`, `run`. Only `access` is consulted for batching.
- `ToolAccess = "read" | "edit" | "shell" | "web" | "other"` (tools/types.ts:7). Only `"read"` batches.

**How permission is decided per call.** `authorize` in driver.ts:364-370: `decide(mode, tool.access, tool.outside?.(args) ?? false)` → allow / deny / ask. `decide` (permissions.ts:11-23) allows `read` and `other` outright; per mode. Only on `"ask"` does it call `input.requestPermission({...canAlwaysAllow:true})` (driver.ts:368). `outside()` is only defined for native `edit` access with a `path` arg (driver.ts:458-465); app tools get no `outside` (`appLoopTool`, driver.ts:475-498). `runOne` calls authorize right before running (loop.ts:261).

**Mapping app tools to access.** `appLoopTool` sets `access: tool.autoAllow ? "read" : "edit"` (driver.ts:487); `nativeLoopTool` passes `access: tool.access` (driver.ts:455). So auto-allowed app tools join read batches.

**Every tool definition, with batching-relevant flags.**

Native (`nativeTools`, index.ts of tools — tools/index.ts:21-23; ordered read, edit/apply_patch, write, bash, glob, grep, web_fetch, todowrite):
| tool | file:line | access |
|---|---|---|
| read | tools/read.ts:18 | read |
| edit | tools/edit.ts:127 | edit |
| apply_patch | tools/apply-patch.ts:177 | edit |
| write | tools/write.ts:14 | edit |
| bash | tools/bash.ts:65 | shell |
| glob | tools/glob.ts:105 | read |
| grep | tools/grep.ts:185 | read |
| web_fetch | tools/web-fetch.ts:81 | web |
| todowrite | tools/todo.ts:70 | other |

App tools (`autoAllow` → loop access = read when true):
| tool | file:line | autoAllow | loop access |
|---|---|---|---|
| browser_open | browser/tools.ts:40 | true | read |
| browser_snapshot | browser/tools.ts:55 | true | read |
| browser_click | browser/tools.ts:62 | true | read |
| browser_type | browser/tools.ts:73 | true | read |
| browser_eval | browser/tools.ts:81 | false | edit |
| browser_logs | browser/tools.ts:89 | true | read |
| browser_screenshot | browser/tools.ts:97 | true | read |
| memory_read | memory/tool.ts:84 | true | read |
| memory_write | memory/tool.ts:167 | true | read |
| skill | skills/tool.ts:30 | true | read |
| search_tools | mcp/router.ts:255 | true | read |
| call_mcp_tool | mcp/router.ts:281 | false | edit |
| design_screenshot | design/tools.ts:76 | true | read |
| design_lint | design/tools.ts:99 | true | read |
| design_critique_save | design/tools.ts:120 | true | read |
| team_write | experts/team.ts:181 | true | read |
| team_read | experts/team.ts:195 | true | read |
| team_post | experts/team.ts:211 | true | read |
| team_board | experts/team.ts:232 | true | read |
| ask_user | questions.ts:156 | true | read |

Loop-only tools: `task` (subagent.ts:92, `access: "read"`), `propose_plan` (plan.ts:34, `access: "read"`). The loop assembles native + app + skill + plan + ask + task and dedups by name (driver.ts:346).

Note: because these auto-allowed tools have loop access `read`, `browser_click`, `browser_type`, `memory_write`, `team_write`, `team_post`, `design_critique_save` can run in parallel with other read calls in one batch.

Tests that pin current behaviour:
- test/harness-loop.test.ts (line 78 "runs read-only calls together and edits one at a time…"; line 97 refusals/unknown/bad-JSON)
- test/harness-driver.test.ts (line 401 plan-mode refusal; line 463 parallel subagents; line 509 read-only child tools)
- test/harness-subagent.test.ts; test/harness-plan.test.ts; test/approvals.test.ts

---

## P3.2 Skill catalog

**Discovery.** `discoverSkills(source)` reads `<source.dir>/<folder>/SKILL.md`, parses only the frontmatter subset `name`, `description`, `disable-model-invocation`, `user-invocable`, `argument-hint`, `mode` (discover.ts:31-56); a skill without a description is skipped (discover.ts:87-88); `invocation` = `disable-model-invocation` ? user : model (discover.ts:93). `SkillCatalogs` merges layers by precedence, project dirs first: `.cubiq/skills`, `.agents/skills`, `.claude/skills`, then harness, bundled, legacy (sources.ts:86-101; dirs at sources.ts:63-71). Discovery is cached by folder mtime stamp (sources.ts:48-56). `forAgent` filters model skills by delivery `reads` / native names / `mode: design` (sources.ts:122-125).

**Rendered into the prompt / skill tool description.** `skillTool(skills)` builds the description once: for each skill `- ${name}: ${description}` (tool.ts:19-22) under the header "Load a skill: …" (tool.ts:23-25). The tool loads one body by exact name via `readSkillBodyAt` (tool.ts:32-39). For user-typed `/skill` invocation, `composePrompt` wraps the body in `<skill name base>` (compose.ts:32-44). For Claude, `ensurePlugin` copies skills into a plugin and qualifies cross-calls (plugin.ts:43-77); `ensureModelSkillsDir` copies for directory-loading agents (plugin.ts:83-99).

**Size threshold / token cost.** Only per-skill description is capped: `MAX_DESCRIPTION = 160` (tool.ts:6,20). There is **no** total catalog cap and no cap on the number of listed skills. Token cost: `skillsOf` estimates `name: description` at 4 chars/token; `"tool"` mode bills the serialized skill tool plus entries the agent lists itself (context-preview.ts:26-40); `toolTokens` serializes `{name, description, schema}` / 4 (context-preview.ts:5-14). No hard limit is applied before rendering.

**Search over skills today:** not found. Grep of `src/main/skills` for `search|query|rank|find` returns only `findSkillsRoot` (catalog.ts:16) and an exact-name `skills().find(...)` (tool.ts:33); matching a call is by exact `=== name` (tool.ts:33). The model matches by reading the description list, not by a search tool.

Tests that pin current behaviour:
- test/skills-discover.test.ts (line 242 `skillTool`; line 136 `forAgent`; line 10 imports)
- test/context-preview.test.ts (lines 41-85 skills token pricing, incl. `"tool"` mode at 51)
- test/skills.test.ts; test/skill-list.test.ts; test/library.test.ts; test/harness-skill-routing-live.test.ts; test/harness-context-prune.test.ts (line 67 skill result never pruned)

---

## P3.3 MCP catalog

**McpToolsCache.** Class at servers.ts:476-519. Backed by `private entries = new Map<string, McpToolsEntry>()` — **in-memory only, no file persistence** (servers.ts:477; grep for persistence found none). TTLs: `peek` returns null when `now - at >= (entry.ok ? 600_000 : 60_000)` — 10 minutes for a successful listing, 1 minute for a failure (servers.ts:492). `invalidate(spec?)` deletes one/all (servers.ts:483-486). `refresh(servers, timeoutMs=5_000)` lists every enabled server lacking a fresh listing, `Promise.all`, deduping concurrent work via `inflight` (servers.ts:497-518). `listServerTools` connects, `listTools`, disconnects (servers.ts:435-456). No disk cache; a restart starts empty.

**Router refresh behaviour.** `LIST_TIMEOUT_MS = 15_000` (router.ts:228). `search_tools.run` calls `deps.listings.refresh(enabled, LIST_TIMEOUT_MS)` on every call (router.ts:262), then ranks over cached entries (router.ts:263-267). `call_mcp_tool.run` refreshes just the target server (router.ts:294). The tool descriptions snapshot the cache synchronously at construction via `peek` to avoid listing at session open (router.ts:238-247).

**MCP_ROUTER_MIN_TOOLS.** `= 20` (router.ts:141). Gating: `mcpRoutingFor` returns false when `settings.get().mcpRouter === "off"`, else counts cached tools and compares `>= MCP_ROUTER_MIN_TOOLS` (index.ts:740-745); `mcpRouted` re-checks capability + setting + `listedToolCount(servers) >= MCP_ROUTER_MIN_TOOLS` (index.ts:1279-1280).

**Unreachable server vs "no match".**
- In `search_tools`: failed listings are silently excluded (`if (listing?.ok)`, router.ts:266), and a failed/absent server is never named. If nothing ranks, the reply is only "No tool matched "<query>". Servers: …" (router.ts:270-272). So an unreachable server is indistinguishable from a server with no matching tool here.
- "No servers enabled at all" is separate: `search_tools` returns "No MCP servers are enabled for this project." isError (router.ts:268).
- In `call_mcp_tool`: unknown server → "Unknown MCP server …" (router.ts:290-292); listing present but `!ok` → "Couldn't reach MCP server "<server>": …" without calling (router.ts:296-297); listing ok but tool absent → "Unknown tool … Closest: …" (router.ts:300-303). These three are distinguished.

Tests that pin current behaviour:
- test/mcp-router.test.ts (line 252 no servers; line 259 unknown server; line 267 "Couldn't reach…, not that the tool is unknown"; line 277 unknown tool + closest; line 285 invalid args)
- test/mcp-tools-cache.test.ts (line 59 "keeps an ok listing for ten minutes and a failure for one"; line 41 dedupe; line 16/27/78/86)
- test/mcp-http.test.ts; test/acp.test.ts (routing capability)

---

## P3.4 Result references (bounded output / paging)

**Mechanism.** `bound(text, ctx, keep)` (tools/bound.ts:15): returns text unchanged if `lines.length <= MAX_LINES (2000)` and `Buffer.byteLength <= MAX_BYTES (50*1024)` (bound.ts:8-9,17); otherwise keeps the head or tail, shrinking to the byte cap (bound.ts:18-24), writes the full text and appends a note. `keep: "head"` default; bash passes `"tail"` (bash.ts:151).

**File naming.** `join(ctx.outputDir, ${ctx.callId.replace(/[^\w.-]/g, "_")}.txt)` (bound.ts:28). `outputDir` comes from deps: `join(userData, "harness-output")` (index.ts:767) → `ToolContext.outputDir` (driver.ts:304). Note text: "[N of M lines omitted; the full output is in <path> (Read it with offset/limit, or Grep it)]" (bound.ts:34).

**Where applied & read-range paging.** Native tools only: read (read.ts:80), grep (grep.ts:113 via `finish`), bash (bash.ts:151, tail), web_fetch (web-fetch.ts:129). The read tool pages with `offset`/`limit` and appends "[Lines X-Y of Z. Use offset=N to read more.]" (read.ts:65-77). The saved file is read back with the same read/grep tools.

**Retention.** No cleanup/rotation of the output dir was found — grep for `harness-output` matched only the one `outputDir` wiring (index.ts:767); bound.ts only writes. Any TTL/deletion is **unverified/not found**. Separately, the harness prunes *old tool results in context* (not files) with `pruneToolOutputs` / `PRUNED_MARKER` (context/prune.ts:11-13,24), keeping `name === "skill"` results (prune.ts:53).

**MCP / browser results are not bounded the same way.** MCP: the pool joins content parts with no size cap (router.ts:73-76) and `call_mcp_tool` returns `{ text: r.text }` directly (router.ts:314); `search_tools` returns up to 10 schemas via `JSON.stringify` unbounded (router.ts:269-274). Browser: in-page snapshot is capped at 400 nodes (`collectPage(400)`, controller.ts:209-212) with a "(snapshot truncated…)" line (snapshot.ts:160); `browser_eval` truncates text to 4000 chars (controller.ts:329). None of these go through `bound()`/`outputDir` because `appLoopTool.run` returns `{ text: out.text }` with no bound (driver.ts:496).

Tests that pin current behaviour:
- test/harness-tools-rw.test.ts (line 36 offset paging text; line 66 "bounds a huge file and saves the full output", asserts `.out/c1.txt`)
- test/harness-tools-bash.test.ts (line 137 "lines omitted")
- test/harness-tools-web-fetch.test.ts (line 93 extracts "the full output is in …")
- test/harness-tools-search.test.ts; test/harness-context-prune.test.ts; test/harness-context-compact.test.ts (line 135)

---

## P3.5 Code-mode pilot

**Sandbox / QuickJS / vm usage:** not found. Grep across the repo for `quickjs|isolated-vm|node:vm|from "vm"|require("vm")|Worker(` returned only `Worker` in preview/host.ts (a utility-process preview worker, host.ts:61-134) and tests (test/db.test.ts:519, preview-office tests). No code-execution sandbox exists. Grep for `sandbox|feature.?flag|enableExperimental|code.?mode` matched only Codex/Chromium sandbox settings (codex.ts:138-164, index.ts:160-173), not a code-mode runtime.

**Feature-flag / settings mechanism to gate an experimental tool.**
- `Settings` interface (shared/types.ts:181-218) has no generic `flags` field. Closest field: `mcpRouter?: "auto" | "off"` (shared/types.ts:206-207). `SettingsStore.update` validates it (settings.ts:184); store class at settings.ts:60-198; `get()` fills defaults (settings.ts:144-147).
- The MCP-router gate itself: `mcpRoutingFor` (index.ts:740-745) and `mcpRouted` (index.ts:1279-1280).
- The Antigravity opt-in is the only other conditional feature gate: `antigravityEnabled()` requires `antigravity === true` and a current ack (settings.ts:201-204; update at settings.ts:189-194).
- Test comment states the intent explicitly: "the release flags are the ones that already exist — the Antigravity opt-in — not a second flag system" (test/flags.test.ts:1-3). No `featureFlags` table/`flags.ts` was found (grep for `featureFlag` returned nothing).

Tests that pin current behaviour:
- test/flags.test.ts (release-flag model; lines 17, 23)
- test/settings.test.ts (store defaults/persistence/validation)
- test/acp.test.ts (line 811 "never asks about routing when the agent doesn't declare mcpRouter")
- No test exists for a code sandbox / vm tool (not found).

---

## Open questions
- Whether `harness-output` is ever cleaned up (e.g. on project delete / data migration) — not found in the searched paths; only the write site was located.
- How `Task`/`Bash` deliberately serialise is only the `access !== "read"` rule; no per-tool concurrency hint exists, so P3 scheduling changes will need a new field on `LoopTool`/`HarnessTool`.