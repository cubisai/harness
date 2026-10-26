# Mobile patterns (390×844 app screens)

## Frame
Status bar (9:41) and home indicator drawn; content inside the safe areas (47 top, 34 bottom), side margins 16–24. iOS: large title 28–34 bold, tab bar of 3–5 (icon + label), sheets with a grabber. Android: top app bar, navigation bar with an active pill, a FAB only for the one creation action. Targets ≥ 44pt; rows 56–72; primary buttons 48–56, full width at the bottom of task screens.

## Type
Body 15–17, captions 12–13, titles 20–28, display 32–40 (tracking −0.02em). 4px line rhythm; tabular numbers.

## Anatomies
- **Home**: title, one summary card with the key number large, 3–4 quick actions (48px circle + label), a list grouped by day.
- **Detail**: hero image ≥ 40% with back/favourite on it, title + facts row (4.7 · 1.2k reviews · 25–35 min), sticky tabs, a bottom bar with price + action.
- **Chat**: day separators; consecutive bubbles grouped, sender name once, the tail as one 4px corner (others 20px); reaction chips overlapping the bubble edge; inline cards (photo grid, voice note with waveform and duration, location with an action); read receipts and a typing indicator; a pill composer with attach and send/mic.
- **Form**: one column, labels above, "Required" on the label row, segmented controls for 2–4 options, preset chips, a live summary line ("Repeats daily at 09:00"), the primary button above the keyboard.
- **Log row** (time-first): 56px time column (tabular, muted) | 40px tinted icon circle | title + one meta line | status word right. Day header with a count ("Today · 4 entries").
- **Date block**: 48×56, weekday 11px caps over the day 22px bold; reuse the same block in list, detail and ticket.
- **Ticket stub**: a dashed line with 16px cut-out circles at both ends; below it a QR or barcode, the pass number in mono, a 2×2 of facts (gate, seat, tier, name).
- **Tier row**: name, price right, stepper. Sold out: name struck, a danger tag, stepper disabled.
- **Fees**: one row per fee, amounts right and tabular, a rule, the total bold in the accent.
- **Map**: price pills as pins ($1,150), the selected one inverted, its card docked above the tab bar.
- **Range filter**: slider on a 32px histogram of results, counts as segments (Any 1 2 3 4+), "Reset all".
- **Slots**: a row of date chips, a 3-column grid of 44px time slots, the timezone named; taken slots disabled.

## Visual and states
Rounder than desktop (12–20 cards, pill buttons) unless the style is sharp; depth from surface tone and hairlines; real photos cropped with intent. Show at least one state: an empty screen about this item (one line, one action, one text link), a skeleton list, a disabled button. Every screen uses the same "today".

## Refuse → do instead
- Desktop squeezed to 390 → tab bar, sheets, large titles.
- 12px body, 32px targets → 15–17 body, 44pt targets.
- Emoji icons, mascots → one line-icon family (`system/icons.svg`).
- Chip rows or titles cut at the edge → scroll the row with padding, wrap or shorten the title.
