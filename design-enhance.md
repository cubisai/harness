# Design mode: next enhancements (planning input, 2026-10-24)

Starting point: m4 `3753f7c` (local, not pushed). Design threads now run in **Full behind a fence**, with no permission cards. The v2 history is in `v2_design.md`; this file is the input for the next plan.

## Where design mode stands (live, 2026-10-24)

### Fence and Full mode (fence build `d47077f` + `3753f7c`)

- **0 permission cards** in 6 design turns across Claude Sonnet 5.5, Codex GPT-6-Luna and OpenCode DeepSeek v4.1 Flash Free. Those threads still had "ask" stored, so a stored mode really is ignored.
  - Before the fence: OpenCode #4 raised **8 cards in one turn**. Every one was a shell `python3`/`rg` on its own `index.html`.
- **Fence probe**, one thread per agent: "write `fence-probe.txt` outside `designs/`, with the file tool, then with `echo > file`".
  - Every attempt was denied with the fence's reason, and nothing reached disk.
  - Claude and OpenCode tried both routes. Codex skipped the shell attempt on its own.
- The mode picker is gone in design threads. The compact chip reads "Full access, fenced to this design's folder".

### Style direction across all runs (2026-10-23 and today)

- Claude: 10/10 done, 10 distinct styles. Codex: 10/10, 9 distinct. Neither repeated a style back to back.
- OpenCode: #1–6 done. #4 was stopped after its 8 cards, and #6 hit the test driver's 6-minute timeout mid-work.

### UI fixes from the screenshots

- **Layers rows overlapping**: fixed with `flex-shrink: 0`. Only the code is checked: **a screenshot with a 100+ node page is still pending**.
- **Hover icons over the thread title**: fixed, and seen live (the title ellipsises before Archive/More).
- **Welcome screen over the canvas**: fixed. The renderer refetches projects when a thread's project is unknown, and the canvas needs a project. There's a store test, but it wasn't reproduced live.

### Rough edges seen in the live runs

1. **Lint leftovers at the end of a turn**: Claude #8 ended with 5 findings and OpenCode #5 with 2 targets, even though the guide now says to fix them.
2. **Style fit**: OpenCode #1 picked `docs-workbench` for a note-taking landing page. Claude #8 first asked for a style called "warm editorial", which doesn't exist; it recovered.
3. **Codex skill path**: Codex guessed `~/.codex/plugins/cache/…/work-pets/…/design-prototype/SKILL.md` before finding the right file. `3753f7c` now names the real folder; **not re-tested live**.
4. **Codex `run_code`**: once called `read()` instead of `tools.read()`.
5. **`design_screenshot`**: failed once with `UnknownVizError`, then worked on retry.
6. **OpenCode free model is slow**: 4–6 minutes a page. The test driver's 6-minute cap is too tight for it.
7. **Fence limits** (by design, noted for the plan):
   - A script embedded in a shell command (e.g. inline Python) isn't inspected; the guide steers agents to file tools instead.
   - Reads anywhere are allowed.
   - Codex design turns run with a read-only sandbox + approvals, so each write is a round trip the app answers itself.

## Enhancements to plan (user, 2026-10-24)

1. **Left rail: Pages and Layers.**
   - Make it richer and more usable: element icons, collapse/expand, clearer names than `div.wrap`, hover-to-highlight on the canvas, and search.
   - Pages: thumbnails and states.
2. **More taste overall.** Generated pages should look designed, not generated. Raise the bar in the skills, the style notes and the lint (slop rules).
3. **Remove the preset pickers** (colour presets and the like) for a cleaner composer and canvas. Auto direction picks, and the user steers in words.
4. **Colours and themes.** Better palettes per style, real light/dark pairs, and accent rules that read as intentional.
5. **Research styles and templates online.**
   - Find community-built design systems, styles and templates (DESIGN.md-style collections, open UI kits, OFL-licensed type pairings).
   - Bring the good ones into the style library as our own unbranded notes, as P2/P3 did, with licences checked.
6. **Upgrade the design skills** (`resources/skills/design-*`, `DESIGN-MODE.md`) with more taste: worked examples, before/after, sharper "refuse the defaults" lists.
7. **Research UI/UX data to feed the harness.**
   - Find good UI/UX knowledge (pattern libraries, heuristics, layout and type rules, real-product references) and decide how it reaches the agent: in skills, in style notes, or retrieved per surface.
   - **Spending more tokens per design turn is fine if it gives better results**: measure quality against tokens before choosing. The `DESIGN-MODE.md` cap is already 900 and can go higher.

## How to measure (for the plan)

- The same 10 prompts × 3 agents as `v2_design.md`.
- Score: distinct styles, lint at the end (contrast, targets, slop), and a side-by-side taste review of screenshots.
- Record tokens and cost per turn, so a larger guide or skill has to earn its tokens.

## Open after doc skills v2 (2026-10-24, m4)

- **Codex skips CubiQ's document tools**: with Codex's own `documents`/`pdf`/`presentations`/`spreadsheets` plugins enabled, CubiQ hides its docx/pdf/pptx/xlsx skills from Codex (`src/main/skills/codex-plugins.ts`), so Codex used its plugin (python-docx via uv, 109 s, several failed calls). Planned fix: start CubiQ's Codex session with those plugins off (`-c plugins."<name>@<market>".enabled=false`) and stop hiding CubiQ's skills; not built yet.
- **Small-model live test pending**: OpenCode Zen free hit "Free usage limit reached" before its first call. Rerun the deck and spreadsheet prompts on a small model with quota (Claude Haiku, or a provider agent).
- Live so far: Claude Sonnet made a 1-page PDF letter via `document_template` → `document_build` in 20 s ($0.14).
- Packaged build: the document tools run the scripts with Electron as Node, resolving `docx`/`pptxgenjs`/`exceljs` from the app archive; check on a packaged build and on Windows.
