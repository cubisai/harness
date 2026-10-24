---
name: pdf
description: Create, read, merge, split or fill PDFs. Write HTML from the template; CubiQ's document_build prints and checks the PDF. Use for any PDF request.
---

# PDF

## Make one (report, letter, one-pager, invoice)

1. `document_template` with `format: "pdf"` and `path: "report.html"`: writes a print-ready page with page size, margins, page numbers, a header, key figures, a table and a callout.
2. Replace its example content with the real content, using your file edit tools (they save UTF-8). Keep its `<style>` block and its classes:
   - `figures` for a row of key numbers;
   - `num` for right-aligned number cells;
   - `callout` for a decision or note;
   - `new-page` on a heading that must start a page.
   Use real elements (`h2`, `p`, `ul`, `table`). No absolute positioning, fixed heights, web fonts, scripts or remote images: images are files next to the HTML, linked relatively.
3. `document_build` with `input: "report.html"`, which writes `report.pdf` and shows you page 1.
4. Look at that page. If text overlaps, is cut off or looks wrong, fix the HTML and build again. If it returns ERROR lines (garbled text, placeholders), fix exactly that. It's done only when it says `OK:` and page 1 looks right.
5. Tell the user the file name and the page count.

Never draw a document with `pdf-lib` text at x/y positions: it has no wrapping or pagination and only two Latin fonts.

No `document_build` tool? Print the same HTML with Chrome or Edge:
`"<browser>" --headless=new --no-pdf-header-footer --print-to-pdf="report.pdf" "file:///<absolute path>/report.html"`.
Browser paths:
- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe` or `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, with forward slashes in the file URL
- Linux: `google-chrome`

## Read, merge, split, fill

Packages, when you need them: only `pdf-lib@1.17.1` (merge, split, rotate, fill) and `unpdf@1.8.1` (text), installed into a scratch folder, never the project. unpdf is ESM-only: load it with `import()`.
- **Text**: `extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false })` gives `{ totalPages, text: [...] }`. No text layer means a scan: say so.
- **Merge**: make a new document, `copyPages(src, src.getPageIndices())`, then `addPage` for each. **Split**: copy only the wanted pages. **Rotate**: `page.setRotation(degrees(90))`.
- **Fill a form**: `form.getTextField(name).setText(value)`. Call `form.flatten()` only if the user wants it locked.
- Encrypted PDFs can't be opened: ask for an unprotected copy.
- Write `name.merged.pdf` and similar; never overwrite the original unless asked.
