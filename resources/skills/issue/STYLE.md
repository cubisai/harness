# Writing style for issues, PRs and labels

Shared by `issue`, `triage` and `pr`. The goal: someone skimming the issue list or a PR page understands each item in one read, with nothing to decode.

## Titles

- Sentence case, plain English, no trailing period, at most ~70 characters.
- No prefixes or tags in the title: no `feat:`, `fix:`, `[BUG]`, `WIP`, emoji or issue numbers. Labels carry the type.
- **Enhancement / PR**: imperative, starting with a verb: "Add controls for running background threads".
- **Bug**: the symptom the user sees, not the suspected cause: "Thread list doesn't refresh after a merge".
- **Docs**: "Document …" / "Explain …".
- Use the project's own words, the ones its UI and docs already use.

## Labels

Every issue carries exactly **one type** label and **one state** label, nothing else unless the user asks. These are roles; `.cubiq/issues.json` → `labels` maps each role to the real label name in this tracker.

| Kind | Role | Meaning |
|---|---|---|
| type | `bug` | Something that works, or should work, is broken |
| type | `enhancement` | A new feature or an improvement to an existing one |
| type | `documentation` | Docs only, no behaviour change |
| state | `needs-triage` | New; not evaluated yet |
| state | `needs-info` | Waiting on an answer before it can move |
| state | `ready-for-agent` | Fully specified; an agent can pick it up cold |
| state | `ready-for-human` | Needs a person: a judgment call, design decision, external access or manual testing |
| state | `wontfix` | Won't be done; closed with a reason |

A PR carries the type label of the issue it closes (or its own, if it has none) and no state label.

When you show labels to the user, write them plainly, like `enhancement · ready-for-agent`, never as raw JSON.

## Issue bodies

Keep every section short. Delete a section rather than fill it with "N/A".

**Enhancement**

```markdown
## Purpose
One or two sentences: who wants what, and why it matters.

## Acceptance criteria
- Observable behaviour 1
- Observable behaviour 2
- Tests cover …

## Notes
Constraints, links, open questions. (Optional.)
```

**Bug**

```markdown
## What happens
One or two sentences describing the symptom.

## Steps to reproduce
1. …
2. …

## Expected
What should have happened.

## Environment
OS, app version or commit, anything else that changes the outcome.

## Notes
Logs, screenshots, suspected area. (Optional.)
```

**Documentation**

```markdown
## What's missing or wrong
…

## Where
The doc or page it belongs in.
```

Acceptance criteria describe behaviour a user or a test can observe. Leave out file paths and line numbers, since they go stale. The exception is a pointer that is the whole point of the issue.

## Comments

- Lead with the outcome in one line, then the detail.
- Use headings only when the comment has more than one part (triage notes, agent brief).
- When replying to one point, quote it.
- No filler ("Great question!", "Hope this helps"), and don't restate the whole issue.

## Writing to the tracker

Write each body to a file in the OS temp folder (`$TMPDIR` or `/tmp` on macOS and Linux, `$env:TEMP` on Windows), pass it by file where the CLI allows it, and delete it afterwards. Never write drafts into the project.

Creating, editing, labelling, commenting on or closing an issue or PR is visible to other people. Show the user the draft and get a yes before the first write of a session. After that, a direct instruction ("move #4 to ready-for-agent") counts as the yes.
