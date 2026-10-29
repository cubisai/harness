---
name: report-structure
description: Assembles verified findings, citations and fact-check verdicts into a structured report draft with limits and a source list; use as the last step before delivery.
---

# Report Structure

## When to use
Use as the final step, once the analyst's findings and the fact-checker's log exist, to turn verified material into the finished report. Do not use for collecting sources or grading evidence; those are upstream steps.

## Step 1 — Load inputs only
1. Collect what the lead hands over: the analyst's findings and analysis, the fact-check log, the researcher's source list.
2. Drop every claim the log marks removed or unsupported; apply corrected wording exactly as the notes say, everywhere it appears, including the summary.
3. Introduce no facts of your own; if a section lacks its material, leave a marked placeholder and flag it to the lead.

## Step 2 — Assemble into the template
4. Read [assets/report-template.md](assets/report-template.md) first, every time; it fixes the section order and what each section holds.
5. Put the answer at the top: the TL;DR states the finding and its strength in at most 3 sentences, no setup and no history.
6. Write in one voice: one tense, one term per concept, and no leftover role-voice from the member drafts.
7. Keep the `[n]` citation on every factual sentence; a sentence without one is an assumption — cite it, cut it, or move it to Limits.
8. Build the Limits section from two inputs: the analyst's assumptions and open questions, plus the log's low-confidence and softened items.
9. Renumber the Sources list so every `[n]` in text matches an entry, each in the form `[n] Title — Publisher — Date — URL`.

## Step 3 — Final pass
Run the checks in order; anything that fails is fixed in place, and if you cut or move text, rerun the list:
- [ ] TL;DR answers the question asked, not a neighboring one.
- [ ] Every number matches its source: digits, unit, rounding, period.
- [ ] No factual sentence is left without a citation.
- [ ] Nothing marked removed survives in any section.
- [ ] Corrected wording replaces the old wording everywhere it appeared.
- [ ] The same term names the same thing across all sections.
- [ ] Each section delivers what its heading promises.
- [ ] The strength word for each claim is the same in TL;DR, Findings and Analysis.
- [ ] Limits states what the evidence cannot support, in plain sentences.

## Do not
- Do not fix style by adding claims; voice work moves inside the verified material.
- Do not merge source entries to shorten the list; one source, one entry.
- Do not carry member names into the report; the fact-check log speaks for them.
- Do not reorder or rename the template's sections; their order is the reader's contract.
- Do not ship placeholders without a flagged note naming exactly what is missing.
- Do not pad the report to feel complete; a short sourced report beats a long assumed one.
- Do not answer questions the lead never asked; out-of-scope material goes to Limits' open questions.

## Output
- Write the finished report (per the template) with the `team_write` tool (name `<your-id>-<step>`), or to the project path the brief names.
- Reply to the lead with at most 200 words plus that file name and any open questions.
