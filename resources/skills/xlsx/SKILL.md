---
name: xlsx
description: Read, create or edit spreadsheets (.xlsx, .csv) - pull data out of a sheet, build a workbook with formatted tables, formulas and several sheets, clean up messy tabular data, or convert between CSV and Excel. Use whenever a spreadsheet file is the input or output.
---

# Spreadsheets (.xlsx, .csv)

## Packages: only this one, only if missing

Allowed: `exceljs@4.4.0`. Nothing else (no `xlsx`/SheetJS from npm, it is unmaintained there; no pandas). If a task seems to need another package, stop and tell the user what and why.

```bash
node -e "require('node:module').createRequire('<tmp>/harness-doc-tools/')('exceljs')" 2>/dev/null \
  || npm install --prefix "<tmp>/harness-doc-tools" --ignore-scripts --no-audit --no-fund exceljs@4.4.0
```

Load with `createRequire("<tmp>/harness-doc-tools/")`. Write scripts with the **Write tool** (UTF-8), in the scratch folder, not through a PowerShell here-string.

## Read

`const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);` then each `wb.worksheets`: `ws.name`, `ws.rowCount`, `ws.eachRow((row, n) => row.values)`. A cell value can be `{ formula, result }` (report `result`), `{ richText }`, `{ hyperlink, text }` or `{ error }`. CSV: `wb.csv.readFile(path)`.

Before changing anything tell the user what you found: sheet names, header row, row count, and anything odd (merged header cells, blank rows, numbers stored as text, hidden sheets).

## Create or edit

- Header row: bold, filled, frozen (`ws.views = [{ state: "frozen", ySplit: 1 }]`), `autoFilter` on it. Column widths from the longest value (cap 60), `alignment: { wrapText: true, vertical: "top" }` for long text.
- Numbers stay numbers, dates stay `Date` objects; format with `numFmt` (`"#,##0.00"`, `"yyyy-mm-dd"`, `"0.0%"`). Percentages are fractions (`0.15`, not `15`).
- Formulas keep the sheet live: `{ formula: "SUM(B2:B20)", result: 1234.5 }`. exceljs does not calculate, so **always pass `result`** (compute it in the script); otherwise a viewer that does not recalculate shows an empty cell.
- Formula names: stick to Excel 2007-era functions (`SUMIFS`, `INDEX`/`MATCH`, `IFERROR`, `SUMPRODUCT`). Newer ones need the prefix (`_xlfn.TEXTJOIN`, `_xlfn.IFS`, `_xlfn.MAXIFS`). Do not use `XLOOKUP`, `FILTER`, `SORT`, `UNIQUE`, `SEQUENCE`: sort and filter in the script. Quote sheet names with spaces (`'Q1 Sales'!B2`).
- Cross-check: no `=B5*1.05`; put the assumption in its own labelled cell and reference it.
- Do not put a formula in a cell that holds an input; mark inputs (blue font) and keep a short legend if the user will fill it in.
- Editing a user's workbook: change only the cells asked for, keep their conventions, write `name.edited.xlsx` unless in-place was asked. exceljs can drop charts, pivot tables, images in shapes and macros on save: if the file has them, say so first, or edit another way (copy rows into a new file).
- CSV out: write it yourself as UTF-8 **with a BOM** (`"﻿" + text`) so Excel on Windows shows accents and `—` correctly; quote fields containing commas, quotes or newlines.
- Large data (over ~100k rows): use `ExcelJS.stream.xlsx.WorkbookWriter`.

## Check before you say it is done

1. Re-open the file and print the header row and the first rows of each sheet.
2. Scan every cell: no `{ error }` values (`#REF!`, `#NAME?`, `#DIV/0!`), every formula cell has a `result`.
3. Recompute two or three totals independently in the script and compare them with the formula results.
4. Column widths: no `####` for long numbers or dates (widen to at least 12).
5. If a recalculating engine is already installed (`soffice --headless --convert-to xlsx --outdir <tmp> file.xlsx`) you may re-open its output to confirm formulas evaluate; otherwise say formulas were not recalculated by a spreadsheet program.
