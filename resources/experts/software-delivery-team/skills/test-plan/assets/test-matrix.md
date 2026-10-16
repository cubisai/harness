# Test Matrix

One row per case. Keep IDs stable so the defects list and the reply can cite them.

| ID | Area | Case | Type | Steps | Expected | Result |
|----|------|------|------|-------|----------|--------|
| T01 | <module or feature> | <happy path> | unit | <numbered steps> | <observable outcome> | <pass / fail / not run — evidence> |
| T02 | <area> | <boundary> | integration | <numbered steps> | <observable outcome> | <result — command or observation> |
| T03 | <area> | <invalid input> | unit | <numbered steps> | <clean rejection and message> | <result — evidence> |
| T04 | <area> | <failure or timeout> | integration | <numbered steps> | <defined failure behavior> | <result — evidence> |
| T05 | <area> | <regression> | unit | <numbered steps> | <unchanged existing behavior> | <result — evidence> |

## Rules
- Type: `unit`, `integration` or `manual` — one per row.
- Steps: the exact actions and input, short enough to repeat.
- Expected: observable outcome, written before the run.
- Result: `pass`, `fail` or `not run`, plus the command or observation that backs it. Unrun rows state why and the risk carried.
- Failures get a defect entry with reproduction steps; reference the row ID (for example T03).
