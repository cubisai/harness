---
name: docx
description: Read, create or edit Word documents (.docx) - extract text, build a formatted report or letter with headings, lists, tables and images, or change an existing .docx. Use whenever the user mentions a Word document, a .docx file, or wants a document they can open in Word.
---

# Word documents (.docx)

A .docx is a ZIP of XML files.

## Packages: only these, only if missing

Allowed: `docx@9.11.0` (create), `mammoth@1.13.0` (read), `jszip@3.10.2` (edit XML). Nothing else; if a task seems to need another package, stop and tell the user what and why.

Check first, install only on failure, into the scratch folder (never the project):

```bash
node -e "const r=require('node:module').createRequire('<tmp>/harness-doc-tools/');r('docx');r('mammoth');r('jszip')" 2>/dev/null \
  || npm install --prefix "<tmp>/harness-doc-tools" --ignore-scripts --no-audit --no-fund docx@9.11.0 mammoth@1.13.0 jszip@3.10.2
```

Load with `createRequire("<tmp>/harness-doc-tools/")`. Write the generator script with the **Write tool** (UTF-8), in the scratch folder. Never create it through a PowerShell here-string: Windows PowerShell saves ANSI and `—` becomes `â€”`.

## Read

- Text: `mammoth.extractRawText({ path })` → `.value`.
- Structure: `mammoth.convertToHtml({ path })`.
- Comments, tracked changes, exact formatting: `jszip`, then `word/document.xml` and `word/comments.xml`.

## Create (`docx`)

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  ShadingType, AlignmentType, Footer, PageNumber, ImageRun, LevelFormat } = req("docx");
```

Rules that avoid the common breakages:
- Set the page explicitly: `sections[0].properties.page.size = { width: 11906, height: 16838 }` (A4, in twips) or `12240 x 15840` (US Letter), margins 1134-1440.
- Fonts: `styles.default.document.run = { font: "Calibri", size: 22 }` (11 pt). Headings through `HeadingLevel.HEADING_1..3`, restyle them in `styles.paragraphStyles` instead of bolding body text.
- Lists: `numbering.config` with `LevelFormat.BULLET` / `DECIMAL` and `numbering: { reference, level }` on the paragraph. Never type `•` or `1.` into the text.
- Line breaks: separate `Paragraph`s, or `new TextRun({ break: 1 })`. A `\n` inside a `TextRun` is not a break.
- Tables: give `width: { size: 9026, type: WidthType.DXA }` (page width minus margins) **and** `columnWidths: [...]` that sum to it, and a `width` with `WidthType.DXA` on every cell. Percentage widths render differently in Word and LibreOffice. Header row: `tableHeader: true`, shaded with `ShadingType.CLEAR` and a `fill` hex without `#`.
- Images: `new ImageRun({ type: "png", data: bytes, transformation: { width, height } })`; `type` is required in v9. Keep the width at or under the text width (about 600 px for A4 with 20 mm margins).
- Page numbers: a `Footer` containing `new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES] })` for anything over two pages.
- Colours are `"1F4E79"`, never `#1F4E79`.
- Save with `Packer.toBuffer(doc)` → `fs.writeFileSync`.

Layout defaults: one heading hierarchy, body 11 pt, 1.15 line spacing, 6-10 pt after paragraphs, tables with a header row, no decorative shapes.

## Edit an existing file

- Small text changes: `jszip`, edit `word/document.xml`, zip again. Text is split across `<w:r>` runs: search the joined text of a paragraph, not raw XML.
- Large rewrites: read with mammoth, rebuild with `docx`, and tell the user what was not carried over (anything beyond headings, lists, tables, images).
- Write `name.edited.docx` unless the user asked for in-place.

## Check before you say it is done

1. Re-open with `mammoth.extractRawText`: text present and in order; no `â€`, `â†`, `Ã`, `�`, no `TODO`/`lorem`/`[insert`.
2. Unzip check with `jszip`: `[Content_Types].xml` and `word/document.xml` exist.
3. **Look at it** if a converter is already installed: `soffice --headless --convert-to pdf --outdir <tmp> file.docx`, then `pdftoppm -png -r 80`, then open the PNGs with the image Read tool. Check overlap, clipped tables, empty pages.
4. If you could not render it, say that in the answer. Never claim the layout is verified from the text check.
