---
name: triage
description: Move this project's issues through needs-triage → needs-info / ready-for-agent / ready-for-human / wontfix. Shows what needs attention, checks claims against the code, and writes agent-ready briefs. "$triage", "$triage 12", "$triage move 12 to ready-for-agent".
argument-hint: "[number | instruction]"
disable-model-invocation: true
---

# Triage

Read `.cubiq/issue-tracker.md` first, for the tracker and its commands; label names are in `.cubiq/issues.json`. If either file is missing, tell the user to run `$issue-setup` and stop. Follow `../issue/STYLE.md` for every title, label and comment.

## States

```text
(unlabelled) → needs-triage ─┬→ ready-for-agent
                             ├→ ready-for-human
                             ├→ needs-info ──(answer arrives)──→ needs-triage
                             └→ wontfix (closed)
```

A triaged issue has exactly one type label and one state label. If an issue has two state labels, or no type, point it out and fix it as part of the triage. Before applying an unusual jump (`wontfix` → `ready-for-agent`, say), flag it and ask.

## What the user can ask

- `$triage` shows what needs attention.
- `$triage 12` triages #12.
- `$triage move 12 to ready-for-agent` is a quick override.
- For free text ("what's ready for agents?", "close 9 as a duplicate of 4"), work out what's meant and do it.

## Show what needs attention

List open issues in three buckets, oldest first, with a count for each:

1. **Unlabelled**: never triaged.
2. **needs-triage**.
3. **needs-info with a new reply**: a comment from someone other than the triager, posted after the last triage notes.

Give one line per issue, `#n  title  type · age · N comments`, then ask which one to take.

## Triage one issue

1. **Read everything**: the body, every comment, labels, author and dates. Find any earlier triage notes so you don't re-ask what's been answered.
2. **Check the code.**
   - *Already done?* Search for the behaviour by concept, not by the issue's wording, and say where you looked.
   - *Is the bug real?* Trace the code path from the reported steps, and run the relevant test or a quick repro when that's cheap. Say whether you reproduced it or only read the code.
3. **Recommend** the type and state you'd apply, with two or three lines of reasoning and what you found in the code. Wait for the user's call.
4. **Sharpen it if needed.** If the issue is close to ready but vague, ask the questions that would make it agent-ready, one round at a time, and fold the answers into the brief.
5. **Apply** the outcome once the user agrees:

| Outcome | Action |
|---|---|
| `ready-for-agent` | Post an **agent brief** comment (below), and set the labels |
| `ready-for-human` | Post the same brief, plus one line on why a person is needed |
| `needs-info` | Post **triage notes** (below), and set the labels |
| `wontfix`, already built | Comment where it already lives, then close as not planned |
| `wontfix`, duplicate | Comment `Duplicate of #n`, then close as not planned |
| `wontfix`, rejected | Comment the reason in two or three plain sentences, then close as not planned |
| stays `needs-triage` | Set the label; comment only if there's partial progress worth keeping |

## Quick override

When the user names the target state, trust it. Say what you'll do (labels, comment, close), then do it, without the investigation. If the move is to `ready-for-agent` and the issue has no brief yet, offer to write one.

## Agent brief (comment)

Written so an agent with no context can do the work. Describe behaviour and domain concepts, not file paths or line numbers.

```markdown
## Agent brief

**Goal:** one sentence.

**Now:** current behaviour (for a bug: what happens and how to trigger it).

**Done when:**
- [ ] observable criterion
- [ ] tests cover …

**Where to look:** the feature area or modules by name, and any prior art to copy.

**Out of scope:** what not to change.

**Checks:** the project's own typecheck / lint / test commands.
```

## Triage notes (needs-info comment)

```markdown
## Triage notes

**Established so far:**
- …

**Still needed from @<reporter>:**
- a specific, answerable question
- …
```

Make each question specific ("Does it happen in a new thread too, or only after a restart?"), never "please add more info".

## Coming back to an issue

If triage notes exist already, check which questions have been answered, summarise the updated picture, and carry on from there.
