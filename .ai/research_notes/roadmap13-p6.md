# P6 "Expert teams" — code map

## P6.1 Member model / effort

**Types**
- `ExpertMember` carries only `id, name, profession, description, prompt, skills, maxTurns` — no model/effort field (`src/shared/experts.ts:134`–`:143`; `maxTurns` comment at `:141`).
- `TeamAgent` (a member as an engine subagent) likewise carries only `id, description, prompt, maxTurns` — no model (`src/shared/experts.ts:351`–`:358`).
- `ExpertDef` has `kind: "agent" | "team"` (`:147`) and `members?` set only for a team (`:160`–`:161`); the lead is the def itself.
- `teamAgents()` builds each member agent from `{id, description, prompt, maxTurns}` only (`src/shared/experts.ts:401`–`:418`, push at `:410`–`:414`).
- Searched `resources/experts/**` for `^(model|effort|maxTurns|temperature):` — only `maxTurns` appears (e.g. `resources/experts/deep-research-team/members/cross-verifier.md:6`). **No member carries its own model or effort today (not found).**

**How a member run picks its model, per engine** — no engine passes a member-specific model, so the member runs on the thread/lead's model:
- Native harness: `createTaskTool` takes `team?: TeamAgent[]` and `memberTools?` (`src/main/harness/subagent.ts:43`–`:46`); the `agent` param is an enum of member ids (`:86`); the child loop reuses the caller's `opts.request` (same model/effort), only swapping `system` (`:121`–`:124`); a member gets read-only tools plus `opts.memberTools()` and `member.maxTurns ?? SUBAGENT_MAX_STEPS` (`:157`–`:159`). Wired in `src/main/harness/driver.ts:341`–`:357`; `memberTools` = app tools named `team_*` (`:356`).
- Claude: members become SDK `agents` with only `description, prompt, disallowedTools:["Skill"], maxTurns` (`src/main/agents/claude.ts:469`–`:471`); no `model`. Background tasks disabled so members stay in the lead's turn (`:474`–`:476`).
- Codex: members become per-thread agent roles via `codexTeamRoles()` writing `developer_instructions` (= prompt, plus a step-budget sentence when `maxTurns`) (`src/main/agents/codex.ts:109`–`:128`); wired into the thread config `agents` table (`:982`–`:983`). No model in the role.
- OpenCode / ACP: `withOpenCodeTeam` injects `agents[id] = { mode:"subagent", description, prompt, steps?:maxTurns }` — no model (`src/main/inject/opencode.ts:144`–`:167`, line `:150`); wired at `src/main/index.ts:626`; the team context is assembled at `src/main/agents/acp/driver.ts:669`–`:671` (type at `:300`–`:304`). Other ACP injectors ignore the team.
- Capability gate: `subagentTeams: true` on Claude (`src/main/agents/capabilities.ts:81`), Codex (`:115`–`:116`), OpenCode preset (`src/main/agents/registry.ts:38`); when false, a one-time notice says the lead works through roles itself (`src/main/service.ts:304`–`:311`).

**Where the UI shows members**
- Thread strip above the composer: `TeamStrip` renders the lead then one avatar per member; membership only implies "working" from an `Agent` tool-use whose summary ends ` · <id>` (`src/renderer/src/components/experts/TeamStrip.tsx:46`–`:79`, `activeMembers` at `:21`–`:39`). Mounted at `src/renderer/src/App.tsx:250`.
- Library detail modal: lead + member roster (name · profession, description) (`src/renderer/src/components/experts/ExpertDetail.tsx:143`–`:167`); cost note at `:82`–`:84`.
- Library card / chip: "Team · (members+1)" (`src/renderer/src/components/experts/ExpertCenter.tsx:162`); intro avatars + "N team members" + "The lead hands parts of the task to members and combines their results." (`ExpertChip.tsx:141`–`:151`).
- Note: `ExpertDetail.tsx:83` says members work as subagents "on Claude and OpenCode; other agents run the team as one agent", but Codex is also marked `subagentTeams` and the fallback notice names it (`capabilities.ts:115`, `service.ts:308`) — the UI copy is narrower than the capability code.

Tests that pin current behaviour:
- `test/expert-catalog.test.ts` (`expertBlock`, `teamAgents`, reserved ids, member order)
- `test/expert-skills.test.ts` (`teamAgents` maxTurns, skills index, member protocol)
- `test/harness-subagent.test.ts` (`createTaskTool team members`: agent enum, member prompt/tools/maxTurns, unknown id, summarize/payload)
- `test/claude.test.ts` ("passes an expert team's members as SDK subagents", `:235`–`:246`)
- `test/codex-team-roles.test.ts`, `test/codex.test.ts` ("Codex team member rows", `:820`)
- `test/acp.test.ts` (`:493`, hands a team to the injection), `test/inject-opencode.test.ts`
- `test/team-strip.test.tsx`, `test/expert-center.test.tsx` (`:240`–`:269`), `test/expert-chip.test.tsx`, `test/expert-add.test.tsx`

## P6.2 Lead guidance

**Lead text (shared, rides every team turn)**
- `expertBlock()` builds `<expert …>` + prompt, then for a team adds the roster, `TEAM_LEAD_PROTOCOL`, and the Stay line (`src/shared/experts.ts:333`–`:349`); roster line format `- \`id\` — name, profession: description` (`:340`); "## Your team" heading (`:344`).
- `TEAM_LEAD_PROTOCOL` (`src/shared/experts.ts:365`–`:375`), quoted:
  - `:367` "Plan the work as phases. Members in one phase run in parallel (one subagent call each, in the same message); start a phase only after every result of the previous one is in."
  - `:368` "Hand a member one step with your subagent tool (subagent type = the member id). Don't end your turn while a member is still working."
  - `:369` "Each brief states: the objective, the inputs (workspace file names or paths), the member skill to use if any, the expected output and length, what the other members in that phase cover (so they don't overlap), and when to stop." ← this is the brief template.
  - `:370` "Never write a member's specialist output yourself or speak for a member… You plan, brief, relay and synthesize."
  - `:371` "A narrow ask that fits one member goes to that member alone; don't run the whole team for it."
  - `:372` "Members save full results with `team_write` and reply with a short summary and the file name…"
  - `:373` "Members report only to you. `team_board` (for: \"lead\") … `team_post` sends a member a note."
  - `:374` "Route factual claims through the team's verifying member when it has one. The final answer is yours…"

**Member text**
- `teamMemberProtocol(id)` is appended to every member prompt (`src/shared/experts.ts:413`); body at `:378`–`:386`: id/lead, save full result with `team_write` then reply ≤200 words (`:382`), `team_read`/`team_board`/`team_post` rules (`:383`), "Don't edit project files unless your brief says to." (`:384`).

**Team-specific lead prompts in resources** (these are the def bodies, `expert.md`)
- `resources/experts/software-delivery-team/expert.md:17` ("…you decide who does what and in what order"); `:19`–`:26` step-by-step delegation/sequencing; `:28`–`:33` deliverables.
- `resources/experts/deep-research-team/expert.md:17` ("You never do a member's specialist work yourself…"); member routing table `:19`–`:25`; workflows `:33`–`:45`.
- `resources/experts/product-launch-team/expert.md:17` ("…you decide which specialist does what").
- Codex adds a per-member step-budget sentence when `maxTurns` is set (`src/main/agents/codex.ts:114`–`:115`).
- No separate reusable "brief template" file found (searched `resources/experts/**` for `brief`/`delegate`) — the brief shape is only `TEAM_LEAD_PROTOCOL:369`.

Tests that pin current behaviour:
- `test/expert-catalog.test.ts` (`expertBlock` team section + `TEAM_LEAD_PROTOCOL` + Stay line, `:142`–`:152`; `teamAgents` appends `teamMemberProtocol`, `:160`–`:162`)
- `test/expert-skills.test.ts` (`:57`–`:140`, member protocol in subagent prompt)

## P6.3 Results + cost

**Results flow back**
- Team workspace dir = `<userData>/team-runs/<threadId>` (`src/main/index.ts:519`–`:520`); the four channel tools are built per thread from that dir and the member ids (`:523`–`:538`) and merged into the harness tool list for a design/team thread (`:542`–`:547`).
- Tools: `team_write` (`src/main/experts/team.ts:176`–`:191`), `team_read` (`:192`–`:207`), `team_post` (`:208`–`:230`), `team_board` (`:231`–`:264`). Files are `<name>.md` (`:105`–`:107`); write cap 60000 chars (`:48`, `:186`); read cap 20000 with truncation (`:49`, `:204`); notes in `notes.jsonl` + read cursors in `cursors.json` (`:115`–`:149`, `:224`–`:227`, `:243`–`:247`).
- Each accepted note is surfaced in the thread: `Team note · <from> → <to>: <text>` (`src/main/service.ts:296`–`:298`).
- The member's own report also returns as the `task` tool's result to the lead (`src/main/harness/subagent.ts:146`–`:148`), so results arrive both as the report and as workspace files.

**Usage / cost attribution**
- Native engine: the subagent's usage is folded into the turn via `onUsage` → `extraUsage` (`src/main/harness/driver.ts:352`–`:354`), then one turn-end reports `result.usage + extraUsage` (`:508`–`:510`). So member cost/tokens are **not itemized per member; they are summed into the turn total.**
- Child events are tagged with `parentId` (`src/main/harness/subagent.ts:131`); `ThreadEvent` has optional `parentId` (`src/shared/types.ts:609`, `:651`–`:652`).
- `rootTurnEnd()` exists because "a subagent's turn-end (parentId set) covers only the child" — it picks the last `turn-end` with no `parentId` (`src/shared/run-trace.ts:80`–`:87`). Note: the native `runLoop` emits no `turn-end` (only a max-steps notice, `src/main/harness/loop.ts:208`); the driver emits the single turn-end.
- `UsageMeter` sums every `turn-end` (no `parentId` filter) over the thread (`src/renderer/src/components/Meters.tsx:112`–`:142`).
- `turn-end` also feeds cache stats (`src/shared/cache-stats.ts:51`–`:58`), cost accounting (`src/main/db.ts:809`–`:820`), and handoff token totals (`src/main/handoff.ts:260`).

**What the team UI shows per member**
- `TeamStrip` shows only status: `active`/working, `aria-current`, and text "N working" / "Lead working" / "N members" (`src/renderer/src/components/experts/TeamStrip.tsx:46`–`:79`). **No per-member latency or cost.**
- `ExpertDetail` roster shows name, profession, description only (`src/renderer/src/components/experts/ExpertDetail.tsx:154`–`:162`). **No status/latency/cost.**
- Searched `src/**` for `latency|per-member|memberCost` — none found. The only per-member signal is the live "working" state in `TeamStrip`.

Tests that pin current behaviour:
- `test/expert-team-tools.test.ts` (all four tools: write/read round-trip, caps, ids, posting rules, board/cursors, truncation)
- `test/team-strip.test.tsx` (`activeMembers` transitions + `TeamStripView` status/lead lighting)
- `test/run-trace.test.ts` (`rootTurnEnd` takes the lead's turn-end, not a member's, `:41`–`:43`)
- `test/codex-subagent-render.test.tsx`, `test/subagent-card.test.tsx` (Agent/member row rendering)
- `test/acp.test.ts` (`:1030`, subagent call named Agent and task result unwrapped)

## Open questions
- Whether member-level cost/latency is planned but unbuilt is unverified (no roadmap doc was in scope; only the absence in code is established).
- For Claude/Codex/ACP engines, whether a child `turn-end` is actually persisted with `parentId` is unverified here (the native path emits none); `rootTurnEnd` and `run-trace.test.ts` assume such events exist.