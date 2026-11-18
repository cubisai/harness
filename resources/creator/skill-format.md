# Skill proposal format

Call `creator_propose` with `kind: "skill"` and these fields:

- `scope`: `"project"` or `"global"`
- `kind`: `"skill"`
- `name`: `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits, hyphens, max 64 chars; must not match a bundled CubiQ skill)
- `description`: 1–1000 non-empty characters explaining when agents should invoke this skill
- `files`: non-empty array of `{ path, content }` (1–32 files)

## File & size rules

- Must include `SKILL.md` at the root of `files`.
- Paths use forward slashes (`/`), no leading `/`, no `\`, no `..`, no control characters, and no hidden `.dotfiles` (for example `.env`, `.git/`).
- No executable scripts (`scripts/` directory or `.sh`, `.py`, `.js`, `.ts`, `.ps1`, `.bat`, `.exe` files) in v1.
- Allowed file extensions: `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`.
- Maximum size: 128 KiB per file, 1 MiB total across all files.

## `SKILL.md` frontmatter

`SKILL.md` must start with YAML frontmatter delimited by `---` containing matching `name` and non-empty `description`:

```markdown
---
name: api-changelog
description: Summarize REST and GraphQL API changes between commits into release notes.
---

# API Changelog

1. Inspect git diff or changed schema files provided by the user.
2. Group breaking changes, additions, and deprecations cleanly.
3. Call out migration steps for breaking changes.
```

Add extra `.md`/`.txt`/`.json`/`.yaml` reference files only when genuinely needed (for example `examples.md` or `checklist.md`).
