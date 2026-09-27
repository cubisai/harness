---
name: pptx
description: Create or read PowerPoint presentations (.pptx) - build a slide deck with titles, bullets, images, tables and charts, or extract the text and notes from an existing deck. Use whenever the user wants slides or mentions a .pptx file.
---

# Presentations (.pptx)

Use Node libraries, installed once into a scratch folder so the user's project isn't touched:

```bash
npm install --prefix "<tmp>/harness-doc-tools" pptxgenjs jszip
```

Load them with `createRequire("<tmp>/harness-doc-tools/")` (`node:module`).

## Read

A .pptx is a ZIP. With `jszip`, list `ppt/slides/slideN.xml` in number order and collect the text of every `<a:t>` element per slide; speaker notes are in `ppt/notesSlides/`. Report slide by slide.

## Create

With `pptxgenjs`: `const pptx = new PptxGenJS(); pptx.layout = "LAYOUT_16x9";` then per slide `pptx.addSlide()` and `slide.addText`, `addImage({ path })`, `addTable(rows)`, `addChart(pptx.ChartType.bar, data)`, `slide.addNotes(text)`. Save with `await pptx.writeFile({ fileName })`.

Plan the deck before writing code: one message per slide, a title that states it, at most five short bullets, and the detail in the speaker notes. Pick one font and two or three colours and use them on every slide (`pptx.defineSlideMaster` keeps them consistent).

## Edit an existing deck

pptxgenjs can't open existing files. For text changes, edit the slide XML with `jszip` (text can be split across several `<a:r>` runs) and zip again, writing `name.edited.pptx`. For anything bigger, rebuild the deck and say what was not carried over.

## Check your output

Re-open the written file with `jszip` and list each slide's title and bullet count. If LibreOffice is installed, `soffice --headless --convert-to pdf deck.pptx` and look at the pages for overflowing text.
