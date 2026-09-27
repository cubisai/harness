---
name: pdf
description: Work with PDF files - extract text, merge or split PDFs, rotate or reorder pages, fill form fields, add a watermark, or create a new PDF. Use whenever the user mentions a PDF or asks for output as a PDF.
---

# PDF

Use Node libraries, installed once into a scratch folder so the user's project isn't touched:

```bash
npm install --prefix "<tmp>/harness-doc-tools" pdf-lib unpdf
```

Load them in a script with `createRequire("<tmp>/harness-doc-tools/")` (`node:module`). Keep scripts in the scratch folder unless the user wants them.

## Read

- Text: unpdf is ESM-only, so import it by file URL (this also works on Windows): `const { extractText, getDocumentProxy } = await import(require("node:url").pathToFileURL(req.resolve("unpdf")).href)`; then `extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false })` gives `{ totalPages, text: [page1, page2, …] }`.
- Scanned PDFs have no text layer: say so, and offer OCR only if a tool for it is installed (`tesseract`).
- Form fields: `PDFDocument.load(bytes)` then `doc.getForm().getFields()` → name and type of each.

## Change

With `pdf-lib`:
- Merge: create a document, `copyPages(src, src.getPageIndices())`, `addPage` each.
- Split or extract pages: copy only the indices you need into a new document.
- Rotate: `page.setRotation(degrees(90))`.
- Watermark or stamp: `page.drawText(text, { x, y, size, opacity, rotate })`.
- Fill a form: `form.getTextField(name).setText(value)`, `getCheckBox(name).check()`, then `form.flatten()` only if the user wants it uneditable.
- Encrypted PDFs: pdf-lib can't decrypt; ask for an unprotected copy.

Save with `await doc.save()` → write bytes. Write a new file (`name.merged.pdf`) unless the user asked to replace the original.

## Create

For a text document, the simplest route that looks good: write HTML and print it to PDF with the harness browser if it's open, or build it with `pdf-lib` (`StandardFonts.Helvetica`, wrap lines yourself at the page width). For a Word-like document, the `docx` skill plus a LibreOffice conversion (`soffice --headless --convert-to pdf`) gives better typography when LibreOffice is installed.

## Check your output

Re-read the file you wrote: page count, and the text of the first and last page, to confirm nothing is missing or out of order.
