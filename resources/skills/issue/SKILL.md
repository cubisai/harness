---
name: issue
description: List this project's open issues (with their comments) and pick one to work on, or file a new bug, enhancement or docs issue. "/issue" lists, "/issue 12" opens #12, "/issue <description>" drafts a new one.
argument-hint: "[number | description of a new issue]"
disable-model-invocation: true
---

# Issue

Read `.cubiq/issue-tracker.md` first: it says where issues live and which commands to use. Label names are in `.cubiq/issues.json`. If either file is missing, stop and tell the user to run `/issue-setup`; don't fall back to local files on your own. Follow `STYLE.md` (next to this file) for every title, body, label and comment.

If the message says `Working on #<n>`, the thread already has an issue: **List** and **Open** start from it unless the user names another. It never changes the mode: a description, or a message that starts `New issue:` (the `/issue <description>` command), is always **New**.

Pick the mode from the argument:

| Argument | Mode |
|---|---|
| empty | **List**: show open issues and ask which to work on |
| a number, `#12` or an issue URL | **Open**: pull that issue and get ready to work on it |
| anything else | **New**: draft a new issue from the description |

## List

Fetch the open issues (tracker file, **List open**). Show them as a compact list, grouped by state in this order, oldest first within each group:

1. `ready-for-agent`
2. `ready-for-human`
3. `needs-triage`, and unlabelled issues
4. `needs-info`

```text
Ready for agent
  #4   Generate concise thread titles with a small model    enhancement · 2 comments
Needs triage
  #3   Add controls for running background threads          enhancement · no comments · @sam
```

Each row shows the type, the comment count and any assignee. Leave out `wontfix`. Then ask which one to work on, offering the three or four most workable first. If nothing is open, say so and offer **New**.

When the user picks one, continue with **Open**.

## Open

1. Pull the issue **with all its comments** (tracker file, **Read one** and **Read its comments**), and read every comment. Later comments often narrow the scope, answer questions or change the acceptance criteria. The maintainer's latest word beats the original body.
2. If CubiQ's `set_thread_issue` tool is available (sometimes with an MCP prefix, such as `mcp__cubiq__set_thread_issue`), call it with the issue's number, title, URL and labels, so the composer shows the issue chip.
3. Give the user a brief, no longer than this:

   ```text
   #3 Add controls for running background threads   enhancement · needs-triage
   Ask:    <one sentence, as it stands after the comments>
   Done when:
     - <acceptance criteria, merged with what the comments changed>
   From comments: <decisions or answers that changed the ask, or "none">
   Open questions: <anything still unanswered, or "none">
   ```

4. If the state is `needs-info`, or there are open questions, say what's blocking. Then ask whether to go ahead anyway, answer the questions now, or pick another issue.
5. Explore the code the issue touches and propose an approach. Follow the project's own workflow (its `AGENTS.md` / `CLAUDE.md`) for plans and approvals. If you create a branch, put the issue number in its name, e.g. `3-background-thread-controls`, so the `pr` skill can find the link later.
6. Offer once to assign the issue to the user. Don't change labels just because work has started.

## New

1. **Classify** the request as `bug`, `enhancement` or `documentation`. If it's genuinely unclear, ask in one question.
2. **Check for duplicates** (tracker file, **Search**), using the project's own words, not just the user's phrasing. If a likely duplicate exists, show it and ask: comment on that one instead, or file a new one anyway?
3. **Fill the gaps quickly.**
   - A bug needs steps to reproduce and the expected behaviour. If they're missing, ask for them in one message, or read the code and propose likely steps.
   - For an enhancement, write the acceptance criteria from what the user said, and mark anything you inferred so they can correct it.
4. **Draft** the title and body with the `STYLE.md` template for its type, and show them exactly as they will appear:

   ```text
   Title:  Thread list doesn't refresh after a merge
   Labels: bug · needs-triage

   ## What happens
   …
   ```

   The state is `needs-triage` by default. Suggest `ready-for-agent` only if the draft has clear acceptance criteria and no open questions, and ask before using it.
5. When the user says yes, create the issue: with CubiQ's `issue_create` tool when it's available (sometimes with a prefix, such as `cubiq_issue_create`), passing any screenshots or files the user gave as `attachments` and `link: true`; otherwise with the tracker file's **Create**. Print its number and URL, then ask whether to start on it now; if so, go to **Open**.
