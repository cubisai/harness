---
name: xlsx
description: Create, read or edit Excel workbooks (.xlsx, .csv). Write JSON tables and formulas; CubiQ's document_build makes a tidy, checked .xlsx. Use for any spreadsheet.
---

# Excel workbooks (.xlsx)

You write the tables as JSON. The builder styles the header, freezes it, adds filters, sets number formats and column widths, and computes every formula's value, so the file shows numbers in any viewer.

## Make one

1. `document_template` with `format: "xlsx"` and `path: "budget.json"`: writes a two-sheet example with totals and a cross-sheet summary.
2. Replace the example's content with the real data. Keep the JSON shape:
   - `sheets: [{ name, columns: [{ header, format, width }], rows: [[...]] }]`;
   - `format` is text, integer, decimal, currency, percent or date (`YYYY-MM-DD`);
   - the header is row 1, so the first data row is row 2;
   - a string starting with `=` is a formula.
   Formulas can use `+ - * / ^ &`, comparisons, `A1`, `$A$1`, `A2:A9` and `'Other sheet'!B4`, plus SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, AND, OR, NOT, IFERROR and CONCAT. Nothing else: no XLOOKUP, FILTER, pivots or macros.
3. `document_build` with `input: "budget.json"`, which writes `budget.xlsx`.
4. If it returns ERROR lines ("Sheet1!C5: unsupported function"), fix exactly that and build again. It's done only when it says `OK:`.
5. Check two or three key totals against the source data yourself, and tell the user the figures.

No `document_build` tool? Run the same builder yourself: `node "<this skill's folder>/scripts/sheet.mjs" init budget.json`, then `build budget.json budget.xlsx`.

## Read

With `exceljs@4.4.0`: `const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);`, then for each of `wb.worksheets` read `ws.name`, `ws.rowCount` and `ws.eachRow((row, n) => row.values)`.
- A cell can be `{ formula, result }` (report `result`), `{ richText }`, `{ hyperlink, text }` or `{ error }`.
- CSV: `wb.csv.readFile(path)`.
Before changing anything, tell the user what you found: sheet names, the header row, the row count, and anything odd (merged headers, blank rows, numbers stored as text).

## Edit an existing file

Read it as above, write the result as JSON and build it again. exceljs drops charts, pivot tables and macros on save: tell the user first if the file has them. Write `name.edited.xlsx` unless asked to replace it. Then `document_check` on the result.

CSV output: write it UTF-8 with a BOM (`﻿` first), so Excel on Windows shows accents correctly.
