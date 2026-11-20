# Plugin bundles

An app may own commands, exact tool rules, skills, MCP connectors and scheduled prompts in optional `app.json.contributes`. Keep its normal HTML entry, placement, sandbox, grants, tools and cards. There is no second manifest or arbitrary host code. Read the relevant existing format docs first.

```json
{
  "commands": [{ "name": "review", "description": "Review the current work", "prompt": "Review the current work and report concrete findings. Do not modify files." }],
  "rules": [{ "action": "ask", "target": { "kind": "tool", "name": "creator_inspect" }, "reason": "Confirm each reference load" }],
  "skills": [{ "name": "review", "description": "Review the current work", "path": "skills/review" }]
}
```

- Limits: 16 commands, 32 rules, 8 skills, 8 connectors, 8 automations, 64 parts total. All files share the normal app file/byte budget. Reject unknown fields, duplicate identities and unsafe or overlapping skill paths.
- Optional `appTheme` is one light/dark chrome palette, counted as one part. Read `app-theme-format` / `app-theme-tokens`; use template `app-theme`. Install never applies it: user Preview/Apply/Revert is separate from plugin availability and from Design page themes.
- Commands contain bounded plain text, not substitutions or executable code. `/plugin-name.command-name` is qualified; built-ins are reserved. Picking/completing only prepares a command. Normal Send/Enter starts it. Off/Update/Uninstall and stale retries refuse old identities rather than substituting content.
- Skills need a local `SKILL.md` folder. Reuse `skill-format`, including frontmatter invocation flags. The reviewed snapshot is frozen. CubiQ creates collision-safe owned delivery copies, never edits installed files or user/agent skill folders. Off stops new host loads and delivery; already-loaded model context cannot be erased.
- Connectors use `{ "name": "shop", "spec": ... }` and the existing `connector-format` rules. Use placeholders only, never secrets. CubiQ generates the qualified runtime server name; inspect installed parts to find it. Credentials and HTTP/SSE/stdio execution stay in main. Install/Update/On neither connect nor sign in. External granted connectors are not owned parts.
- Rules target only exact CubiQ-managed tools (`kind: tool, name`) or exact connector calls (`kind: connector, server, tool`). No wildcards or native SDK aliases such as Bash/Run/Read/Edit, Glob/Grep, Skill, TodoWrite or ExitPlanMode. The native harness's `propose_plan` is already an explicit user decision, not a rule target. Managed `todowrite`, `glob`, `grep`, `web_fetch`, `task` and `ask_user` are gated where CubiQ supplies them; a provider's own similarly named native tool is not a managed descriptor. Ask wins over Allow and applies under Full access, remembered permissions and cached reads. Allow is only for a host-classified read; it cannot authorize writes/unknown effects, widen grants, bypass Plan/design guards or permit card mutations.
- Automations use `{ "name": "daily-review", "config": ... }` with `automation-format`. Explicitly choose `agent` and `model` (null means default). Only a real project Creator thread may bundle them; main fixes that project in the reviewed snapshot. A global plugin's schedules remain project-only. Install/Update save Off/Ask with no run; plugin On never enables schedules. Off cancels owned work; Update/Uninstall refuse active work and protected hand edits.
- One reviewed Install/Update/Off/Uninstall owns all parts. Updates review added/changed/removed parts and preserve app data and run history. Uninstall removes only owned files, configuration and credentials, keeping external granted connectors. Drafts, Preview and Check never activate contributions.

Use the `bundle` template for a small commands-and-skills starter. Staging is not installation; do not claim availability before the user reviews it. A build that says bundle delivery is unavailable remains fail closed—never bypass that message by installing parts separately.
