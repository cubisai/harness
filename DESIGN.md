# CubiQ design system: Ink Flat

The single source of truth for how CubiQ looks and behaves. Every agent (Claude Code, the opencode workers) reads this before touching `src/renderer/**`. Brand source: `CubiQ — Logo & Icon System.pdf`. Approved mock: https://claude.ai/artifact/TNGyM5xqgZcrJZne7zdYHN (direction A).

## 1. Principles

1. **Flat.** No drop shadows on cards, rows, the composer, buttons or sheets. Depth comes from surface tint and 1px hairlines. The only exception is overlays that float over content (popovers, menus, ⌘K, dialogs), which get `--shadow-float`, one soft layer.
2. **Compact.** 13px body text, 28px controls, 4px spacing grid. One row of controls in the composer. Show detail on hover or click, not by default.
3. **Ink is primary, acid is a signal.** Buttons, selection and focus use Agent Ink in light mode and Signal White in dark mode. Acid Signal marks only "the agent is alive": a live run, the running beam, the iQ dot, a search match.
4. **Nothing overflows.** Every flex or grid child that holds text or an input gets `min-width: 0`. Long text is ellipsized or wraps inside its own box. Sheets scroll inside themselves. The window never scrolls sideways.
5. **Fast and crash-proof.** Heavy renderers (docx, xlsx, pptx, mermaid) load lazily and parse outside the renderer process (§7.6).

## 2. Color tokens

Defined once in `src/renderer/src/styles/app.css` `:root`, redefined for dark mode under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`. Components use tokens only, never literals.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#0E1013` | main pane, composer, panel |
| `--bg-side` | `#F7F8FA` (Signal White) | `#0B0D10` (Agent Ink) | sidebar |
| `--bg-subtle` | `#F5F6F8` | `#14171B` | code, inputs, chips |
| `--bg-chip` | `#F1F3F5` | `#1A1D22` | segmented track, user bubble |
| `--bg-hover` | `#EFF1F4` | `#181B20` | row and button hover |
| `--bg-selected` | `#E8EBEF` | `#1E2127` | current row, open chip |
| `--text` | `#0B0D10` | `#F7F8FA` | primary text |
| `--text-secondary` | `#5B606B` | `#9AA0AA` | labels, tool rows |
| `--text-tertiary` | `#9AA0AA` | `#5F6570` | meta, timestamps, hints |
| `--hairline` | `#E7E9ED` | `#22252B` | all borders and dividers |
| `--hairline-strong` | `#D5D9DF` | `#30343C` (Graphite Edge) | input borders, focus-adjacent |
| `--primary` | `#0B0D10` | `#F7F8FA` | primary button, send, active segment |
| `--on-primary` | `#FFFFFF` | `#0B0D10` | text on primary |
| `--focus` | `#0B0D10` | `#F7F8FA` | 2px focus ring, offset 2px |

### Signal roles

`#A8FF55` on white is 1.23:1, so it never stands alone on a light surface.

| Token | Light | Dark | Rule |
|---|---|---|---|
| `--signal-fill` | `#A8FF55` | `#A8FF55` | Fills only, always with Agent Ink on top (15.8:1): badges, the running dot, `<mark>` highlights |
| `--signal-ink` | `#357A08` (5.3:1) | `#A8FF55` | Text and icons that mean "live": the status line, "Running" |
| `--signal-line` | `#4A9A12` (3.55:1) | `#A8FF55` | Non-text graphics: the running beam, the ring around the live dot |

### Semantic colors (never used as accent)

| Token | Light | Dark |
|---|---|---|
| `--success` / `--add` | `#2F9E44` | `#3FB950` |
| `--danger` / `--del` | `#E5484D` | `#FF6369` |
| `--warning` (needs approval) | `#C98500` | `#F5A524` |
| `--add-bg` | `rgb(47 158 68 / .10)` | `rgb(63 185 80 / .12)` |
| `--del-bg` | `rgb(229 72 77 / .08)` | `rgb(255 99 105 / .12)` |

Full access mode shows its chip in `--danger`.

## 3. Type

- **Faces**: Geist (UI) and Geist Mono (code, meta, numbers), bundled locally as woff2 under `src/renderer/src/assets/fonts/` (SIL OFL, no network). Fallbacks: `-apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` and `ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`.
- **Scale**: 10.5 (kbd, meta mono) · 11.5 (sub-labels, section headers) · 12.5 (controls, tool rows) · 13 (body) · 14 (thread title, ⌘K input) · 18 (doc h3 in the panel). Nothing larger in the app chrome.
- **Weights**: 400 body, 500 labels, 600 titles and group headers. No 700 in the chrome.
- **Line height**: 1.5 chrome, 1.6 for agent replies.
- Section headers (Running, Pinned, Recent) are 11px/600 in `--text-tertiary`, sentence case, no uppercase. Uppercase is allowed only for popover group labels (10.5px, +0.03em).
- Use `font-variant-numeric: tabular-nums` for token counts, times and diff stats.

## 4. Space, size, radius

- 4px grid: gaps of 2 · 4 · 6 · 8 · 12 · 16 · 24.
- Controls are 28px tall (icon buttons 28×28). Sidebar rows are about 28px for one line, 40px with a sub-line. The send button is 30px round.
- Radius: `--radius-s` 6 (chips, kbd, small buttons) · `--radius-m` 8 (controls, rows, code) · `--radius-l` 10 (composer, cards, popovers) · 12 (⌘K, dialogs). Pills only for filter chips.
- Layout: sidebar 248px (resizable), artifact panel 430px (resizable, always on the **right**), reading column max 720px centred, header 46px.

## 5. Elevation and borders

- Everything sits flat: a 1px `--hairline` border or a tint change.
- `--shadow-float: 0 12px 40px rgb(0 0 0 / .12)` (dark: `rgb(0 0 0 / .5)`), only on popovers, menus, ⌘K and dialogs.
- No inset shadows and no glow. The segmented "on" state is `--bg` plus a 1px `--hairline` ring, not a shadow.
- Focus is `outline: 2px solid var(--focus); outline-offset: 2px`. Inputs on focus: `border-color: var(--hairline-strong)` and no halo.

## 6. Motion

- Durations: 120ms hover and fade, 200–220ms popover in, 380ms gooey. Ease `cubic-bezier(.2,.8,.2,1)`. Popovers use a slight overshoot `cubic-bezier(.2,.9,.25,1.15)`.
- **Running beam** (from libraries.dev/beam, flattened): while a turn runs, one thin conic-gradient line in `--signal-line` travels around the composer border (2.6s per lap). No bloom.
- **Gooey** (from libraries.dev/gooey): the composer's `+` splits into its actions (attach, @, skill, image) through an SVG goo filter. Popovers morph in from scale .92 with a larger radius.
- No liquid-metal effects in the chrome.
- The beam is a status signal, not decoration: it runs regardless of the `motion` setting. `prefers-reduced-motion` turns it into a static `--signal-line` border.
- The `motion` setting (default instant) gates entrance animations (gooey, popover morph). `prefers-reduced-motion` disables those too.

## 7. Components

### 7.1 Sidebar (inbox style)
- Top: brand row (iQ mark 22px, "CubiQ", collapse toggle), then nav rows **New thread ⌘N · Search ⌘K · Library**.
- Sections:
  - **Running**: live dot, title, elapsed time on the right, sub-line with project · agent · diff stat. "Needs approval" in `--warning`.
  - **Pinned**.
  - **Recent**: a "By project ▾" toggle switches between grouped and flat.
- A project is a small folder label (11.5px, `--text-secondary`), never styled like a thread.
- A thread row has a status dot (running, waiting, unread or none), a one-line ellipsized title, and the time on the right in mono. Hover shows ⋯ and archive.
- Footer: Add project · Inbox · Settings, icon-only except Add project.

### 7.2 Search (⌘K)
- Centred overlay, 600px wide. Input, filter chips (All, This project, Running, per agent, Files), then results grouped as Threads / Messages (with a highlighted snippet) / Files. Footer shows key hints.
- Typing `>` switches to actions (today's palette).

### 7.3 Composer
- One box, radius 10, 1px hairline, no shadow. Text area on top, one bar below:
  `[+] [mode ▾] ······ [Model · Effort ▾] [context ring] [send/stop]`.
- **Model picker**: search, models grouped by agent (picking another agent's model opens the Switch dialog), then **Thinking** (segmented) and **Context** (segmented, only when the model offers more than one window). Shortcuts are listed at the bottom.
- **Mode chip**: shows the current mode and opens a menu (Ask / Auto-edit / Plan / Full access, each with a one-line description). ⇧Tab cycles. Full access is shown in `--danger`.
- **Context ring**: an 18px ring showing the share used. Click opens the breakdown: a stacked bar plus rows for System, Tools & MCP, Skills, Guide + memory and Messages, then this thread's in/out, cache hit, cost and auto-compact point, and the buttons **Compact now** and **Open /context**.
- Slash commands include `/compact [focus]`.
- While running, the status line above the composer reads `● Writing tests · 12s · Esc to stop` in `--signal-ink`.

### 7.4 Messages
- **User**: right-aligned bubble (`--bg-chip`, radius 10, max 82%). Attachments and @-file chips sit above it. Hover shows Edit, Copy and the time.
- **Agent**: no bubble or avatar, full column width, line height 1.6.
  - Tool calls collapse into one line: "Worked for 41s · read 1 file · edited 1 · ran 1 command". Expanded, the rows sit behind a 1px left rule. Every file path in them is clickable and opens the panel.
  - Code blocks have a 1px border, a header with the language and Copy, and a body on `--bg`.
  - A changes card at the end of a turn: "2 files changed +38 −0 · Review · Undo".
  - Hover actions: Copy, Retry, Branch, plus the meta line (model · effort · tokens · cost) in mono `--text-tertiary`.
- Reasoning shows as a muted "Thought for 6s" disclosure.

### 7.5 Artifact panel (right side)
- Opens by itself **when a turn finishes**, never mid-stream, on the last file the agent wrote in that turn of a deliverable kind (html, svg, pdf, image, csv, docx, xlsx, pptx). Markdown and code never open by themselves: their file card in the chat has a **Preview** button. If the turn wrote several, it shows the last one with a switcher. A rewrite of the same file adds a version (v1, v2…).
- The header shows the file name, version ▾, Open in ▾, Copy and Close. Tabs: Preview · Source · Diff.
- Any file the agent read, created or edited opens here on click, from tool rows, the changes card or links in replies. Code gets line numbers, syntax colouring and diff tinting (`--add-bg` / `--del-bg`).
- While the agent writes, the file card in the chat reads "Generating…".

### 7.6 Previews (light, fast, no crash)
| Type | Renderer |
|---|---|
| md | the existing `markdown.tsx` renderer; mermaid loads only when a diagram is present |
| html, svg | sandboxed iframe, no network or node (the browser pane's sandbox) |
| pdf | Chromium's built-in viewer |
| docx | mammoth → HTML → sanitized |
| xlsx, csv | SheetJS, one sheet at a time, virtualized table |
| pptx | macOS: Quick Look slide images. Windows and fallback: slide XML → titles, text and images per slide |

Parsing runs in an Electron `utilityProcess`, with a 25 MB cap and a 10 s timeout, and results are cached by path and mtime. A failure shows "Can't preview · Open in…". It must never take the window down.

### 7.7 Forms and sheets (Settings, Provider editor)
- Label column 140px; the value column is `minmax(0, 1fr)`.
- Rows of inputs use `display: flex; flex-wrap: wrap; gap: 6px` and every input gets `min-width: 0` plus a flex-basis. Trailing actions (Remove) wrap to the next line rather than overflow.
- Checkbox options sit in a list with their help text directly under each one, not centred.
- Selects use the themed menu component, not native `<select>`, wherever the popup shows.

## 8. Do and don't

- **Do**: tint and hairlines for structure, ink for primary, acid only for "alive", one row of controls, hover to reveal actions, mono for numbers.
- **Don't**: shadows on static surfaces, blue accents (the old `#0a84ff`), acid text or lines on white, emoji as icons, uppercase section headers in the sidebar, more than one primary button per view, a fixed width on any input inside a flex row.

## 9. Check before you ship a UI change

1. Light and dark (`data-theme` both ways, plus system).
2. Narrow window: a 900px wide app with the panel open has no horizontal scroll and no clipped controls.
3. Windows (Mica off, opaque sidebar) and macOS.
4. Reduce-motion on: no animation.
5. Keyboard: every control reachable, with a visible focus ring.
6. The real app, driven and screenshotted (memory `test-app-for-real`), not just the preview.
