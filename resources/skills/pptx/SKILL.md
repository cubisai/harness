---
name: pptx
description: Create, read or edit PowerPoint decks (.pptx). Write a JSON outline; CubiQ's document_build lays out a clean, checked deck. Use for any slides request.
---

# PowerPoint decks (.pptx)

You write the outline: slides and their words. The builder owns layout, font sizes, colours and bounds, and refuses anything that would overflow or corrupt the deck.

## Make one

1. `document_template` with `format: "pptx"` and `path: "deck.json"`: writes an example deck that uses every layout, plus `deck-image.png`.
2. Replace the example's content with the real content. Keep the JSON shape. `theme` is clean, navy, warm or dark. Each slide has a `layout`:
   - `title` (title, subtitle) and `section` (title);
   - `bullets` (title, 1–6 bullets, each up to 160 characters);
   - `two-column` (title, left, right, leftTitle and rightTitle optional);
   - `chart` (title, `chart: { type: bar|line|pie, labels, series: [{ name, values }] }`);
   - `image` (title, a png or jpg path next to the JSON, caption);
   - `quote` (quote, by).
   Any slide can have `notes`.
3. Plan it as one message per slide. A deck reads better with a chart, an image or two columns every few slides than with bullets only.
4. `document_build` with `input: "deck.json"`, which writes `deck.pptx`.
5. If it returns ERROR lines ("7 bullets, split it", "too much text on slide 4"), change exactly that and build again. It's done only when it says `OK:`.

No `document_build` tool? Run the same builder yourself: `node "<this skill's folder>/scripts/deck.mjs" init deck.json`, then `build deck.json deck.pptx`.

## Read

A .pptx is a ZIP. With `jszip@3.10.2`, take `ppt/slides/slideN.xml` in numeric order (slide10 sorts before slide2 alphabetically). Collect the `<a:t>` text of each `<a:p>`; speaker notes are in `ppt/notesSlides/`. Report slide by slide, title first.

## Edit an existing deck

- Text changes: edit the slide XML with `jszip` (text is split across `<a:r>` runs: match the paragraph's joined text), zip it again and write `name.edited.pptx`.
- Adding, removing or reordering slides means keeping `[Content_Types].xml`, `ppt/_rels/presentation.xml.rels` and `<p:sldIdLst>` consistent. Usually it's easier to rebuild the deck from an outline; say what didn't carry over.
- Then `document_check` on the result.
