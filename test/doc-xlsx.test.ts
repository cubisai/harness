import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers";

const script = resolve(process.cwd(), "resources/skills/xlsx/scripts/sheet.mjs");
const ExcelJS = createRequire(join(process.cwd(), "noop.js"))("exceljs");

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, CUBIQ_DOC_TOOLS: process.cwd() },
  });
}

type Row = (string | number | boolean | null)[];

function singleSheet(rows: Row[], columns: { header: string; format?: string }[]): unknown {
  return { sheets: [{ name: "Sheet1", columns, rows }] };
}

function writeInput(dir: string, value: unknown): string {
  const file = join(dir, "input.json");
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

async function open(path: string): Promise<any> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

describe("xlsx sheet builder", () => {
  it("init writes a sample that builds with correct cached totals", async () => {
    const dir = tempDir();
    const input = join(dir, "sheet.json");
    const output = join(dir, "book.xlsx");

    const init = run("init", input);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("OK:");

    const data = JSON.parse(readFileSync(input, "utf8"));
    const build = run("build", input, output);
    expect(build.status).toBe(0);
    expect(build.stdout).toMatch(/^OK: book\.xlsx — 2 sheets, \d+ formulas/m);

    const wb = await open(output);
    const budget = data.sheets.find((sheet: any) => sheet.name === "Budget");
    const plannedCol = budget.columns.findIndex((col: any) => col.header === "Planned");
    const actualCol = budget.columns.findIndex((col: any) => col.header === "Actual");
    const totalOf = (rows: Row[], col: number) =>
      rows.reduce((total, row) => {
        const value = row[col];
        return total + (typeof value === "number" ? value : 0);
      }, 0);
    const planned = totalOf(budget.rows.slice(0, 4), plannedCol);
    const actual = totalOf(budget.rows.slice(0, 4), actualCol);

    const plannedCell = wb.getWorksheet("Budget").getCell("B6");
    expect(plannedCell.formula).toBe("SUM(B2:B5)");
    expect(plannedCell.result).toBe(planned);

    const actualCell = wb.getWorksheet("Budget").getCell("C6");
    expect(actualCell.result).toBe(actual);

    const summary = wb.getWorksheet("Summary");
    expect(summary.getCell("B2").result).toBe(planned);
    expect(summary.getCell("B3").result).toBe(actual);
    expect(summary.getCell("B4").result).toBeCloseTo((actual - planned) / planned, 3);
  });

  it("rejects unsupported functions and names the cell", () => {
    const dir = tempDir();
    const input = writeInput(
      dir,
      singleSheet(
        [
          [1, 2],
          [3, "=XLOOKUP(A2,B2:B3,B2:B3)"],
        ],
        [{ header: "Item" }, { header: "Value" }],
      ),
    );

    const result = run("build", input, join(dir, "bad.xlsx"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Sheet1!B3");
    expect(result.stderr).toContain("XLOOKUP");
  });

  it("detects a circular reference", () => {
    const dir = tempDir();
    const input = writeInput(
      dir,
      singleSheet([["=B2", "=A2"]], [{ header: "Left" }, { header: "Right" }]),
    );

    const result = run("build", input, join(dir, "cycle.xlsx"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("circular");
    expect(result.stderr).toContain("Sheet1!A2");
  });

  it("writes #DIV/0! so check fails, while IFERROR builds", async () => {
    const badDir = tempDir();
    const badInput = writeInput(badDir, singleSheet([["=1/0"]], [{ header: "Number" }]));
    const badOutput = join(badDir, "bad.xlsx");

    const build = run("build", badInput, badOutput);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain("#DIV/0!");

    const check = run("check", badOutput);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("#DIV/0!");

    const goodDir = tempDir();
    const goodInput = writeInput(goodDir, singleSheet([["=IFERROR(1/0,0)"]], [{ header: "Number" }]));
    const goodOutput = join(goodDir, "good.xlsx");

    const good = run("build", goodInput, goodOutput);
    expect(good.status).toBe(0);
    const wb = await open(goodOutput);
    expect(wb.getWorksheet("Sheet1").getCell("A2").result).toBe(0);
  });

  it("resolves cross-sheet references", async () => {
    const dir = tempDir();
    const input = writeInput(dir, {
      sheets: [
        { name: "First", columns: [{ header: "N" }], rows: [[10], [20]] },
        { name: "Second", columns: [{ header: "Total" }], rows: [["=SUM(First!A2:A3)"]] },
      ],
    });
    const output = join(dir, "cross.xlsx");

    const result = run("build", input, output);
    expect(result.status).toBe(0);
    const wb = await open(output);
    expect(wb.getWorksheet("Second").getCell("A2").result).toBe(30);
  });

  it("rejects sheet names Excel cannot use", () => {
    const dir = tempDir();
    const input = writeInput(dir, {
      sheets: [{ name: "Q1/Q2", columns: [{ header: "N" }], rows: [[1]] }],
    });

    const result = run("build", input, join(dir, "bad-name.xlsx"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sheet name");
    expect(result.stderr).toContain("Q1/Q2");
  });

  it("check reports a formula without a cached result", async () => {
    const dir = tempDir();
    const file = join(dir, "raw.xlsx");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getCell("A1").value = "N";
    ws.getCell("A2").value = { formula: "1+1" };
    ws.getColumn(1).width = 10;
    await wb.xlsx.writeFile(file);

    const result = run("check", file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A2 has no cached result");
  });
});
