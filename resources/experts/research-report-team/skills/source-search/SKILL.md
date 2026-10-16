---
name: source-search
description: Turns a research question into 3–6 sub-questions and search queries, gathers primary sources, and records each with its exact quote; use when a brief needs sourced evidence before drafting.
---

# Source Search

## When to use
Use before any drafting or analysis starts, once the lead hands over a brief with the question and scope. Do not use for interpreting evidence or writing prose; those belong to the analyst and the editor.

## Step 1 — Split the question
1. Restate the question and the scope in one line.
2. Write 3–6 sub-questions that together cover the whole question. Make each answerable by a document, figure or dataset, not by opinion.
3. Under each sub-question, write one or two search queries: key terms, synonyms, date ranges, and the institutions or publishers most likely to hold the data.
4. If the brief leaves the scope ambiguous, ask the lead once before searching instead of second-guessing.

## Step 2 — Search, preferring primary sources
5. Run the queries and collect candidate sources.
6. Prefer primary sources: official statistics, regulations and filings, raw datasets, company and agency reports, full-text studies, official transcripts.
7. Treat secondary coverage as a pointer to its primary source; cite the primary whenever it is reachable.
8. When a series is revised, record the latest revision, and note beside each citation which period the figure covers.
9. When a source's quality is unclear or contested, read [references/source-quality.md](references/source-quality.md) and place it in a tier before using it. Read that file only when a ranking is needed.

## Step 3 — Record every source
10. Log each source in the evidence list exactly in this form:
    `[n] Title — Publisher — Date — URL`
11. Directly under the line, paste the exact supporting quote or figure, verbatim, plus where it sits (page, section, table). A paraphrase does not go here; only the source's own text does.
12. Label every item either `known (sourced)` or `assumed`. An assumption is plausible but unrecorded; it cannot support a conclusion on its own.
13. Add one line per sub-question noting where sources agree and where they conflict.

## Step 4 — Gaps and stopping
14. Keep a gaps list: every sub-question the queries could not answer, and why (paywalled, never published, contradictory records).
15. Stop only when each sub-question has at least 2 independent sources, or is marked a gap. Independent means different authors, organizations or datasets — not outlets reprinting one release.
16. Before you mark a gap, try one alternative query: different wording, different region, or the authors who disagreed.

## Handoff
17. Deliver to the lead: the evidence list with quotes, the known/assumed split per sub-question, and the gaps list, so the analyst works from sourced items only.

## Do not
- Do not close a sub-question on one independent source; write "1 source, needs 2" and keep digging.
- Do not let assumed items drift into the sourced list; the label is the firewall.
- Do not fill a gap with plausibility; name the gap and hand it back.
- Do not range outside the lead's scope; a tempting tangent goes in the gaps list as out-of-scope.

## Output
- Write the full result (sub-question plan, evidence list with quotes, known/assumed split, gaps) to a Markdown file in the team workspace or the project, at the path given in the brief from the lead.
- Reply to the lead with at most 200 words plus that file path and any open questions.
