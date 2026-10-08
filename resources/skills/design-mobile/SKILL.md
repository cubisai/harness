---
name: design-mobile
description: Design iOS or Android app screens as live HTML in a CubiQ design thread - one or several 390x844 phone frames side by side, with safe areas, native-feeling navigation, 44pt targets and the active design system's tokens.
mode: design
---

# Mobile screens

You are designing phone screens the user watches in CubiQ's canvas. Show them as real-size phone frames on a neutral backdrop so several screens of a flow sit side by side.

## 1. Start

1. Read `system/DESIGN.md` in the design folder and follow it.
2. If `index.html` doesn't exist yet, copy `assets/index.html` from this skill's folder into the design folder. It lays out `.phone` frames (390×844, rounded, with a status bar and home indicator) in a row that wraps.
3. Decide the platform: iOS unless the user says Android. Name it in your final line.

## 2. Each screen

- One `<section class="phone" aria-label="Screen name">` per screen; inside it `.status-bar`, `.screen` (scrolls), optional `.tab-bar`, `.home-indicator`.
- **Safe areas**: content starts below the 47px status bar and ends above the 34px home indicator; `.screen` already pads for both. Inside the frame use `env(safe-area-inset-*)` fallbacks only if you build a full-viewport variant.
- **Navigation**: iOS = large title (32/40 bold) that sits under a 44px nav bar, tab bar 49 + indicator with 4–5 items (icon 24 + label 10–12px). Android = 64 top app bar, bottom navigation 80, FAB 56 at 16 from the edges.
- **Targets** ≥ 44×44 (iOS) / 48×48 (Android); list rows 44–56 tall; full-width primary buttons 48–56 tall at 16 side margins.
- **8pt rule** for every space; side margins 16 (iOS) or 16/24 (Android).
- **Type**: body 16/24 (iOS 17pt feel is fine at 16 here), captions 12/16, titles from the system's scale.
- **Content**: real data, realistic times in the status bar (9:41), real names. Inline SVG icons, `stroke="currentColor"`.
- **Keyboard / sheets**: show a bottom sheet as its own frame with a 36×4 grabber and `radius-lg` top corners; dim the screen behind with a 40% scrim.

## 3. Flows

For a flow, lay screens left to right in order and add a short caption under each frame (`.caption`). Link them with `<a href="#screen-id">` for click-through when the user asks for a prototype.

## 4. Finish

States: show empty, loading (skeletons) and error for data screens, and pressed/disabled for buttons. Then say in a line which screens you made and what to look at; don't paste the HTML.
