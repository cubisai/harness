import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/renderer/src/markdown";
import { cellNumber, chartColumn, tableCsv } from "../src/renderer/src/genui/SmartTable";
import { useStore } from "../src/renderer/src/store";

/** Markup of one reply through the renderer under test. */
const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

/** A GFM table with the given body rows; both columns are text unless the row says otherwise. */
const grid = (body: string[]): string => ["| name | score |", "| --- | --- |", ...body].join("\n");
const scoreRows = (n: number): string[] => Array.from({ length: n }, (_, i) => `| r${i} | ${i} |`);

// Server rendering reads zustand's initial state (see composer.test.tsx), so seed that too;
// setState keeps the live state consistent for anything that reads it.
const setUiBlocks = (on: boolean): void => {
  (useStore.getInitialState() as { settings: unknown }).settings = on ? { uiBlocks: true } : null;
  useStore.setState({ settings: (on ? { uiBlocks: true } : null) as never });
};

beforeEach(() => setUiBlocks(true));
afterEach(() => setUiBlocks(false));

describe("cellNumber", () => {
  it("reads plain, grouped, signed, currency and percent cells", () => {
    expect(cellNumber("1,200")).toBe(1200);
    expect(cellNumber("$3.5")).toBe(3.5);
    expect(cellNumber("-4")).toBe(-4);
    expect(cellNumber("12%")).toBe(12);
  });

  it("strips emphasis and code markers first", () => {
    expect(cellNumber("**1,200**")).toBe(1200);
    expect(cellNumber("`-4`")).toBe(-4);
    expect(cellNumber(" €2,000.50 ")).toBe(2000.5);
  });

  it("returns null for text, empty and malformed cells", () => {
    expect(cellNumber("abc")).toBeNull();
    expect(cellNumber("")).toBeNull();
    expect(cellNumber("1,20")).toBeNull();
    expect(cellNumber("**bold**")).toBeNull();
  });
});

describe("tableCsv", () => {
  it("quotes fields with a comma, a quote or a newline, doubling inner quotes", () => {
    expect(tableCsv(["a", "b,c"], [['He said "hi"', "x\ny"]])).toBe('a,"b,c"\n"He said ""hi""","x\ny"');
  });

  it("puts the header first and joins the lines with \n", () => {
    expect(tableCsv(["a", "b"], [["1", "2"], ["3", "4"]])).toBe("a,b\n1,2\n3,4");
  });
});

describe("chartColumn", () => {
  it("picks the first numeric column after the labels", () => {
    expect(chartColumn([["a", "1"], ["b", "2"]])).toBe(1);
    expect(chartColumn([["a", "x", "5"], ["b", "y", "6"]])).toBe(2);
  });

  it("returns null for a negative column, text columns or a single row", () => {
    expect(chartColumn([["a", "-1"], ["b", "-2"]])).toBeNull();
    expect(chartColumn([["a", "x"], ["b", "y"]])).toBeNull();
    expect(chartColumn([["a", "1"]])).toBeNull();
  });
});

describe("smart tables and tasks (uiBlocks on)", () => {
  it("renders a GFM table as a smart table with sortable headers", () => {
    const html = render(grid(["| a | 1 |", "| b | 2 |"]));
    expect(html).toContain('class="smart-table"');
    expect(html).toContain('class="smart-th"');
    expect(html).toContain("<td>a</td>");
  });

  it("shows the Chart toggle only when a column is numeric", () => {
    expect(render(grid(["| a | 1 |", "| b | 2 |"]))).toContain(">Chart</button>");
    expect(render(grid(["| a | x |", "| b | y |"]))).not.toContain(">Chart</button>");
  });

  it("shows the filter only past eight rows", () => {
    expect(render(grid(scoreRows(8)))).not.toContain("smart-table-filter");
    expect(render(grid(scoreRows(9)))).toContain('class="smart-table-filter"');
  });

  it("renders - [x] / - [ ] items as task rows, one checked", () => {
    const html = render("- [x] a\n- [ ] b");
    expect(html.match(/class="ui-check md-task"/g) ?? []).toHaveLength(2);
    expect(html.match(/\bchecked\b/g) ?? []).toHaveLength(1);
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('aria-label="Not done"');
    expect(html).toContain("<span>a</span>");
    expect(html).toContain("<span>b</span>");
  });
});

describe("uiBlocks off", () => {
  it("renders the same inputs as today's plain markdown", () => {
    setUiBlocks(false);
    const table = render(grid(["| a | 1 |", "| b | 2 |"]));
    expect(table).not.toContain("smart-table");
    expect(table).toContain("<table>");
    const tasks = render("- [x] a\n- [ ] b");
    expect(tasks).not.toContain("md-task");
    expect(tasks).toContain("<li>[x] a</li>");
  });
});
