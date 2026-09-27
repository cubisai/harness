---
name: xlsx
description: Read, create or edit spreadsheets (.xlsx, .csv) - pull data out of a sheet, build a workbook with formatted tables, formulas and several sheets, clean up messy tabular data, or convert between CSV and Excel. Use whenever a spreadsheet file is the input or the output.
---

# Spreadsheets (.xlsx, .csv)

Use `exceljs`, installed once into a scratch folder so the user's project isn't touched:

```bash
npm install --prefix "<tmp>/harness-doc-tools" exceljs
```

Load it with `createRequire("<tmp>/harness-doc-tools/")` (`node:module`).

## Read

`const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);` then for each `wb.worksheets`: `ws.name`, `ws.rowCount`, and `ws.eachRow((row, n) => row.values)`. A cell's `.value` can be a formula object `{ formula, result }`: report the `result`, and mention the formula when it matters. CSV: `wb.csv.readFile(path)`.

Before changing anything, tell the user what you found: sheet names, header row, row count, and anything odd (merged header cells, blank rows, numbers stored as text).

## Create or edit

- Header row bold with a fill, frozen (`ws.views = [{ state: "frozen", ySplit: 1 }]`), column widths set to fit the content, `autoFilter` on the header.
- Keep numbers as numbers and dates as dates; set `numFmt` (`"#,##0.00"`, `"yyyy-mm-dd"`, `"0%"`) instead of writing formatted strings.
- Use formulas for totals and derived columns (`{ formula: "SUM(B2:B20)" }`) so the sheet stays live. exceljs does not calculate them: if you need the value in your answer, compute it in the script too.
- Editing a user's workbook: change only the cells you were asked to, and write `name.edited.xlsx` unless they asked for in-place. Formatting and charts exceljs doesn't understand can be lost on save; say so if the file has charts or pivot tables.

## Check your output

Re-open the file you wrote and print the header row and the first few rows of each sheet.
