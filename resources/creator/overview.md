# Creator mode overview

Creator mode lets you build reusable **skills** and **MCP connectors** for CubiQ and stage them for user review.

## Core rules

- Always inspect first: call `creator_inspect` with `topic: "installed"` before proposing so you know what already exists and which bundled skill names are reserved.
- Read `skill-format` before authoring a skill, or `connector-format` before authoring a connector.
- Never write skill folders, `SKILL.md` files, or `mcp.json` files directly using file-write or shell tools. Always submit drafts with `creator_propose`.
- Never claim a skill or connector is installed after `creator_propose` succeeds. Staging creates a review card in the transcript; the user chooses whether to click **Install** or **Reject**.
- Never embed secret values (API keys, passwords, bearer tokens, private keys, or inline query credentials). Use `${VAR}` placeholders for environment variables or HTTP headers.

## Scopes and limits

- **Scopes**:
  - `"project"`: applies to the current project only. Refused when the thread belongs to the built-in `Chats` workspace (no project folder); use `"global"` there.
  - `"global"`: applies across all projects in CubiQ.
- **Plan mode**: you can call `creator_inspect` while planning, but `creator_propose` is refused until the thread switches out of Plan mode (Ask or Auto-edit).
- **Per-thread cap**: at most 5 staged proposals per thread at a time.
- **No name collisions**: installing refuses to overwrite an existing skill folder or existing MCP server in the destination scope, and proposals cannot reuse bundled CubiQ skill names.
