# Issue tracker: local markdown

Issues for this project live as markdown files in `<folder>/`, one file per issue. PRs still go to the git host if the repo has one. Label names come from `.cubiq/issues.json` → `labels`. Writing style lives in the `issue` skill's `STYLE.md`.

## File layout

Each issue is `<folder>/<NNNN>-<slug>.md`:

- `NNNN` is the next free number, zero-padded (`0001`, `0002`, …).
- The slug is the title in kebab-case, at most about six words.

```markdown
---
id: 7
title: Thread list doesn't refresh after a merge
type: bug
state: needs-triage
created: 2026-10-29
---

<body, using the STYLE.md template for its type>

## Comments

### 2026-10-29
<comment text>
```

- `type` is one of `bug`, `enhancement` or `documentation`.
- `state` is one of `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` or `closed`.

## Operations

- **List open**: read the frontmatter of every file whose `state` isn't `closed` or `wontfix`. The comment count is the number of `### ` headings under `## Comments`.
- **Read one**: read the whole file. Comments sit under `## Comments`, oldest first.
- **Search (duplicates)**: search titles and bodies in the folder for the keywords.
- **Create**: take the next free number and write the file with `state: needs-triage`.
- **Comment**: append a `### <date>` entry under `## Comments`.
- **Relabel**: change `type` or `state` in the frontmatter.
- **Close**: append a comment giving the reason, then set `state: closed` (done) or `state: wontfix` (not planned).

## Linking a PR to its issue

Local issues can't close themselves. Put `Resolves <folder>/<NNNN>-<slug>.md` on the first line of the PR body, and set that issue's `state: closed` in the same PR.
