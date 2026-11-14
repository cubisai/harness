# Issue tracker: GitHub

Issues and PRs for this project live on GitHub at `<owner/name>`. Use the `gh` CLI; inside the checkout it finds the repo from `git remote`. Label names come from `.cubiq/issues.json` → `labels`. Writing style lives in the `issue` skill's `STYLE.md`.

## Commands

- **List open**: `gh issue list --state open --limit 50 --json number,title,labels,comments,assignees,updatedAt,url`
- **Read one, with comments**: `gh issue view <n> --json number,title,state,body,labels,assignees,comments,url`
- **Search (duplicates)**: `gh issue list --state all --search "<keywords>" --json number,title,state,labels`
- **Create**: `gh issue create --title "<title>" --body-file <file> --label <type> --label <state>`
- **Comment**: `gh issue comment <n> --body-file <file>`
- **Relabel**: `gh issue edit <n> --add-label <new> --remove-label <old>`
- **Assign yourself**: `gh issue edit <n> --add-assignee @me`
- **Close**: comment with the reason first, then
  - done: `gh issue close <n> --reason completed`
  - `wontfix`: `gh issue close <n> --reason "not planned"`
- **Create a label**: `gh label create <name> --color <hex without #> --description "<text>"`
- **Open a PR**: `gh pr create --base <base> --title "<title>" --body-file <file> --label <type>`
- **Find this branch's PR**: `gh pr view --json number,title,body,url`
- **Edit a PR**: `gh pr edit <n> --title "<title>" --body-file <file>`

`#42` can be an issue or a PR, because they share numbers. Resolve it with `gh pr view 42`, and fall back to `gh issue view 42`.

## Linking a PR to its issue

Put one line per issue at the top of the PR body:

- `Closes #<n>` for an enhancement or docs issue;
- `Fixes #<n>` for a bug;
- `Part of #<n>` for partial work.

GitHub closes the issue automatically only when the PR merges into the default branch. For a PR into any other branch, the link still shows on the issue, but close the issue by hand after the merge.
