---
name: pr
description: Write a clean PR (or GitLab MR) title and body — summary sketch, evidence, risk — link it to its issue with Closes #n, and open or update it through the host's CLI. "$pr", "$pr 12" (link #12), "$pr update".
argument-hint: "[issue number | update]"
disable-model-invocation: true
---

# Pull request

Read `.cubiq/issue-tracker.md` for the host's commands (it says how to open, find and edit a PR, and how linking works). Label names are in `.cubiq/issues.json`.

If those files are missing, PRs still work:

- find the host from `git remote -v`: `gh` for GitHub, `glab` for GitLab, `tea` for Gitea;
- skip the issue lookup;
- ask the user for an issue number, if there is one.

Follow `../issue/STYLE.md` for the title and labels.

## 1. Gather

- Look at the branch with `git status`, `git branch --show-current`, `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`. Read the real diff before describing it; the commit messages aren't enough.
- **Base branch.** Use what the user says. Otherwise use the branch this one was cut from, or the default branch. If it's unclear, ask.
- **Existing PR.** Check with the tracker file's **Find this branch's PR**. If there is one, or the argument is `update`, you're editing it, not creating a new one.
- **Linked issue(s).** The first match wins:
  1. the argument (`$pr 12`);
  2. a `Working on #<n>` line in the message, which CubiQ adds for the thread's issue;
  3. an issue picked earlier in this conversation with `$issue`;
  4. a number in the branch name (`12-…`, `issue-12`, `…/12-…`) or in commit messages (`#12`);
  5. otherwise, ask: "Which issue does this close? (none is fine)".

  Read each linked issue, with comments, and check that the diff meets its acceptance criteria. If it covers only some of them, link it as partial work and say which criteria are left.
- **Checks.** Run the project's own checks yourself and keep the real results. Look for them in `package.json` scripts, a `Makefile`, the CI workflow, and `AGENTS.md` / `CLAUDE.md`. If anything fails, don't open the PR without saying so in the body.

## 2. Title and labels

- **Title**: imperative, sentence case, at most ~70 characters, no `feat:`/`fix:` prefix and no issue number, as `STYLE.md` describes. With one linked issue, reuse its title if it still describes the change.
- **Label**: the type label of the linked issue (`bug`, `enhancement` or `documentation`). With no issue, pick the one that fits. PRs get no state labels.

## 3. Body

Write the body to a file in the OS temp folder. Keep the prose brief: a reviewer should get the point from the Summary sketch and the Evidence lines alone.

```markdown
Closes #12

## Summary

One to three sentences: what changes for the user, and why.

<one sketch, only if it helps (see below)>

## Evidence

- **Before:** <failing test / old output / screenshot>
- **After:** <passing test / new output / screenshot>
- **Checks:** typecheck ✓ · tests ✓ (N passed) · lint ✓

## Risk

**Door:** two-way: reverting this PR is clean. <or: one-way, and why: migration, data format, settings schema, deletion>
**Blast radius:** <one phrase, e.g. "composer only", "every thread start", "Windows packaging">
<optional: what could break and how to spot it>
```

- **Link lines** go first, one per issue, in the form the tracker file gives: `Closes #n`, `Fixes #n` for a bug, or the partial form. If the base isn't the default branch, the host won't close the issue on merge, so tell the user to close it by hand afterwards.
- **Sketch**: pick the smallest view that makes the change obvious, and use two at most:
  - a `diff`-style tree for a component or file-layout change:

    ```diff
     <Composer>
       <ChipRow>
    +    <IssueChip />
    ```

  - a call tree for control flow: `startThread → resolveAgent → spawn`;
  - pseudocode for an algorithm or a state change;
  - a Mermaid `sequenceDiagram` when several processes talk to each other.
- **Evidence**: screenshots are the best evidence for UI. The CLIs can't upload images, so give the user the screenshot paths and ask them to drag the images into the PR once it exists. For logic, quote the exact test that failed before and passes now.
- Leave out empty sections, file-by-file change lists, and anything the diff already says.

## 4. Confirm, then publish

Show the user the title, labels, base branch and the body, exactly as they will appear. Once they say yes:

1. Push the branch if it isn't on the remote yet: `git push -u origin HEAD`. Never force-push, and never push straight to the base or default branch unless asked.
2. Create the PR, or update the existing one, with the tracker file's commands.
3. Delete the temp body file. Reply with the PR URL and the linked issue(s), one line each.
