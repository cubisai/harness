---
name: docx
description: Read, create or edit Word documents (.docx) - extract text, build a formatted report or letter with headings, lists, tables and images, or change an existing .docx. Use whenever the user mentions a Word document, a .docx file, or wants a document they can open in Word.
---

# Word documents (.docx)

A .docx is a ZIP of XML files. Use Node libraries, installed once into a scratch folder so the user's project isn't touched:

```bash
# Once per machine; any writable folder works. Reuse it next time.
npm install --prefix "<tmp>/harness-doc-tools" docx mammoth jszip
```

In a script, load them from there: `const { createRequire } = require("node:module"); const req = createRequire("<tmp>/harness-doc-tools/");` then `req("docx")`. Write scripts to the scratch folder too, not the project, unless the user wants to keep them.

## Read

- Text: `mammoth.extractRawText({ path })` → `.value`.
- Structure (headings, lists, tables): `mammoth.convertToHtml({ path })`, then read the HTML.
- Comments, tracked changes, exact formatting: open the ZIP with `jszip` and read `word/document.xml` (and `word/comments.xml`).

## Create

Use `docx`: `new Document({ sections: [{ children: [...] }] })`, `Paragraph`, `TextRun`, `HeadingLevel.HEADING_1`, `Table`/`TableRow`/`TableCell`, `ImageRun` (pass the image bytes), numbered or bulleted lists through `numbering` config. Save with `Packer.toBuffer(doc)` → `fs.writeFileSync(out, buf)`.

Good defaults: one heading hierarchy, body text 11 pt, tables with a header row, page numbers in the footer for anything longer than two pages.

## Edit an existing file

- Small text changes: unzip with `jszip`, edit `word/document.xml`, zip again. Text can be split across several `<w:r>` runs, so search the joined text of a paragraph, not raw XML.
- Large rewrites: read it with mammoth, then rebuild it with `docx`, and tell the user that formatting beyond headings, lists and tables was not carried over.
- Never overwrite the user's original without saying so: write `name.edited.docx` unless they asked for in-place.

## Check your output

Re-open the file you wrote with `mammoth.extractRawText` and confirm the text is there and in order. If LibreOffice is installed (`soffice --headless --convert-to pdf file.docx`), convert it and look at the PDF for layout problems.
