# Phase 3 — Capability parity + defect fixes

**Plan chapters:** Ch. 2 (all) · **Depends on:** 0 · **Independently shippable:** yes · **Risk:** med

Converts the differences between the three drivers (and the four agents behind them) from scattered `if (id === …)` special cases into a declarative `capabilities` contract, and fixes the two concrete defects the capability matrix surfaced: the retired Codex `untrusted` approval policy, and HTTP-gated MCP silently starving ACP agents (including the user's own servers).

Reference for the enum values this phase introduces (Ch. 2 §2.4):

| Driver | `preToolGuard` | `guardEnforcement` | `mcpHttp` | `permissionGranularity` | `skillsDelivery.mode` |
|---|---|---|---|---|---|
| Claude | yes | `block` | yes | `perCommand` | `plugin` |
| Codex | yes | `block` under ask/auto-edit, `warnOnly` under full | yes | `perCommand` | `extraRoots` |
| Antigravity (`agy-acp`) | no | `warnOnly` | `false` (protocol default) | `modeOnly` | `projectWrite` |
| OpenCode | yes (once T3.5a's plugin loads) | `block` | `false` (protocol default) | `perTool` | `projectWrite` |
| Generic ACP / unknown | no | `warnOnly` | from `initialize` | `modeOnly` | `envDir` or `none` |

---

## Research references

Paths are relative to the repo root. Read the chapter that explains *why* before writing the code.

- [`plan/docs/02-capability-parity.md`](../../plan/docs/02-capability-parity.md) — the whole chapter: §2.1 the capability matrix, §2.2 the landing point for every gap, §2.3 Antigravity, §2.4 the `capabilities` descriptor.
- [`plan/docs/05-streaming-reasoning.md`](../../plan/docs/05-streaming-reasoning.md) — §5.4, for the `acp/driver.ts` request-permission and notification handling this phase touches.
- [`HARNESS.md`](../../plan/docs/HARNESS.md) — the skill-invocation contract (`Call the Skill tool with "x"`) and the pre-tool hook interface (a JSON object with `tool_name` and `tool_input` on stdin, exit 2 = deny), which is what the guardrail work must satisfy per driver.
- [`research-ai-agent-harnesses.md`](../../plan/docs/research-ai-agent-harnesses.md) — Part 1 §1.2 (OpenCode's permission rules, plugin hooks and the v2 LSP gap) and §1.1 (T3 Code's provider list, i.e. what a control surface can and cannot normalise).

**Always first:** [`../README.md`](../README.md) — the phase map, the eight cross-phase invariants, the conventions and the task format. Invariants bind every task in this file.
**Spikes that gate this phase:** [`../open-questions.md`](../open-questions.md) — S1 (Claude `{resume, model}`), S4 (Codex per-turn model), S8 (where an OpenCode plugin can load from), S9 (Codex sandbox spelling).

---

### T3.1 — Add the `capabilities` descriptor to `AgentDriver`

- **What:** Add `AgentCapabilities` to `src/main/agents/types.ts` — booleans `mcpStdio`, `mcpHttp`, `preToolGuard`, `resume`, `fork`, `revert`, `compaction`, `perMessageModel`, `vision`, `webSearch`, `planMode`, `interrupt`, plus enums `skillsDelivery`, `permissionGranularity: "perTool" | "perCommand" | "modeOnly"`, `guardEnforcement: "block" | "warnOnly"`, `sandbox: "none" | "workspace" | "full"` — and add `capabilities` to the `AgentDriver` interface (`types.ts:50-70`). Populate Claude/Codex from constants, ACP presets from `ACP_PRESETS` metadata and from `initialize`'s `agentCapabilities` (`driver.ts:55-63`), and give an unknown `agents.json` entry a declared-safe default.
- **Files:** `src/main/agents/types.ts` (modify), `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `src/main/agents/registry.ts` (modify)
- **Acceptance:** a test asserts `SAFE_DEFAULTS` is exactly `{ permissionGranularity: "modeOnly", guardEnforcement: "warnOnly", sandbox: "none", mcpStdio: false, mcpHttp: false, preToolGuard: false, ... }`; a test loads an `agents.json` entry with no metadata and asserts its capabilities deep-equal `SAFE_DEFAULTS`; and every driver returned by `service.listAgents()` has a `capabilities` object (no `undefined`).
- **Notes:** Ch. 2 §2.4. UI and Service branch on `driver.capabilities.preToolGuard`, never on `driver.id === "claude"`. The safe default is "ask-mode permissions, warn-only guard, no harness MCP tools" — half-wiring an unknown agent is worse than degrading it.
  - `mcpHttp` is a protocol capability that defaults to `false`: ACP states clients and agents MUST treat omitted capabilities as unsupported.
  - `capabilities` is seeded from `ACP_PRESETS` metadata and updated after `initialize`. For **protocol** capabilities (`mcpHttp`, `resume`, `loadSession`, prompt capabilities) `initialize` is authoritative in both directions — a preset can gain or lose support between releases, and T3.4 depends on reading the real value. Preset metadata supplies only what the protocol cannot report (`guardEnforcement`, `skillsDelivery`, `permissionGranularity`). If `initialize` removes something the UI already rendered, re-render and emit a `notice` (invariant 7) — never keep showing a capability the agent just said it lacks.

### T3.2 — Replace the string `skillCallPrefix` with a skills-delivery strategy

- **What:** Change `AgentDriver.skillCallPrefix: string` (`types.ts:55-60`) into `skillsDelivery: { mode: "plugin" | "extraRoots" | "envDir" | "projectWrite" | "none"; prefix?: string }` and thread it through `composePrompt` (`compose.ts:12`), `service.send` (`service.ts:102`), `claude.ts:167`, `codex.ts:294` and `acp/driver.ts:352`; add `skillDeliveryGap(driver)` naming why an agent cannot reach a skills folder without a project write.
- **Files:** `src/main/agents/types.ts` (modify), `src/main/skills/compose.ts` (modify), `src/main/service.ts` (modify), `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `src/main/library.ts` (modify)
- **Acceptance:** `pnpm test -- skills` asserts `composePrompt(catalog(), "x", "implement", { mode: "plugin", prefix: "harness-skills:" })` contains `harness-skills:implement`, and with `{ mode: "none" }` it contains no prefix; a test asserts `skillDeliveryGap({ mode: "projectWrite" })` and `skillDeliveryGap({ mode: "none" })` return a non-empty reason while `plugin`/`extraRoots`/`envDir` return `null`.
- **Notes:** Ch. 2 §2.2. This is a *delivery strategy*, not a name-mangling hint: Claude uses a local plugin (`plugins: [{ type: "local", path }]`), Codex `skills/extraRoots/set`, DeepSeek the `skillsDirEnv` var (`DSH_BUNDLED_SKILL_DIR`), and Antigravity/OpenCode/Cursor only `.agents/skills` inside the project.
  - The honest statement: Antigravity and OpenCode **cannot** reach a skills folder without a project write — the harness must say so rather than pretend the skills are available. `skillDeliveryGap` is that sentence, surfaced in the Library (`Library.tsx:478-489`).
  - User-invoked skills need none of this — `composePrompt` expands the slash command into the prompt text before the driver sees it, so `/foo` is identical on all four by construction.

### T3.3 — Defect 1: migrate `codexPolicy("ask")` off the retired `untrusted`

- **What:** Change `codexPolicy("ask")` (`codex.ts:57-66`) from `approvalPolicy: "untrusted"` to `"on-request"` (optionally the `granular` form), and verify the `sandbox` value spelling against the Codex docs — the repo sends `workspace-write` while the docs' example shows `workspaceWrite`; pin the correct value with spike S9 before merging.
- **Files:** `src/main/agents/codex.ts` (modify), `test/codex.test.ts` (modify — the assertion at `codex.test.ts:117`)
- **Acceptance:** `pnpm test -- codex` passes an assertion that `codexPolicy("ask").approvalPolicy === "on-request"` and `!== "untrusted"`, and that `codexPolicy("auto-edit").approvalPolicy === "on-request"` (i.e. the two collapse); a test asserts the sandbox value equals whatever the spike pinned, so a future typo fails the suite.
- **Notes:** Ch. 2 §2.2. Codex's docs state `approval_policy = "untrusted"` is **no longer supported**, so today's Ask mode is either rejected or silently defaulted.
  - The consequence is design-relevant, not cosmetic: Ask and Auto-edit then both map to `on-request` + `workspace-write`, so the three-mode model collapses to two **for that driver**. The distinction must be carried by the harness — in Ask the `item/commandExecution/requestApproval` judge asks for every command; in Auto-edit it auto-approves the same shapes Claude's `acceptEdits` auto-approves.
  - The sandbox-spelling question is a genuine `[U]` until the spike answers it: guessing wrong silently changes the isolation boundary. Record the spike result in the commit message.

### T3.4 — Defect 2: stop `forAcp` silently dropping HTTP MCP servers

- **What:** Change `forAcp` (`servers.ts:159-165`) so the HTTP gate reports what it dropped instead of returning `[]` invisibly — return `{ servers, dropped: string[] }` (or add `forAcpWithReport`) — and make `mcpServersFor` (`driver.ts:247-255`) emit a `notice` naming each dropped server; read `http` from `initialize`'s `agentCapabilities.mcpCapabilities.http`, which is where the driver already reads it (`driver.ts:248`).
- **Files:** `src/main/mcp/servers.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `test/mcp.test.ts` (modify — the `forAcp` assertions at `mcp.test.ts:62-65`), `test/acp.test.ts` (modify)
- **Acceptance:** a test asserts `forAcp([docs, web], false)` returns the stdio server **and** a `dropped` list containing `"web"`; an ACP driver test against `mock-acp-agent.mjs` (which reports no HTTP capability) with a user HTTP server asserts the turn emits a `notice` whose text contains the server name; a test asserts a `notice` is emitted rather than `[]` being returned silently.
- **Notes:** Ch. 2 §2.2 and Ch. 7 §7.1 rule 2. The bug is worse than "harness tools are missing": `forAcp` drops the **user's own** `http`-type servers too. Per the ACP initialization spec `mcpCapabilities.http` is a `boolean` defaulting to `false`, so this is the protocol default, not a quirk of one agent. Never hide a capability gap — disable the control and say why, or state the loss explicitly (invariant 7). The capability must be read from `initialize`, not assumed from a preset: a preset can gain HTTP support between releases.

### T3.5 — Close the guardrail gap per driver

- **What:** Keep Claude's `PreToolUse` hook (`claude.ts:205`) and add three paths: (a) **OpenCode** — a plugin implementing `tool.execute.before` that `throw`s on a rejected `bash` command, loaded from a location that is neither the project nor the user's own config dir (S8 decides how; if no such location exists, OpenCode stays `warnOnly` and the Library says so); (b) **ACP** — a judge inside the `session/request_permission` handler (`driver.ts:212-230`) **before** `pickPermission()` (`driver.ts:218`), answering `reject_once` (not `reject_always`, whose agent-side memory may block every later command of that kind) or `{ outcome: "cancelled" }` plus a `notice` when `toolCall.kind === "execute"` and the guard rejects; (c) **Codex** — the same command judge inside the **`item/commandExecution/requestApproval`** branch of `onRequest` (`codex.ts:211-220`), returning `{ decision: "decline" }`. Explicitly do **not** use `mcpServer/elicitation/request` (`codex.ts:221`, `codex.ts:228-230`) — it bails unless `_meta.codex_approval_kind === "mcp_tool_call"`, so it only ever carries MCP tool calls.
- **Files:** `src/main/agents/acp/driver.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/providers/opencode-plugin.ts` (new), `test/acp.test.ts` (modify), `test/codex.test.ts` (modify)
- **Acceptance:** an ACP test with a mock `execute` command the guard blocks asserts the command is **not** executed, the chosen option is `reject_once`, and a `notice` is emitted; a Codex test with a blocked command asserts `onRequest` returned `{ decision: "decline" }`; a test asserts `codex.capabilities.guardEnforcement === "warnOnly"` under `full` and `"block"` under `ask`/`auto-edit`; a test asserts the guard is never wired to `onElicitation`.
- **Notes:** Ch. 2 §2.2. Record per driver whether the guard **blocks** or is **warn-only**: Claude blocks; OpenCode blocks once its plugin loads; the ACP judge blocks only commands the agent routes through `session/request_permission` — an agent may run a command without asking (ACP does not require it to), so generic ACP stays `warnOnly` in the table above even with the judge in place; Codex blocks under `ask`/`auto-edit` (a real pre-execution veto, equivalent to Claude's deny) but is **warn-only under `full`**, because `codexPolicy("full")` is `approvalPolicy: "never"` + `danger-full-access`, so no callback fires at all.
  - For `full`, tighten `sandbox` away from `danger-full-access` and surface a post-hoc notice ("guardrail: this command would have been blocked").
  - The Codex decline reuses the exact shape of a user refusal, so no new protocol surface is needed.
  - The ACP judge runs **before** `pickPermission()`, or a mode that auto-allows would skip the guard entirely: in `full` every kind is allowed, and in `auto-edit` every kind in `AUTO_EDIT_KINDS` is allowed (`driver.ts:68` — `execute` is deliberately not in that set, which is the case the guard must still catch).

### T3.6 — Map permissions per driver and store approvals by `(agentId, toolName, canonicalPattern)`

- **What:** Add `src/main/approvals.ts` storing approvals keyed by `(agentId, toolName, canonicalPattern)` where `canonicalPattern` normalizes whitespace and quotes; add the `ask`/`auto-edit`/`full` → per-driver mapping table (Claude `default`/`acceptEdits`/`bypassPermissions`; Codex `on-request`+`workspace-write` twice and `never`+`danger-full-access`; ACP via `pickPermission()` on `kind`; OpenCode via its `permission` map) and make allow-always **non-inheritable** across agents.
- **Files:** `src/main/approvals.ts` (new), `src/main/service.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify)
- **Acceptance:** a test asserts `approvals.get("codex", "Run", "npm test")` is `undefined` after `approvals.remember("claude", "Bash", "npm  test")` (different agent, and the pattern normalized); a snapshot test of the mapping table covers all nine `(mode, driver)` pairs; a test asserts re-asking happens after a switch to a different agent for the same command.
- **Notes:** Ch. 2 §2.2. "Allow always" scopes differ fundamentally: Claude writes a settings permission rule; OpenCode's `always` is **for the rest of the current session only**, using patterns the *tool* proposes; ACP's `allow_always` means "remember the choice" but the memory lives in the **agent process**, not the client. Rule syntax, tool names, sandbox paths and process lifetimes are all different, so allow-always cannot cross agent boundaries. `delete` stays excluded from `AUTO_EDIT_KINDS` (`driver.ts:68`).

### T3.7 — Add `applyModel()` to the Service layer

- **What:** Add `Service.applyModel(threadId, model)` returning `"in-place" | "new-session" | "unsupported"`, called at the top of `runTurn` **before** `session/prompt`, with a driver-supplied `setModel?(live, model)` hook: Claude — `Query.setModel()` exists (`sdk.d.ts:2755`) but is "only available in streaming input mode", and this driver runs one `query()` per turn with a string prompt, so without a driver refactor Claude's path is `{ resume, model }` on the next turn: `in-place` if S1 passes, otherwise `new-session`; Codex — the driver already sends `model` on `thread/resume` and every `turn/start` (`codex.ts:321`, `:356`), so the classification (`in-place` vs `new-session`, plus the documented warning + one-time switch instruction surfaced as a `notice`) is what S4 settles; OpenCode per-message `body.model` (in-place), ACP `session/set_config_option` on the `category: "model"` option (`driver.ts:298-308`, in-place), agy-acp `--model` (new-session). When in-place is unsupported, fork/resume a new session at the new model, replay a summary, and label the turn boundary in the UI.
- **Files:** `src/main/service.ts` (modify), `src/main/agents/types.ts` (modify), `src/main/agents/claude.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify)
- **Acceptance:** a test with a fake driver exposing `setModel` asserts `applyModel` returns `"in-place"`; a fake driver without it returns `"unsupported"`; the Codex driver returns the mode S4 recorded and, when it is `new-session`, emits exactly one `notice` containing the word `model`; a test asserts `applyModel` is called before the driver's first `session/prompt`/`turn/start`.
- **Notes:** Ch. 2 §2.2. Every model change mid-thread invalidates the prompt cache — "each model has its own cache" — so the returned mode is what the UI uses to decide whether to show the switch card (Ch. 7 §7.3). Never change the model silently: classify the cache invalidation and tell the user (invariant 4).
  - The ACP path already exists (`driver.ts:298-308`); this task only classifies it and routes it through the Service.
  - Phase 6 T6.5 reuses this exact `applyModel()`; it must not grow a second, differently-typed one on the driver contract.
  - Moving the Claude driver to streaming input mode would unlock `setModel()`, `interrupt()` and `setMcpServers()`; that refactor is out of scope here — record it as a follow-up if S1 fails.

### T3.8 — Branch on capability, not on `driver.id`

- **What:** Add per-agent capability chips and a **"What this agent can't do here"** list to the Library engine cards (`Library.tsx:314-343`, using the existing `wb-tag`/`wb-card` vocabulary), driven entirely by `driver.capabilities`; assert no agent-id branch exists outside the registry (today the only ones are `library.ts:75` and `:82`, which decide skill routing by id) and that the guard variant of the permission card is chosen by `capabilities.guardEnforcement`, not by agent name.
- **Files:** `src/renderer/src/components/Library.tsx` (modify), `src/renderer/src/components/PermissionCard.tsx` (modify), `src/main/library.ts` (modify — `:75`, `:82`), `test/library.test.ts` (modify), `test/no-agent-id-branches.test.ts` (new)
- **Acceptance:** a test reads every file under `src/main/` except `agents/registry.ts` and `agents/*` driver constructors as text and asserts none contains `id === "claude"`/`id === "codex"`-style comparisons against a literal agent id (`service.ts` already has none, so asserting only it would pass today and prove nothing); `library.ts:75`/`:82` are migrated to `capabilities.skillsDelivery`; a component test (`.tsx`, Phase 0 T0.10) renders a card for a capability fixture with `guardEnforcement: "warnOnly"`, `mcpHttp: false` and asserts the rendered text contains `warn-only` and `MCP over HTTP: no`, and that the "can't do" list names both.
- **Notes:** Ch. 2 §2.4 and Ch. 7 §7.6. The matrix exists to make the honest inverse visible — "guardrails: block / warn-only", "MCP over HTTP: yes / no", "model-invoked skills: plugin / extra folder / project folder", "fork & rollback: yes / no", "compaction: yes / no". The full Library redesign is phase 8; this task ships only the capability-driven chips and the no-`driver.id` invariant.

### T3.9 — Deliver MCP in each agent's own wire format, and survive a config change

- **What:** Make `forCodex` (`servers.ts:143-152`) emit snake_case `mcp_servers` (mirroring `config.toml`) and note that camelCase `mcpServers` is silently ignored; keep ACP's `mcpServers` for `session/new`/`session/resume`; and make the MCP-config reload that already happens — Codex `thread/unsubscribe` + `thread/resume` (`codex.ts:312-316`) and ACP `session/close` + `session/resume` (`driver.ts:264-269`), both at the start of `runTurn`, i.e. at a turn boundary — **visible**: emit a `notice` naming the servers that changed and saying the session was reopened. Phase 5 T5.2 then removes the automatic trigger (browser tools) and batches user edits; this task owns only the notice and the wire format.
- **Files:** `src/main/mcp/servers.ts` (modify), `src/main/agents/codex.ts` (modify), `src/main/agents/acp/driver.ts` (modify), `test/mcp.test.ts` (modify)
- **Acceptance:** a test asserts `forCodex([server])` keys are `mcp_servers` with `http_headers` (snake_case), matching the existing assertion at `codex.test.ts:200-205` (this already passes — it is a regression guard, not new work); a test asserts that changing `input.mcpServers` between turns emits exactly one `notice` containing the changed server's name and the word `reopened`, for both Codex and ACP (extend the existing tests at `codex.test.ts:163-172` and `acp.test.ts:131-142`).
- **Notes:** Ch. 2 §2.2. Three wire formats, one source list — and the config change is both a **capability cliff** and a **cache-hit cliff**: reopening a session discards the prompt-cache prefix, which is costed in Ch. 4/phase 5. The notice must say the session was reopened, not just that servers changed.

---

## Risks & rollback

- **Codex `on-request` migration.** Ask mode changes observable behaviour (it now actually asks). Verify against the mock app-server (`test/fixtures/mock-codex-app-server.mjs`) and against a real binary behind `UNSKILLED_CODEX_BIN` before merging; a wrong approval policy can auto-approve commands the user expected to be asked about.
- **Guard veto false positives.** A judge that blocks too aggressively is worse than none — it breaks legitimate commands. Fail open on a guard-script error (as `guard.ts:44-47` already does for a spawn error) and fail closed only on a timeout (`guard.ts:38-42`).
- **`forAcp` signature change.** Changing the return type touches `mcp.test.ts` and `driver.ts`; keep a thin `forAcp(servers, http)` wrapper returning just the array if other callers exist, and migrate them in the same commit.
- **`applyModel` cache cliff.** Codex's `thread/resume` + model is `new-session`-class; do not silently re-seed a large history. Surface the mode and let the user decide.
- **Rollback command:** revert the phase commits. The two defect fixes are small and independently revertable; T3.1/T3.2 are additive-first (a removed field stays as a read-only projection for one release), so an older build still reads the old shape.

## Exit criteria

- [x] `pnpm typecheck`, `pnpm test` and `pnpm build` are green.
- [x] Every driver exposes a `capabilities` object; an unknown `agents.json` entry degrades to `SAFE_DEFAULTS`.
- [x] No literal agent-id branch remains outside the registry/driver constructors (asserted by a test that reads `src/main/`); `library.ts` routes skills by `capabilities.skillsDelivery`.
- [x] ~~`codexPolicy("ask").approvalPolicy` is `"on-request"`, never `"untrusted"`~~ — **inverted by the 0.157 spike** (`untrusted` is the only policy that asks; approved decision A): Ask and Auto-edit are pinned to `untrusted` + `workspace-write` by tests. The sandbox spelling is pinned.
- [x] An ACP agent without HTTP MCP support produces a visible notice naming each dropped server, not a silent drop.
- [x] Guardrails block on Claude, on OpenCode once its plugin loads, on ACP commands that ask permission, and on Codex under `ask`/`auto-edit`; Codex under `full` and generic ACP are recorded as warn-only.
- [x] `applyModel()` returns `in-place | new-session | unsupported` with a per-driver branch, and approvals are keyed by `(agentId, toolName, canonicalPattern)` and never inherited across agents.
- [x] An MCP config change reopens the session at the turn boundary and says so in a `notice`.
