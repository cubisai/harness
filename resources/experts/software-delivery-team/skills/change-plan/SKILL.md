---
name: change-plan
description: Turns an approved design into an ordered, minimal implementation plan, then executes it and reports exactly what changed; use when code must be written against a design.
---

# Change Plan

## When to use
Use once the architect's design is available and before any file is edited. The design is the contract; if it is missing or ambiguous, stop and ask the lead instead of inventing one.

## Step 1 — Read before writing
1. Read the design end to end, then the files it names and their neighbors.
2. Capture the local conventions: naming, imports, error handling, logging, comment density, test layout.
3. Check which tools exist (build, linter, typecheck, tests) so the plan can use them for proof.

## Step 2 — Write the plan
4. List every file to change, one line each: what is added, removed or replaced, exactly.
5. Order the steps so the build stays green after each one: the smallest enabling change first, callers updated in the same step as the interface they use.
6. Keep the diff minimal: no drive-by refactors, no reformatting untouched code, no new dependencies unless the design calls for them.
7. List the tests to add or extend, each with the case it covers, and note any check that cannot run in this environment.

## Step 3 — Implement in order
8. Work one step at a time; after each, run the cheapest check that proves the change still holds.
9. Handle the edge cases the design names and the obvious ones it does not; when you find one the design missed, note it rather than quietly deciding.
10. Match the surrounding style; if a file's existing pattern conflicts with the design, follow the file and report the conflict.
11. Do not expand scope to make something work; if the design is wrong, stop and report instead of guessing.

## Step 4 — Verify your own change
12. Run the project's checks for the files you touched: build, lint, typecheck, tests — whatever exists.
13. Fix what fails, or report it as a known-failing item with the reason; never call a step done while a check you ran is failing.

## Step 5 — Report
14. List what changed per file, one line each, with the reason for the change.
15. List what is left undone, what deviated from the design and why, and any check you could not run.

## Do not
- Do not start editing before the plan lists every file and the exact change per file.
- Do not order steps so an intermediate state breaks the build; reorder until each step is green on its own.
- Do not add dependencies, renames or refactors the design did not ask for.
- Do not report a check as passing without having run it in this session; say what could not run and why.

## Output
- Save the plan and the final report (file list, ordered steps, tests added, deviations, undone items) with the `team_write` tool under the name `<your-id>-change-plan` (for example `implementer-change-plan`).
- Reply to the lead with at most 200 words plus that file name and any open questions.
