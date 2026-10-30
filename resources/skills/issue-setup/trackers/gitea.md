# Issue tracker: Gitea

Issues and PRs for this project live on Gitea at `<owner/name>`. Use the `tea` CLI (0.10 or newer, for `tea api`); inside the checkout it finds the login and repo from `git remote`. In `tea api` paths, `{owner}` and `{repo}` are filled in from the current repo. Label names come from `.cubiq/issues.json` → `labels`. Writing style lives in the `issue` skill's `STYLE.md`.

## Commands

- **List open**: `tea api "repos/{owner}/{repo}/issues?state=open&type=issues&limit=50"`. Each item has `number`, `title`, `labels[].name`, `comments` (a count), `assignees`, `updated_at` and `html_url`.
- **Read one**: `tea api repos/{owner}/{repo}/issues/<n>`
- **Read its comments**: `tea api repos/{owner}/{repo}/issues/<n>/comments`. Each comment has `body`, `user.login` and `created_at`.
- **Search (duplicates)**: `tea issues list --state all --keyword "<keywords>"`
- **Create**: `tea issues create --title "<title>" --description-file <file> --labels <type>,<state>`
- **Comment**: `tea comments add <n> --description "<text>"`
  - bash: `"$(cat <file>)"`
  - PowerShell: `(Get-Content -Raw <file>)`
- **Relabel**: `tea issues edit <n> --add-labels <new> --remove-labels <old>`
- **Assign yourself**: `tea issues edit <n> --add-assignees <your username>`. Get the username with `tea api user`, field `login`.
- **Close**: comment with the reason first, then `tea issues close <n>`. For a `wontfix`, add that label before closing.
- **Create a label**: `tea labels create --name <name> --color "#<hex>" --description "<text>"`
- **Open a PR**: `tea pulls create --base <base> --title "<title>" --description-file <file> --labels <type>`
- **Find this branch's PR**: `tea pulls list --state open`, then match on the head branch.
- **Edit a PR**: `tea pulls edit <n> --title "<title>" --description-file <file>`

`#42` can be an issue or a PR, because they share numbers. `tea api repos/{owner}/{repo}/issues/42` returns either one; a PR has a `pull_request` field.

## Linking a PR to its issue

Put one line per issue at the top of the PR body:

- `Closes #<n>` for an enhancement or docs issue;
- `Fixes #<n>` for a bug;
- `Part of #<n>` for partial work.

Gitea closes the issue automatically only when the PR merges into the default branch. For any other branch, close the issue by hand after the merge.
