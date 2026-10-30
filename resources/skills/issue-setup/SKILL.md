---
name: issue-setup
description: Set up where this project's issues live (GitHub, GitLab or Gitea through their CLI, or local markdown files), create the type and state labels, and optionally add issue and PR templates. Run once before /issue, /triage and /pr; run again to switch.
disable-model-invocation: true
---

# Issue tracker setup

Writes `.cubiq/issues.json` (read by CubiQ's `/issue` picker) and `.cubiq/issue-tracker.md` (read by the `issue`, `triage` and `pr` skills). Explore, show what you found, ask, then write. Never create local issue files unless the user picks **Local**.

**Answers from the `/issue-setup` command.** CubiQ asks the choices in its own card before you run, so the message may already hold them:

```
Tracker: GitHub | GitLab | Gitea | Local
Labels: Defaults | My own names
Templates: Add them | No templates
The origin remote is <url>.
```

Those lines are the user's answers and their go-ahead. Explore (step 1) for the tracker they picked, skip the questions in steps 2–4 (except the label names, when they picked **My own names**), then write (step 5) without asking again, and finish with the report in step 6, listing what you wrote and created. Stop only for what they can't have answered: a CLI that's missing or signed out, or a repo with issues turned off.

Without those lines, ask steps 2–4 yourself. Use your multiple-choice question tool if you have one (the user picks in a card), otherwise ask in one short message.

## 1. Explore

- Which host does `origin` point at? The `/issue-setup` command puts the URL in the message ("The origin remote is …"); otherwise run `git remote -v`.
  - `github.com` → **GitHub**
  - `gitlab.com`, or a host whose URL or name says gitlab → **GitLab**
  - a host whose URL or name says gitea, or that answers `/api/v1/version` → **Gitea**
  - unclear: ask which of the three it is.
- Is the host's CLI installed and signed in?
  - GitHub: `gh auth status`
  - GitLab: `glab auth status`
  - Gitea: `tea login list`; `tea api` needs tea 0.10 or newer.
- Can it see the repo, and are issues enabled?
  - GitHub: `gh repo view --json nameWithOwner,hasIssuesEnabled`
  - GitLab: `glab repo view`
  - Gitea: `tea api repos/{owner}/{repo}`
- Which labels exist already?
  - GitHub: `gh label list --limit 100`
  - GitLab: `glab label list`
  - Gitea: `tea labels list`
- Does `.cubiq/issues.json` exist already? If it does, show the current choice and ask: keep it, switch, or just refresh the labels.

These CLIs need the network. If one says the token is invalid or it can't connect while you run in a sandbox, run it again with escalated permissions (outside the sandbox) before you tell the user to sign in.

## 2. Ask: where do issues live?

Two choices. Lead with the recommendation so the user can accept it in one word:

- **Git host** (recommended when there's a remote): issues and PRs live on the host you detected (GitHub, GitLab or Gitea), handled through its CLI.
- **Local**: one markdown file per issue in a folder in this repo. The default is `docs/issues/`, committed so it travels with the repo. PRs still go to the git host if there is one.

If the user picks Git host and the CLI is missing or signed out, stop and tell them exactly what to run:

- GitHub: `gh auth login`
- GitLab: `glab auth login`
- Gitea: `tea login add`

Don't fall back to Local on your own.

## 3. Ask: label names

> Keep the default labels? (recommended: **yes**)

The defaults are listed in `../issue/STYLE.md` § Labels:

- type: `bug`, `enhancement`, `documentation`
- state: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`

Only if the answer is **no**, collect their name for each role, so the skills reuse existing labels instead of creating duplicates. If the host already has an obvious equivalent (GitLab's `feature` for `enhancement`, say), propose it.

## 4. Ask: templates (Git host only)

> Add issue and PR templates to the repo, so people filing from the web get the same structure? (recommended: **yes**, unless the repo already has them)

The files come from this skill's `assets/` folder:

| Host | Copy | To |
|---|---|---|
| GitHub | `assets/github/pull_request_template.md`, `assets/github/ISSUE_TEMPLATE/*` | `.github/` |
| Gitea | the same files | `.gitea/` |
| GitLab | `assets/gitlab/issue_templates/*`, `assets/gitlab/merge_request_templates/*` | `.gitlab/` |

Skip any file that already exists, and say which ones you skipped. If the user renamed a label in step 3, update the `labels:` lines in the issue forms to match.

## 5. Show the draft, then write

Show the user everything you're about to write or create:

1. `.cubiq/issues.json`, using this shape (use only the keys that apply):

   ```json
   {
     "tracker": "github",
     "repo": "owner/name",
     "folder": "docs/issues",
     "labels": {
       "bug": "bug", "enhancement": "enhancement", "documentation": "documentation",
       "needs-triage": "needs-triage", "needs-info": "needs-info",
       "ready-for-agent": "ready-for-agent", "ready-for-human": "ready-for-human", "wontfix": "wontfix"
     }
   }
   ```

   - `tracker` is `github`, `gitlab`, `gitea` or `local`.
   - `repo` is the host's path for the repo (`group/sub/name` on GitLab). Set it for a git host; leave it out for Local.
   - `folder` is for Local only.
2. `.cubiq/issue-tracker.md`: a copy of `trackers/<tracker>.md` from this skill's folder, with the repo, folder and label names filled in.
3. The labels you'll create: only the ones the host is missing.
4. The template files you'll add, if any.

When the user says yes:

- Write both `.cubiq/` files.
- Create each missing label. Leave existing labels alone: don't recolour, rename or delete them unless asked. Colours and descriptions:

  | Label | Colour | Description |
  |---|---|---|
  | `needs-triage` | `#fbca04` | New; not evaluated yet |
  | `needs-info` | `#d876e3` | Waiting on an answer before it can move |
  | `ready-for-agent` | `#0e8a16` | Fully specified; an agent can pick it up |
  | `ready-for-human` | `#1d76db` | Needs a person to decide, design or test |
  | `bug`, `enhancement`, `documentation`, `wontfix` | the host's usual | create only if missing |

  The commands are in the tracker file, under **Create a label**.
- **Local**: create the folder, with a `README.md` of one line that points at `.cubiq/issue-tracker.md`.
- Copy the templates the user agreed to.

## 6. Done

Report in two or three lines:

- which tracker is active;
- which labels and templates were added;
- that the files under `.cubiq/` can be edited by hand.

Then mention `/issue` in the composer: it picks the issue a thread works on, and `/issue <description>` files a new one.
