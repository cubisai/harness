# Soft Health

## World
Health and wellbeing on a phone: lavender and mint on soft white, rounded friendly UI, reassuring copy. Calm by default; colour turns serious only when something needs attention.

## Colour: restrained
- `--color-bg` soft white, `--color-surface` white cards, `--color-surface-2` lavender wells.
- `--color-primary` lavender-violet for actions; `--color-accent` mint for progress and success.
- Alerts use `--color-danger` with plain words, never colour alone.

## Type
- Onest throughout: titles 24–32 weight 600, body 16/24, numbers (steps, sleep hours) at 40–56 weight 600.
- Copy is warm and short: "You slept 7h 20m" rather than data jargon.

## Layout
- Mobile first: a 390×844 screen, 16px side gutters, safe areas, a bottom tab bar with 4 items.
- Stacked cards with 16px gaps; one summary card on top, details below.
- Charts are simple: rounded bars or a smooth ring, one series highlighted.

## Components
- Button: 52px, `--radius-full`, full width at the bottom of a flow.
- Card: `--color-surface`, `--radius-lg`, `--shadow-1`, padding `--space-6`.
- Input: 52px, `--radius-md`, label above in `--text-sm`.
- Status: 28px, `--radius-full`, `--color-*-soft` fill; danger only for a real alert.

## Signature
A daily summary ring or arc made of soft mint and lavender segments, with one sentence of encouragement under it.

## Rules
- Reassure first: one clear next step per screen, in kind words (not alarming copy).
- Show readings as a value, a range and a trend (not dense tables or red-heavy dashboards).
- Use the warm violet and teal (not clinical blue-on-white).
- Make every target 52px on primary actions, 44px minimum elsewhere.

## Motion
Gentle (220–300ms) ease-out; progress rings animate once on open. Respect reduced motion.
