# Design critique rubric

Score each area 1–5: 5 = nothing to fix, 4 = polish only, 3 = noticeable issues, 2 = several major issues, 1 = broken.

## Hierarchy
- One clear focal point per view; the primary action is the most prominent control.
- Headings step down in size and weight; no two competing heroes.
- Related things are grouped; unrelated things are separated by space.
- The eye path (top-left → primary content → action) makes sense.

## 8pt spacing and rhythm
- Margins, padding, gaps, widths and heights come from 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96 (4 only for type and icon nudges).
- Spacing inside a group is smaller than between groups (proximity).
- Line heights sit on a 4px baseline; vertical rhythm is consistent.
- Look for: 5, 10, 15, 18, 20, 30, 36px values; uneven card padding; inconsistent gaps in a list.

## Contrast and color
- Body text ≥ 4.5:1, large text (24px+, or 19px+ bold) and UI component edges ≥ 3:1.
- Muted text on tinted surfaces at small sizes is the usual failure; check it.
- Color is never the only signal (status has an icon or label; links are underlined or clearly styled).
- One primary hue for action; status colors only for status.

## Token adherence
- Colors, fonts, sizes, radii and shadows come from `system/tokens.css` (`var(--…)`), not raw values.
- Components follow `system/DESIGN.md` (button heights, radii, card style, elevation rules).

## Alignment and layout
- Edges line up on a grid; text left-aligned except short centered lines.
- Consistent max width and gutters; no element touching the viewport edge on mobile.
- Works at 390, 768 and 1440 without horizontal scroll or overlapping.

## States
- Hover, focus-visible, active, disabled for every control.
- Empty, loading and error for every data region.
- Form validation messages next to the field, not only at the top.

## Accessibility
- Targets ≥ 44×44 (48 on Android-style designs).
- Semantic elements (`button`, `a`, `label`, headings in order, landmarks); images have alt text; icon buttons have `aria-label`.
- Visible focus ring; keyboard reaches everything; reduced motion respected.

## Copy
- Specific, plausible content (no lorem ipsum, no "Feature 1").
- Buttons say what happens ("Start free trial", not "Submit"); sentence case; consistent terms.
- Error messages say what went wrong and how to fix it.
