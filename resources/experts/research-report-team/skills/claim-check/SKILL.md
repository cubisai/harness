---
name: claim-check
description: Extracts each checkable claim, opens the cited source to verify wording, numbers, dates and scope, and grades a verdict with confidence; use before a report is finalized.
---

# Claim Check

## When to use
Use when a findings list, analysis or draft is about to be published or merged into the final report. Check the claims themselves; the writing style is not your input.

## Step 1 — Extract the claims
1. Read the material once, then list every checkable claim as a numbered list.
2. A checkable claim names something verifiable: a number, a date, an event, an attribution, a causal statement. Rephrase fragments so each row can pass or fail.
3. Hold claims in draft order so the editor can trace each row back to its sentence.
4. Set opinions and recommendations aside; list them below the log as not checked.

## Step 2 — Verify against the source
5. For each claim, open the cited source at the cited place and re-read the passage; never trust a citation by its label.
6. Compare four things: wording (does the source say this meaning), number (digits, units, rounding, base year), date (which period it covers), scope (whose population, which region, which conditions).
7. For an uncited claim, write what source it would need; do not quietly substitute different support and call the wording verified.
8. Flag overstatement: a generalization ("most", "dramatically", "fastest") carried by a single study or a narrow sample gets corrected to what the source shows, or removed.

## Step 3 — Rate confidence
9. Grade each verdict with the scale in [references/confidence-scale.md](references/confidence-scale.md). Read that file only when a borderline case needs the rule and worked examples; the compressed rule is High = 3+ independent or one primary exact, Medium = 2, Low = one weak or dependent, Unsupported = none.

## Step 4 — Build the log
10. Output one row per claim in this table:

| # | Claim | Source | Verdict | Confidence | Note |
|---|-------|--------|---------|------------|------|

11. Verdicts: `verified` (the source says it as written), `corrected` (put the exact replacement wording in Note), `unsupported` (no checked source says it), `removed` (wrong or unfounded — it must not appear anywhere).
12. Every `corrected`, `unsupported` and `removed` row states its action in Note: replacement text, softening, or deletion, so the editor can work without re-reading sources.
13. Re-check your own corrections: revised wording is verified against the same source before the row is done.

## Handoff
14. Deliver the completed log and the surviving claims in corrected wording, so the report is written from verified statements only.

## Do not
- Do not pass a claim from memory or plausibility; verification happens at the source, line-level.
- Do not rescue overstated wording by finding a stronger source than the one cited; flag it to the lead instead.
- Do not grade by how confident the sentence sounds; grade by checked-source agreement.
- Do not merge rows to shrink the log; each claim keeps its own row.

## Output
- Write the full result (numbered claims, the completed log table, replacement wording, removals) to a Markdown file in the team workspace or the project, at the path given in the brief from the lead.
- Reply to the lead with at most 200 words plus that file path and any open questions.
