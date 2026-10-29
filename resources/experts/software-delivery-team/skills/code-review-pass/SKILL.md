---
name: code-review-pass
description: Reviews a change against its design for correctness, security and maintainability, with severity-ranked findings and concrete fixes; use on a diff before it is merged.
---

# Code Review Pass

## Step 1 — Bound the review
1. Review the diff, not the whole repository; read the design or brief that states what the change is for.
2. Read the changed files first, then the surrounding code they interact with: callers, handlers, tests, configuration.
3. If the intent is unclear from the design and the diff, ask before judging; a question is not a finding.

## Step 2 — Correctness first
4. Check the logic against the design: does the code do what was specified on every path, including the paths that are hard to trigger?
5. Walk edge cases: empty, zero, one, maximum, negative, duplicate, missing fields, out-of-range values.
6. Walk error paths: invalid input, upstream failure, timeout, cancellation — are errors propagated correctly, or swallowed or mislabeled?
7. Check concurrency where it applies: shared state, ordering, retries, double execution, locks, deadlocks.
8. Check input validation: the trust boundary, length and encoding limits, and whether untrusted input reaches a sensitive sink.

## Step 3 — Security
9. Check the high-value classes first: injection, path traversal, broken authorization, secret exposure, unsafe deserialization, insecure defaults.
10. Check that the change does not widen an existing surface: new endpoints, new trust in input, looser validation, debug paths left reachable.

## Step 4 — Maintainability
11. Check readability and consistency with the codebase: naming, structure, error-handling style, comment density.
12. Do not raise anything a linter or formatter would catch; spend review attention on what machines cannot see.
13. Check that tests cover the changed behavior and its failure modes, not only the happy path.

## Step 5 — Write the findings
14. One row per finding: `file:line` — severity — what is wrong — why it matters — the concrete fix.
15. Severity is one of: `blocker` (must fix before merge), `should-fix` (fix now or record a reason to defer), `nit` (polish; never blocks).
16. Justify every finding by the behavior it causes; a preference is not a defect, and an empty findings list is a valid result.
17. For a category you have not checked on this diff, walk [references/review-checklist.md](references/review-checklist.md) once and record anything it surfaces; read that file only when you reach a category still unchecked.
18. Note what you did not check and why, and list any open questions where intent was unclear.

## Do not
- Do not expand the review beyond the diff; unrelated code belongs in its own pass.
- Do not invent findings to look thorough; a clean report is a valid result.
- Do not raise points a linter or formatter would already catch.
- Do not report a finding without the file and line where it lives.

## Output
- Save the full findings list, the summary of quality and coverage, and the open questions with the `team_write` tool under the name `<your-id>-review` (for example `reviewer-review`).
- Reply to the lead with at most 200 words plus that file name and any open questions.
