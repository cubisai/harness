---
name: test-plan
description: Derives test cases from the requirement and the diff, runs what can be run, and reports actual results with untested areas named; use before a change is declared done.
---

# Test Plan

## Step 1 — Establish the expected behavior
1. Read the requirement and the design, then list every behavior that must hold as one checkable sentence.
2. Read the diff to see what actually changed; the plan covers both, and the diff shows where the risk sits.
3. Note the environment: which test commands exist, which services and fixtures are available, and what cannot be reached from here.

## Step 2 — Derive cases from the requirement and the diff
4. Happy path: the main flow with valid input, plus the variations the requirement names.
5. Boundaries: empty, zero, one, maximum, just over maximum, empty collection, single item, duplicates.
6. Invalid input: wrong type, missing field, malformed text, out-of-range value — expect clean rejection, not a crash.
7. Failure and timing: timeout, upstream error, partial failure, retry, cancellation mid-flight, slow dependency.
8. Regression: existing behavior that must not change, taken from the modules the diff touches.
9. For every case, write the steps, the exact input and the expected result before running anything.

## Step 3 — Mark type and priority
10. Label each case unit, integration or manual; a case that needs a live environment or a human judgment is manual.
11. Rank by risk: the cases most likely to break, and the ones that would hurt most if they did, run first.

## Step 4 — Run and record
12. Run what can be run here, and record the exact command, input and observed result for each case.
13. Mark each case pass, fail or not run; never record a result you did not observe, and give unrun cases a reason.
14. For every failure, write minimal reproduction steps and the expected-versus-actual difference.

## Step 5 — Report coverage honestly
15. Use the matrix format in [assets/test-matrix.md](assets/test-matrix.md) for the case table; read that file only when you assemble the report.
16. Summarize what passed, what failed, and what was not tested, with the risk each gap carries.
17. Do not claim coverage you do not have; name the gaps instead of implying completeness.

## Do not
- Do not write expected results after the run; fix them before it starts.
- Do not pad the matrix with rows that cannot fail.
- Do not merge several cases into one row; each row stays checkable on its own.
- Do not mark a case pass without the command or observation that shows it.
- Do not derive cases from the code alone; the requirement decides what correct means.

## Output
- Save the full test plan and run results (case table, commands, actual results, defects, untested areas) with the `team_write` tool under the name `<your-id>-test-plan` (for example `tester-test-plan`).
- Reply to the lead with at most 200 words plus that file name and any open questions.
