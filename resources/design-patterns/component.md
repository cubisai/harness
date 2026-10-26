# Component patterns (one card, modal, badge, form control, widget)

## Composition
- Present the component on a quiet canvas (surface colour, 64–96px padding), at its real size, with 2–4 **states side by side** (default, hover, focus, disabled/error/loading as fits), each captioned in small text.
- A card holds one title, one supporting line, one action; the whole card is the link if it navigates. Separate it with exactly one of: a 1px border, a tint, or a soft shadow.
- Padding equal on four sides, ≥ 16px; nested radius = outer radius − padding.

## Type
Three sizes: title 16–20px, body 14–16px, meta 12–13px. Numbers tabular. Badges ≤ 3 words, sentence case, meaning in the text, colour as a second signal.

## Anatomies
- **Pricing card**: plan name, who it's for, price with unit, one button, a divider, 4–6 features with checks; the featured one gets a stronger border and the filled button.
- **Modal**: title stating the decision, one paragraph of consequence, the destructive or main action on the right, Cancel as a quiet button, Esc closes; for destructive confirmation, type the object name.
- **Form control**: label, optional hint, control, error with icon and fix text, focus ring.
- **Stat widget**: label, value + unit, delta with direction and period, sparkline.

## Refuse → do instead
- Showing only the happy state → states side by side.
- Icon-in-a-rounded-square above every title → an inline 16–20px icon or none.
- Shadow + border + tint together → pick one.
