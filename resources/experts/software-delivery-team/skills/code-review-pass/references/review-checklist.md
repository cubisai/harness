# Review Checklist

Walk the diff against each category once. Note any category that does not apply and why; do not pad the findings list to fill it.

## Correctness
- Boundary values: empty, zero, one, maximum, negative, overflow, single item, duplicates.
- Every condition has both outcomes reachable; no dead branch.
- Off-by-one and indexing; character count versus byte count.
- Missing values handled per the interface contract, not by accident.

## Errors and failure paths
- Every error is handled, propagated or deliberately ignored; none is swallowed.
- Messages name what failed and carry enough context to debug.
- Cleanup runs on the failure path: files, locks, transactions, subscriptions.
- Retries and timeouts are bounded; no unbounded loop or retry storm.

## Concurrency
- Shared state has one owner; reads and writes are ordered.
- Operations that can replay are idempotent.
- Locks are released on every path; no lock ordering that can deadlock.

## Security
- Untrusted input is validated at the boundary before use.
- No injection into queries, commands, paths or templates.
- Authorization is checked on every new entry point, not only in the UI.
- No secrets in code, logs or error messages.

## Data and compatibility
- Schema or format changes stay readable by still-running old code, or a migration covers them.
- Interfaces other modules or teams depend on keep their contract, or the break is declared.

## Tests
- New behavior has at least one test that would fail without the change.
- Failure modes, not just the happy path, are covered.

## Maintainability
- Names say what things are; structure follows the surrounding code.
- No dead code, commented-out blocks or debug statements.
- Anything a linter or formatter catches is out of scope here.
