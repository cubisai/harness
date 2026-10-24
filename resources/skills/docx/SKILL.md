---
name: docx
description: Create, read or edit Word documents (.docx). Write Markdown; CubiQ's document_build turns it into a styled, checked .docx. Use for any Word or .docx request.
---

# Word documents (.docx)

You write the content as Markdown. The builder owns fonts, spacing, numbering, tables, page size and page numbers, and checks the result. Don't style anything by hand.

## Make one

1. `document_template` with `format: "docx"` and `path: "report.md"`: writes an example that shows every feature.
2. Replace the example's content with the real content, using your file edit tools. Keep the front matter (`title`, `paper`: A4 or Letter, `theme`: clean, navy or warm, `header`) and use only the shapes the example shows:
   - `#`/`##`/`###` headings and plain paragraphs;
   - `**bold**`, `*italic*`, `` `code` ``, `[text](url)`;
   - `- ` bullets (indent 2 spaces to nest) and `1. ` numbered lists;
   - pipe tables (`| a | b |` then `|---|---|`);
   - `> ` callouts, `---` rules, `<!-- pagebreak -->`;
   - `![alt](picture.png)` for a PNG or JPG next to the Markdown file.
3. `document_build` with `input: "report.md"`, which writes `report.docx`.
4. If it returns ERROR lines, fix exactly what they name and build again. It's done only when it says `OK:`.
5. Tell the user the file's name and that it opens in Word, Pages or Google Docs.

No `document_build` tool? Run the same builder yourself: `node "<this skill's folder>/scripts/docx.mjs" init report.md`, then `build report.md report.docx` (it installs its own packages the first time).

## Read

- Text: `mammoth.extractRawText({ path })`, then `.value`. Structure: `mammoth.convertToHtml({ path })`.
- Comments, tracked changes or exact formatting: open it with `jszip` and read `word/document.xml` and `word/comments.xml`.
- Packages, when you need them: only `mammoth@1.13.0` and `jszip@3.10.2`, installed into a scratch folder, never the project.

## Edit an existing file

- Small text changes: edit `word/document.xml` with `jszip` and zip it again. Text is split across `<w:r>` runs, so match a paragraph's joined text, not raw XML. Write `name.edited.docx` unless asked to replace it.
- Bigger changes: read it with mammoth, rewrite it as Markdown and build it as above. Tell the user what didn't carry over (anything beyond headings, lists, tables and images).
- Then `document_check` on the result.
