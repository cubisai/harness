# Issue tracker: GitLab

Issues and merge requests for this project live on GitLab at `<group/name>`. Use the `glab` CLI; inside the checkout it finds the project from `git remote`. Label names come from `.cubiq/issues.json` → `labels`. Writing style lives in the `issue` skill's `STYLE.md`.

GitLab says "merge request" (MR) where GitHub says PR. The `pr` skill means an MR here. Issue numbers are the project's IIDs (`#12`); MRs use `!12`.

## Commands

- **List open**: `glab issue list --per-page 50 --output json`. Each item has `iid`, `title`, `labels`, `user_notes_count`, `assignees`, `updated_at` and `web_url`.
- **Read one**: `glab issue view <n> --output json` for the body.
- **Read its comments**: `glab api "projects/:fullpath/issues/<n>/notes?sort=asc&per_page=100"`. Skip notes where `system` is true, since those are activity, not comments.
- **Search (duplicates)**: `glab issue list --all --search "<keywords>" --output json`
- **Create**: `glab issue create --title "<title>" --description-file <file> --label <type>,<state> --yes`
- **Comment**: `glab issue note <n> --message "<text>"`
  - bash: `--message "$(cat <file>)"`
  - PowerShell: `--message (Get-Content -Raw <file>)`
- **Relabel**: `glab issue update <n> --label <new> --unlabel <old>`
- **Assign yourself**: `glab issue update <n> --assignee +<your username>`. Get the username with `glab api user`, field `username`.
- **Close**: comment with the reason first, then `glab issue close <n>`. GitLab has no "not planned" reason, so add the `wontfix` label before closing.
- **Create a label**: `glab label create --name <name> --color "#<hex>" --description "<text>"`
- **Open an MR**: `glab mr create --target-branch <base> --title "<title>" --description-file <file> --label <type> --yes`
- **Find this branch's MR**: `glab mr view --output json`
- **Edit an MR**: `glab mr update <n> --title "<title>" --description "<text>"`, passing the file contents the same way as for a comment.

## Linking an MR to its issue

Put one line per issue at the top of the MR description:

- `Closes #<n>` for an enhancement or docs issue;
- `Fixes #<n>` for a bug;
- `Related to #<n>` for partial work.

GitLab closes the issue automatically only when the MR merges into the default branch. For any other target branch, close the issue by hand after the merge.
