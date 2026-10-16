---
name: design-doc
description: Turns a requirement into a short design note with options, trade-offs, interfaces, failure modes and a rollout plan; use before implementation starts.
---

# Design Doc

Work through the steps in order; each step produces one section of the note. Stop at the note — implementation starts only after the lead approves it.

## Step 1 — Restate the requirement and its constraints
1. Write the request as observable behavior: what the system does, for whom, and what counts as success.
2. List the constraints that bound the solution: performance targets, compatibility, existing patterns, environment, deadlines.
3. Separate what was given from what you assumed; mark each assumption so the lead can confirm it.
4. If two readings of the requirement would lead to different designs, ask the lead once before choosing.

## Step 2 — Read the ground
5. Open the modules, interfaces and data shapes the change will touch, and cite the files the design builds on.
6. Note the conventions the codebase already has — naming, error handling, config, persistence — so the design extends them instead of replacing them.
7. Name the boundaries that must not move: public interfaces, schemas, contracts other teams depend on.

## Step 3 — Weigh two or three options
8. Describe each option in terms of components, responsibilities and data flow, one short paragraph each.
9. Score each option on complexity, risk, performance and reversibility. When an option touches coupling, data migration, compatibility, security, observability or cost, work through the questions in [references/tradeoff-checklist.md](references/tradeoff-checklist.md); read that file only when one of those is live.
10. Reject the weaker options explicitly, with the reason, so the choice is not silently reopened later.

## Step 4 — Choose and justify
11. Pick one option and say why it wins against the stated constraints, not in the abstract.
12. Record what the choice gives up: the cost, the slower path, the migration it defers.

## Step 5 — Define the contract
13. Specify the interfaces the rest of the team codes against: signatures, input types, output types, error cases.
14. Specify the data shapes: fields, types, nullability, and where each one is stored or transported.
15. Make it exact enough to implement without questions; anything still unclear is an open question, not a detail.

## Step 6 — Failure modes and rollout
16. List the failure modes — bad input, partial failure, retries, timeouts, concurrency — and what the design does in each.
17. State the rollout: direct or behind a flag, migration order if data changes, and the rollback path with its trigger.
18. Name the signals to watch after release: logs, metrics, alerts.

## Step 7 — Open questions
19. List every unresolved decision with the options, the owner and what would settle it. Do not bury an open question inside an assumption.

## Output
- Save the complete design note (context, options and trade-offs, chosen approach, interfaces and data shapes, failure modes, rollout and rollback, open questions) with the `team_write` tool under the name `<your-id>-design` (for example `architect-design`).
- Reply to the lead with at most 200 words plus that file name and any open questions.
