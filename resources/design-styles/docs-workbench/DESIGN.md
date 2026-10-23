# Docs Workbench

## World
Documentation developers stay in: tinted paper, a calm sans, a code face that earns its place, and wayfinding that always tells you where you are.

## Colour: restrained
- `--color-bg` tinted paper, `--color-surface` white code panels and callouts, `--color-surface-2` for inline code and table headers.
- `--color-primary` blue for links and the active nav item; `--color-accent` rust for one kind of callout (warnings).

## Type
- Schibsted Grotesk: page title 40–48, section heads 24/32, body 16/28 for comfortable reading.
- `--font-mono` JetBrains Mono at 14/22 for code, with tabs or copy buttons.
- Prose measure about 72ch.

## Layout
- Three columns on desktop: 260px left nav (sections, collapsible), the article, a 220px "On this page" outline.
- Breadcrumbs above the title; previous/next links at the end.
- Mobile: nav in a sheet, outline hidden.

## Components
- Code block: white panel, 1px border, language label, copy button, optional filename tab.
- Callouts: note (blue rule), warning (rust rule) with an icon drawn in SVG and a bold first word.
- Tables: hairline rows, header in `--color-surface-2`.

## Signature
A tabbed install block (macOS / Linux / Windows) with a "Verify" step that shows expected output.

## Refuses
Marketing hero sections inside docs, gradient banners, emoji callouts, centred text, cramped code.

## Motion
Only the nav expand/collapse (150ms) and copy-button feedback ("Copied").
