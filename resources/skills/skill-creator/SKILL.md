---
name: skill-creator
description: Write a new skill, or improve an existing one, in the Agent Skills format (a folder with SKILL.md) - for this project or for every project. Use when the user asks to make, save or teach a reusable workflow, checklist or procedure as a skill.
---

# Creating a skill

A skill is a folder whose name is the skill's name, holding `SKILL.md` and any files it points to.

## Where it goes

Ask which one if the user didn't say:
- **This project only**: `<project>/.agents/skills/<name>/`. Checked into the repo, so the team gets it; Codex, OpenCode and this harness read it.
- **Every project**: the harness's own skills folder, shown in the Library under Skills → Folders (the user can also use Library → Skills → New skill). Don't write into another tool's global folder (`~/.claude/skills`, `~/.codex`) unless the user asks for that tool specifically.

## SKILL.md

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when the user asks for release notes, a changelog entry, or "what changed since vX".
---

# Release notes

1. …
```

- `name`: lowercase letters, digits and hyphens, the same as the folder.
- `description`: the only part the agent sees before the skill loads, so it decides when the skill is used. Say what it does, then "Use when …" with the words a user would actually type. Keep it under about 300 characters.
- Optional: `disable-model-invocation: true` (only the user can start it, from the `/` menu), `argument-hint: "<version>"` (placeholder after `/name`).
- Body: numbered steps for the agent, in the imperative. Say what to check before calling the task done. Keep it short; move long reference material into a separate file in the folder (`reference.md`) and link it from the step that needs it, so it loads only then.
- Scripts the steps run go in the folder too (`scripts/…`), referenced by relative path.

## Before you finish

Read the new SKILL.md back, check that the description would match the requests it's meant for (and not unrelated ones), and tell the user where you saved it and how to start it (`/name`, or just describe the task).
