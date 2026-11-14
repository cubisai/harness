# Design critique rubric

The checks behind the five lenses in SKILL.md. Score each lens 0–10: 10 = nothing to fix, 8 = polish only, 6 = noticeable issues, 4 = several major issues, 2 = broken.

Which checks feed which lens: **Brief fit** = the request itself plus States; **Kit & tokens** = Kit grounding, 8pt spacing, Contrast and color (palette), Token adherence; **Accessibility** = Contrast (ratios), Accessibility; **Copy** = Copy, Actions; **Layout** = Hierarchy, Alignment and layout, UX laws.

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

## Kit grounding
- The page is composed from the kit's `data-ui` parts and its blocks; `design_lint`'s `Kit:` line gives the share.
- Only parts, props and values from `components.json` (`kit` findings are facts).
- A variant, prop or token is used where one exists; page CSS covers only what the kit lacks and never restyles a part through `[data-ui]`.

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

## Actions
- One filled button per group; the next is outlined, the rest are text. Three filled buttons in a dialog is a finding.
- Labels are a verb and its object; Submit, OK, Yes and Click here are findings.
- Every button has default, hover, pressed, disabled and loading; loading replaces the label with progress ("Placing order…") and blocks a second tap.
- A destructive confirm names the object and the consequence, with a red button that says the act; "Are you sure?" with OK/Cancel is a finding.
- Icon-only buttons only for universal icons (close, search, menu), each with an `aria-label`; anything that needs a tooltip needs a word.

## UX laws
- **Familiar patterns** (Jakob): controls work the way people expect from other products (sign-in, search, checkout, settings).
- **Chunking** (Miller): long numbers and lists are grouped; this is about readability, not a cap of seven menu items.
- **Ending** (peak-end): the last screen of a flow shows the outcome and the next step, warmly and plainly, not system status.
- **Polish** (aesthetic-usability): a calm, consistent screen reads as easier; loud colour and shouting copy read as broken.
- **Fewer steps** (Occam): every field and step earns its place; optional ones are deferred.
- **Recognition over recall**: selections, recent items and context stay visible instead of being remembered.
- **Speed**: no animation stands between the user and the task; feedback is 120–200ms, entrances 300–500ms, never on layout properties.
