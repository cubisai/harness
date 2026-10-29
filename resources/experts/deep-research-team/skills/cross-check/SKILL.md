---
name: cross-check
description: Triangulates each claim across independent sources and grades a verdict and confidence; use before claims go into the team's answer.
---

# Cross-Check

## Step 1 — Extract
1. Number every checkable claim: a number, date, event, attribution or cause. Rephrase fragments so each can pass or fail. Leave opinions out and list them as "not checked".

## Step 2 — Triangulate
2. For each claim, find two independent sources, or one primary source stating it exactly. Sources quoting the same origin count as one.
3. Compare four things: wording (same meaning), number (value, unit, rounding, base year), date (which period), scope (which population, region, conditions).
4. Flag overstatement: a sweeping word carried by one study or a narrow sample gets the narrower wording the sources support.

## Step 3 — Grade
| Confidence | Rule |
|---|---|
| High | 3+ independent sources agree, or 1 primary source states it exactly |
| Medium | 2 independent sources agree |
| Low | 1 secondary source, or sources that depend on each other |
| Memory-only | No access to sources; well-established knowledge only (never above Medium) |

Verdicts: `verified` (as written), `corrected` (give the exact new wording), `unsupported` (no source found), `false` (sources contradict it).

## Output
- Table: `# | Claim | Sources | Verdict | Confidence | Note`, then the surviving claims in corrected wording.
- Save it with `team_write` (name `<your-id>-<step>`), then reply to the lead with at most 200 words: the counts per verdict, any false or corrected claims, and the file name.
