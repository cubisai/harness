# Civic Service

## World
Public-service clarity: white, black, one link blue, a yellow focus nobody can miss. Plain words, one thing per page, built for everyone including people in a hurry or using assistive tech.

## Colour: restrained
- White `--color-bg`, near-black `--color-text`, `--color-surface` light grey panels.
- Links in `--color-accent` blue, underlined always.
- `--color-primary` green for the main "Continue" or "Start now" action.
- Focus: a `--color-focus` yellow fill behind the focused element with black text and a 4px black bottom border.

## Type
- Hanken Grotesk only. Headings 48/56 (page), 32/40, 24/32; body 19/28 on desktop (bigger than usual), 16/24 on mobile.
- Plain language, sentence case, no jargon.

## Layout
- A two-thirds column for content (max 640px) and a one-third column for related links.
- One question per page in forms, with the question as the page heading.
- Step-by-step navigation for multi-part services.

## Components
- Button: 44px, `--radius-sm` (0), green fill, 2px darker bottom edge, padding 0 `--space-4`, label in `--weight-bold`.
- Input: 44px, 2px `--color-text` border, `--radius-sm`, label and hint above; focus is a 3px `--color-focus` outline.
- Error: the group gets a 4px `--color-danger` left border and the message in `--color-danger` above the field.
- Tag: 28px, `--color-*-soft` fill, status text in caps-free `--weight-bold`.
- Summary list: key/value rows with a "Change" link.

## Signature
An error summary box at the top that links to each field with an error, and the page title prefixed with "Error:" when present.

## Rules
- Start each page with what the person can do here, in one sentence (not decorative images or carousels).
- Give every field a visible label (not placeholder-only labels).
- Pair every colour signal with a word or icon (not colour alone).
- Keep blocks flat and square (not rounded marketing cards or gradients).

## Motion
None beyond focus and hover states.
