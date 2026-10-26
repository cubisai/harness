# Mobile patterns (390×844 app screens)

## Frame
- Draw the platform: status bar (9:41, signal, battery) at the top, home indicator at the bottom; keep content inside the safe areas (≈ 47px top, 34px bottom). Side margins 16–24px.
- iOS: large title 28–34px bold at the top of root screens, tab bar of 3–5 destinations with icon + label, sheets with a grabber. Android/Material: top app bar, navigation bar 3–5 items with an active-indicator pill, FAB only for the one primary creation action.
- Touch targets ≥ 44pt; list rows 56–72px; primary buttons 48–56px, full width at the bottom of task screens.

## Type
Body 15–17px, captions 12–13px, titles 20–28px, display 32–40px (tracking −0.02em). Line heights on a 4px rhythm. Numbers tabular.

## Anatomies
- **Home/feed**: greeting or large title, one primary summary card (balance, today's progress ring, next booking) with the key number large, a row of 3–4 quick actions (icon in a 48px circle + label), then a list grouped by day or category with leading image/icon, title, secondary line and a trailing value.
- **Detail**: full-bleed hero image (≥ 40% of the screen) with back and favourite buttons floating on it, title + key facts row (rating 4.7 · 1.2k reviews · 25–35 min), sticky section tabs, content rows, a sticky bottom bar with the main action and the price.
- **Chat**: day separators; consecutive bubbles grouped, sender name once, tails via one smaller corner (4px vs 20px); reactions as small chips overlapping the bubble's bottom edge; rich cards inline (photo grid, voice note with waveform and duration, location with an action); read receipts; a typing indicator; the composer in a pill with attach, emoji and send/mic.
- **Forms**: one column, labels above, keyboard-aware primary button.

## Visual
Rounder than desktop (12–20px cards, pill buttons) unless the style is sharp; depth from surface tone and hairlines; real photos where the product implies them (food, places, people), each cropped with intent.

## States
Show at least one: empty state with one line + one action, a selected tab, a pressed/disabled button, pull-to-refresh or a skeleton for loading lists.

## Refuse → do instead
- Desktop layout squeezed to 390px → native patterns (tab bar, sheets, large titles).
- Tiny 12px body and 32px targets → 15–17px body, 44pt targets.
- Emoji as icons, cartoon mascots → one line-icon family.
