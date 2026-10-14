---
name: pdf
description: Create, read, merge, split or fill PDF files - build a report, letter or one-pager as a PDF, extract text, combine or split PDFs, fill form fields. Use whenever the user mentions a PDF or asks for output as a PDF.
---

# PDF

## Pick the route

| Task | Route | Needs |
|---|---|---|
| Create a document (report, letter, summary) | **HTML, printed to PDF by Chrome or Edge** | a browser already on the machine; no package |
| Read text | `unpdf` | package |
| Merge, split, rotate, stamp, fill a form | `pdf-lib` | package |

Do not draw a document by hand with `pdf-lib` (`drawText` at x/y). It has no text measuring, wrapping or pagination, only two Latin-1 fonts, and it is how rows end up on top of each other and `—` becomes `â€”`.

## Packages: only these, only if missing

Allowed: `pdf-lib@1.17.1`, `unpdf@1.8.1`. Nothing else, not even "just a helper". If a task seems to need another package, stop and tell the user what and why.

Check first, install only on failure, into the scratch folder (never the project):

```bash
node -e "const r=require('node:module').createRequire('<tmp>/harness-doc-tools/');r('pdf-lib');r('unpdf')" 2>/dev/null \
  || npm install --prefix "<tmp>/harness-doc-tools" --ignore-scripts --no-audit --no-fund pdf-lib@1.17.1 unpdf@1.8.1
```

Load with `createRequire("<tmp>/harness-doc-tools/")`. unpdf is ESM-only: `await import(require("node:url").pathToFileURL(req.resolve("unpdf")).href)`.

## Create: HTML to PDF

1. Write `<name>.html` with the **Write tool**, UTF-8. Never build the file through a PowerShell here-string or `echo`: Windows PowerShell saves it in the ANSI code page and every `—`, `•`, `’` turns into `â€”`, `â€¢`, `â€™`.
2. Start with `<!doctype html><meta charset="utf-8">`. Fonts: `font-family: "Segoe UI", Arial, Helvetica, sans-serif` (all present on Windows/macOS). No web fonts, no CDN, no remote images (use local files or `data:` URIs).
3. Page setup in CSS, not in the browser flags:

```css
@page { size: A4; margin: 18mm 16mm 20mm; @bottom-right { content: counter(page) " / " counter(pages); font: 9pt Arial; color: #667 } }
body { font: 10.5pt/1.5 "Segoe UI", Arial, sans-serif; color: #1b2430 }
h1,h2,h3 { break-after: avoid }
table { width: 100%; border-collapse: collapse } tr, figure, .card { break-inside: avoid }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #d8dee6; vertical-align: top }
```

4. Layout rules that prevent the usual defects:
   - Use real elements (`<table>`, `<ul>`, `<h2>`), not absolutely positioned boxes. No `position: absolute/fixed` for content, no big decorative circles or bands; a thin top rule or a colour on the heading is enough.
   - A label/value list is a two-column `<table>` or `<dl>` with `width` set on the first column; long values wrap inside their cell.
   - Tinted callouts are a `<div>` with padding and a left border, so the box grows with its text.
   - Do not force page breaks with fixed heights; use `break-before: page` only for a real new section.
5. Print (command differs per OS; try them in this order and use the first that exists):

```
macOS   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   or  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
Windows C:\Program Files\Google\Chrome\Application\chrome.exe   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
Linux   google-chrome   chromium   chromium-browser   microsoft-edge
```

```bash
"<browser>" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="<tmp>/pdf-profile" \
  --print-to-pdf="<out>.pdf" "file:///<abs path>/<name>.html"
```

   On Windows the URL is `file:///C:/Users/...` with forward slashes. If no browser is found, say so; the fallback is the `docx` skill and a `.docx` the user converts, not hand-drawn `pdf-lib`.

## Read

`extractText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: false })` gives `{ totalPages, text: [page1, ...] }`. A PDF with no text layer is a scan: say so; OCR only if `tesseract` is already installed.

## Merge, split, fill (`pdf-lib`)

Merge: new document, `copyPages(src, src.getPageIndices())`, `addPage`. Split: copy only the wanted indices. Rotate: `page.setRotation(degrees(90))`. Fill: `form.getTextField(n).setText(v)`; `form.flatten()` only if the user wants it locked. Encrypted PDFs can't be opened: ask for an unprotected copy. Write `name.merged.pdf` etc.; never overwrite the original unasked.

## Check before you say it is done

1. Page count is sensible; no page holds only a line or two (unless it is the last and short on purpose).
2. Text of every page via unpdf: no `â€`, `â†`, `Ã`, `�`, and no placeholder like `TODO`, `lorem`, `[insert`.
3. **Look at the pages.** If `pdftoppm` exists: `pdftoppm -png -r 80 out.pdf <tmp>/page`, then open the PNGs with the image Read tool. Otherwise open the PDF with Read (`pages: "1-4"`). Look for overlapping text, clipped table cells, shapes over text, empty pages. Fix the HTML and print again; do not report success from the text check alone.
4. If you could not look at the pages, say that in the answer.
