# Playful

## 1. Visual theme and atmosphere
Bright, warm and friendly. Rounded type, big soft corners, a violet primary with an orange spark, chunky buttons that invite a tap. For consumer apps, onboarding, games, kids' and community products. Fun, never chaotic.

## 2. Color palette and roles
Use the `--color-*` tokens; light and dark come from `prefers-color-scheme`.
- `bg` warm cream, `surface` white cards, `surface-2` peach wells, chips and selected states.
- `text` deep plum; `text-muted` secondary copy.
- `border` soft outlines on inputs and cards.
- `primary` violet: main buttons, active tabs, progress. `on-primary` text on it.
- `accent` orange: one spark per screen (a badge, a streak, an illustration detail). Never body text on `bg` below 18px.
- `success`, `warning`, `danger` status only.

## 3. Typography rules
- `--font-sans` (rounded) for everything; `--font-mono` for codes.
- Scale: `text-sm` (14/20) meta, `text-md` (16/24) body, `text-lg` (20/28) card titles, `text-2xl` (32/40) screen title, `text-3xl` (48/56) hero.
- Weights: 400 body, 500 buttons, 700 titles. Sentence case; friendly, short copy ("Nice! You're all set").

## 4. Component stylings
- **Buttons**: height 48, padding 0 24, `radius-full`, `text-md` 500. Primary = `primary` fill with a 2px darker bottom edge (`box-shadow: inset 0 -2px 0 rgb(0 0 0 / .15)`); press = translateY(1px). Secondary = `surface-2` fill.
- **Cards**: `surface`, `radius-lg` (24), padding 24, `shadow-1`; tappable cards lift to `shadow-2` on hover.
- **Inputs**: height 48, `radius-md` (16), 2px `border`, focus = 2px `primary` border + `focus` ring.
- **Chips / tags**: height 32, padding 0 12, `radius-full`, `surface-2`; selected = `primary` fill.
- **Progress**: 8px tall `radius-full` track in `surface-2`, fill `primary`.
- **Illustrations**: inline SVG blobs and simple shapes in `primary`, `accent`, `surface-2`; no remote images.
- **Bottom nav (mobile)**: 64 + safe area, 4–5 items, active = filled icon + label in `primary`.

## 5. Layout principles
- 8pt spacing only (`--space-*`); roomy: 16 inside small controls, 24 inside cards, 32–48 between groups.
- Content max 1080 on desktop; mobile-first single column.
- Big tap areas: every target ≥ 48 here.
- Group with cards and color fills rather than lines.

## 6. Depth and elevation
Soft, colored shadows: `shadow-1` at rest for cards, `shadow-2` for hover/lifted and menus, `shadow-3` for sheets and dialogs. Sheets slide up with `--duration` and `--ease`.

## 7. Do's and don'ts
- Do celebrate success states (a check, a short line of copy, a small burst in `accent`).
- Do keep one orange spark per screen.
- Don't use more than two saturated colors in one component.
- Don't put text on busy illustrations.
- Don't animate longer than 300ms or bounce more than once; respect reduced motion.

## 8. Responsive behavior
- Mobile first at 390; breakpoints 768 and 1280.
- Mobile: bottom nav, full-width buttons, cards stack.
- Tablet/desktop: 2–3 column card grids, nav moves to a top bar, hero illustration beside the copy.

## 9. Agent prompt guide
"Playful system: cream `--color-bg`, white rounded cards (`--radius-lg`), violet `--color-primary` pill buttons 48 tall with a pressed edge, one orange `--color-accent` spark per screen, rounded `--font-sans`, friendly short copy, soft colored shadows, inline SVG shapes, 8pt spacing."
