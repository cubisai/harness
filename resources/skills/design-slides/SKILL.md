---
name: design-slides
description: Design a slide deck as live HTML in a CubiQ design thread - 1920x1080 slides with keyboard navigation, an overview grid and print-to-PDF, styled with the active design system. Use for pitch decks, talks, reviews and reports shown as slides.
mode: design
---

# Slide deck

The deck is one HTML page with one `<section class="slide">` per slide. The user flips through it in CubiQ's canvas (pick the **Slide** viewport) with the arrow keys after clicking into it.

## 1. Start

1. Read `system/DESIGN.md` in the design folder; slides use its colors, fonts and radii.
2. If `index.html` doesn't exist yet, copy `assets/index.html`, `assets/deck.css` and `assets/deck.js` from this skill's folder into the design folder (same names). Don't rewrite `deck.js`/`deck.css` unless the user asks for different behavior.
3. Plan the story before styling: write the slide titles as a list (in your head or a short reply), one idea per slide, then build.

## 2. Each slide

- `<section class="slide" aria-label="…">`, 1920×1080, inner padding 96/128 (already in `deck.css`). Content lives inside that box; nothing overflows.
- **Type on slides is big**: title 96/104, heading 64/72, body 40/56, captions 24/32 (all on a 4px baseline, already in the scaffold's `<style>`). At most ~30 words of body per slide.
- **8pt spacing** between blocks: 24, 32, 48, 64, 96.
- **One idea per slide**; the heading states the takeaway ("Churn fell 18% after onboarding v2"), not the topic ("Churn").
- **Charts**: inline SVG, the system's colors, direct labels, no legends when you can label lines. **Images**: inline SVG or `data:` URIs (no network).
- **Layouts** to mix: title, section divider (full `primary` background, `on-primary` text), statement (one big line), two-column (text + visual), big number, chart, quote, comparison table, closing/CTA.
- Put a short kebab `data-agent-id` on every screen/slide root, component root and interactive element, and keep the ids when you rewrite. If the message has a `Selected in …` block, change only those elements.
- Speaker notes, when asked: `<aside class="notes" hidden>…</aside>` inside the slide.

## Worked example and before → after

A 7-slide story for "quarterly results for the onboarding team": 1 title "Onboarding v2: Q3" · 2 statement "New teams now reach their first project in 1 day, not 6" · 3 big number "18% less churn in the first 30 days" · 4 chart "Activation rose the week v2 shipped and held" (one line labelled at its end) · 5 comparison "What changed: 3 steps removed, templates added" · 6 quote from a customer, attributed · 7 closing "Next: invite flow in Q4", one ask.

- **Titles**: a topic ("Churn") → the takeaway as a sentence ("Churn fell 18% after onboarding v2").
- **Body**: six bullets of 12 words → one number or one line at billboard size, with a source caption.
- **Charts**: a legend, gridlines and five colours → one highlighted series in the accent, the rest muted, labels at the line ends.
- **Rhythm**: every slide the same title + bullets layout → alternate statement, number, chart and divider slides; a section divider on the full `primary` ground.
- **Decoration**: a gradient on every slide and icons on every bullet → plain ground and a single visual per slide.

## 3. Runtime (already in deck.js)

→/Space/PageDown next, ←/PageUp back, Home/End, **O** overview grid, `#3` in the URL opens slide 3, a slide counter bottom right. Printing (Cmd/Ctrl+P → Save as PDF) gives one 1920×1080 page per slide; check nothing relies on hover.

## Tweaks

Declare 2–3 tweaks for the deck (e.g. a `theme` choice and an `accent` color) with the same `<script type="application/json" id="cubiq-tweaks">` manifest as `design-prototype` describes: `choice`/`toggle` set `data-<id>` on `<html>`, `color`/`range` set a CSS variable on `:root`.

## 4. Finish

Say how many slides you made and the story in one line; suggest the Slide viewport and the O key. Don't paste the HTML.
