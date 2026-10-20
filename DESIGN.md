# CubiQ design system: Ink Flat

The single source of truth for how CubiQ looks and behaves. Every agent (Claude Code, the opencode workers) reads this before touching `src/renderer/**`. Brand source: `CubiQ — Logo & Icon System.pdf`. Approved mock: https://claude.ai/artifact/TNGyM5xqgZcrJZne7zdYHN (direction A).

## 1. Principles

1. **Flat.** No drop shadows on cards, rows, the composer, buttons or sheets. Depth comes from surface tint and 1px hairlines. The only exception is overlays that float over content (popovers, menus, ⌘K, dialogs), which get `--shadow-float`, one soft layer.
2. **Compact.** 13px body text, 28px controls, 4px spacing grid. One row of controls in the composer. Show detail on hover or click, not by default.
3. **Ink is primary, acid is a signal.** Buttons, selection and focus use Agent Ink in light mode and Signal White in dark mode. Acid Signal marks only "the agent is alive": a live run, the iQ dot, a search match. The running beam is an exception: it is rainbow (user decision 2026-10-02). So are the Thinking and Context sliders: from Xhigh up (Context: on Max) their dots glow in `--signal-line` (user decision 2026-10-02).
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
| `--signal-line` | `#4A9A12` (3.55:1) | `#A8FF55` | Non-text graphics: the ring around the live dot |

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
- **Text size** (Settings › Appearance, ⌘= / ⌘− / ⌘0, Ctrl on Windows): the whole app zooms by one of 80 / 90 / 100 / 110 / 125 / 140% (`shared/zoom.ts`), through Electron's page zoom, so the scale above stays in px. The app owns zoom: Chromium's own zoom keys and Ctrl+wheel step the setting instead. Anything that must clear native chrome (the macOS traffic lights, the Windows caption buttons) divides its inset by `--zoom`, and on macOS the lights move to stay centred on the zoomed header.
- **Weights**: 400 body, 500 labels, 600 titles and group headers. No 700 in the chrome.
- **Line height**: 1.5 chrome, 1.6 for agent replies.
- Section headers (Running, Pinned, Recent) are 11px/600 in `--text-tertiary`, sentence case, no uppercase. Uppercase is allowed only for popover group labels (10.5px, +0.03em).
- Use `font-variant-numeric: tabular-nums` for token counts, times and diff stats.

## 4. Space, size, radius

- 4px grid: gaps of 2 · 4 · 6 · 8 · 12 · 16 · 24.
- Controls are 28px tall (icon buttons 28×28). Sidebar rows are about 28px for one line, 40px with a sub-line. The send button is 30px round.
- Radius: `--radius-s` 6 (chips, kbd, small buttons) · `--radius-m` 8 (controls, rows, code) · `--radius-l` 10 (composer, cards, popovers) · 12 (⌘K, dialogs). Pills only for filter chips.
- Layout: sidebar 248px (resizable), artifact panel 430px (resizable up to 80% of the space right of the sidebar, always on the **right**; the chat keeps 420px unless the user drags the panel wider, then never under 260px or 20%), reading column max 720px centred, header 46px. On macOS the traffic lights are centred on the header and the sidebar toggle sits right after them at the same spot whether the sidebar is open or collapsed; collapsed, New thread follows it (as in the ChatGPT and Claude apps).

## 5. Elevation and borders

- Everything sits flat: a 1px `--hairline` border or a tint change.
- `--shadow-float: 0 12px 40px rgb(0 0 0 / .12)` (dark: `rgb(0 0 0 / .5)`), only on popovers, menus, ⌘K and dialogs.
- No inset shadows and no glow. The segmented "on" state is `--bg` plus a 1px `--hairline` ring, not a shadow.
- Focus is `outline: 2px solid var(--focus); outline-offset: 2px`. Inputs on focus: `border-color: var(--hairline-strong)` and no halo.

## 6. Motion

- Durations: 120ms hover and fade, 200–220ms popover in, 550ms gooey (380ms on subtle). Ease `cubic-bezier(.2,.8,.2,1)`. Popovers use a slight overshoot `cubic-bezier(.2,.9,.25,1.15)`.
- **Running beam** (after libraries.dev border-beam, rebuilt in CSS, user decision 2026-10-02): while a turn runs, soft colour blobs glow just inside the composer's edges (within 28px) and a faint highlight rides the 1px border; a rotating conic window (1.96s per lap) sweeps them round (no hue drift: animating `filter` made the window flicker). It is on its own layer (`contain: strict`). Dark mode adds a white highlight, inner sheen and a blurred sparkle. Fades in over 0.6s. Strengths are the `--beam-*` tokens.
- **Gooey** (after libraries.dev/gooey, `GooeyPlus.tsx`): the composer's `+` splits into round @ / $ / / buttons in a row along the bar, through an SVG goo filter (blur 6, alpha `18 -7`) drawn under the real buttons so icons stay crisp; `cubic-bezier(.34,1.56,.64,1)` 550ms, 40ms stagger, icons fade in after their blob pulls away; the `+` turns to ×; the chips beside it step aside while open. Composer popovers (`.model-menu.up`) morph in from scale .92 with a 22px radius.
- No liquid-metal effects in the chrome.
- The beam is a status signal, not decoration: it runs regardless of the `motion` setting. `prefers-reduced-motion` holds it still (no spin).
- The `motion` setting (default full since 2026-10-02) gates entrance animations (gooey, popover morph) and the Thinking slider's firefly dots (subtle and full). `prefers-reduced-motion` disables those too.
- The launch splash is the exception: it is a wallpaper the user picks in Settings (with Off), so it plays unless Motion is Instant (then it shows the still poster); the OS reduce-motion flag doesn't still it.

## 7. Components

### 7.1 Sidebar (inbox style)
- Top: brand row (iQ mark 22px, "CubiQ", collapse toggle), then nav rows **New thread ⌘N · New chat (Chat mode only) · Search ⌘K · Library**. New chat starts a thread in the built-in **Chats** project (no folder needed), which lists first under Recent and has no ⋯ project menu.
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
- **Model picker**: search, models grouped by agent (picking another agent's model opens the Switch dialog), then **Thinking** (a Faster ↔ Smarter slider, one stop per level, resting on the model's default until moved, with Reset; its lit part is a dot grid whose dots blink like fireflies, each on its own random clock, muted below Xhigh and in `--signal-line` green from Xhigh up; the knob and trail glide 360ms with the popover overshoot; 20px track) and **Context** (the same slider with two stops, Default ↔ Max window, ends labelled with the sizes, green on Max; only when the model offers more than one window). Shortcuts are listed at the bottom.
- **Mode chip**: shows the current mode and opens a menu (Ask / Auto-edit / Plan / Full access, each with a one-line description). ⇧Tab cycles. Full access is shown in `--danger`.
- **Context ring**: an 18px ring showing the share used. Click opens the breakdown: a stacked bar plus rows for System, Tools & MCP, Skills, Guide + memory and Messages, then this thread's in/out, cache hit, cost and auto-compact point, and the buttons **Compact now** and **Open /context**.
- **Skill chips**: `$` at any word start (or + › Use a skill) opens the skill menu; each pick becomes a chip inside the text area, before the text (`[$tdd ×] [$review ×] Ask anything…`), wrapping with it. Picked skills show ✓ in the menu and picking one again takes it out; × or Backspace in an empty box removes a chip. Browser-context chips sit in the same row. Sent bubbles show every skill chip.
- Slash commands include `/compact [focus]`.
- While running, the status line above the composer reads `● Writing tests · 12s · Esc to stop` in `--signal-ink`.

### 7.4 Messages
- **User**: right-aligned bubble (`--bg-chip`, radius 10, max 82%). Attachments and @-file chips sit above it; its skill chips lead the text. Hover shows Edit, Copy and the time.
- **Agent**: no bubble or avatar, full column width, line height 1.6.
  - Tool calls collapse into one line: "Worked for 41s · read 1 file · edited 1 · ran 1 command". Expanded, the rows sit behind a 1px left rule. Every file path in them is clickable and opens the panel.
  - Code blocks have a 1px border, a header with the language and Copy, and a body on `--bg`.
  - A changes card at the end of a turn: "2 files changed +38 −0 · Review · Undo".
  - Hover actions: Copy, Retry, Branch, plus the meta line (model · effort · tokens · cost) in mono `--text-tertiary`.
- Reasoning shows as a muted "Thought for 6s" disclosure.

### 7.5 Artifact panel (right side)
- Opens by itself **when a turn finishes**, never mid-stream, on the last file the agent wrote in that turn of a deliverable kind (html, svg, pdf, image, csv, docx, xlsx, pptx). Markdown and code never open by themselves: their file card in the chat has a **Preview** button. If the turn wrote several, it shows the last one with a switcher. A rewrite of the same file adds a version (v1, v2…).
- The header shows the file name, version ▾, Open in ▾, Copy and Close. Tabs: Preview · Source · Diff.
- Drag it up to 80% wide for long documents and plans. Beside it the chat must still work at 260px: the composer stays one row, nothing scrolls sideways. When the controls don't fit, the bar folds (measured, before paint): the model label ellipsizes, the chips drop their labels, then a design thread's mode, system and tier merge into one chip; a second row is only a last resort against overlap.
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
- A choice along a scale (Text size) uses the same step slider as Thinking (§7.3), not a segmented control: Smaller ↔ Larger, Reset back to 100%, green from 125% up.

## 8. Do and don't

- **Do**: tint and hairlines for structure, ink for primary, acid only for "alive", one row of controls, hover to reveal actions, mono for numbers.
- **Don't**: shadows on static surfaces, blue accents (the old `#0a84ff`), acid text or lines on white, emoji as icons, uppercase section headers in the sidebar, more than one primary button per view, a fixed width on any input inside a flex row.

## 9. Check before you ship a UI change

1. Light and dark (`data-theme` both ways, plus system).
2. Narrow window: a 900px wide app with the panel open has no horizontal scroll and no clipped controls.
3. Windows (Mica off, opaque sidebar) and macOS.
4. Reduce-motion on: no animation (except the launch splash the user picked; see §6).
5. Keyboard: every control reachable, with a visible focus ring.
6. The real app, driven and screenshotted (memory `test-app-for-real`), not just the preview.
