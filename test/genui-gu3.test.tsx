// GU3: big tables page, charts never mix units, a stat's change is judged only when the block says which way is good.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chartColumn, PAGE_ROWS, SmartTable } from "../src/renderer/src/genui/SmartTable";
import { verdict } from "../src/renderer/src/genui/components/Stat";
import { validateUi } from "../src/shared/genui/validate";
import { Markdown } from "../src/renderer/src/markdown";

const table = (n: number): string =>
  renderToStaticMarkup(<SmartTable header={["Row", "N"]} align={[null, "right"]} rows={Array.from({ length: n }, (_, i) => [`r${i + 1}`, String(i)])} renderCell={(c) => c} />).replace(/<!-- -->/g, "");

describe("table pager", () => {
  it("shows every row up to a page, with no pager", () => {
    const html = table(PAGE_ROWS);
    expect(html.match(/<tr>/g)?.length).toBe(PAGE_ROWS + 1);
    expect(html).not.toContain("smart-table-pager");
  });

  it("pages past it: the first page and where it is", () => {
    const html = table(PAGE_ROWS + 1);
    expect(html.match(/<tr>/g)?.length).toBe(PAGE_ROWS + 1);
    expect(html).toContain("r50");
    expect(html).not.toContain(">r51<");
    expect(html).toContain("1–50 of 51");
    expect(html).toMatch(/<button type="button" class="code-copy" disabled="">Previous<\/button>/);
  });

  it("aligns body cells with their column", () => {
    expect(table(2)).toContain('<td style="text-align:right">1</td>');
  });
});

describe("charts never mix units", () => {
  it("refuses a column mixing currencies, or % with plain numbers", () => {
    expect(chartColumn([["a", "$10"], ["b", "€12"]])).toBeNull();
    expect(chartColumn([["a", "10%"], ["b", "12"]])).toBeNull();
    expect(chartColumn([["a", "$10"], ["b", "$1,200"]])).toBe(1);
    expect(chartColumn([["a", "10%"], ["b", "**12%**"]])).toBe(1);
  });

  it("keeps a bar's exact value in its title", () => {
    const html = renderToStaticMarkup(<Markdown text={"```ui:chart\nA|1.23456\nB|2\n```"} />);
    expect(html).toContain('title="1.23456"');
  });
});

describe("stat better-when", () => {
  it("judges a change only when told which way is good", () => {
    expect(verdict("+3%", undefined)).toBeNull();
    expect(verdict("+3%", "up")).toBe("good");
    expect(verdict("+3%", "down")).toBe("bad");
    expect(verdict("↓2", "down")).toBe("good");
    expect(verdict("flat", "up")).toBeNull();
  });

  it("reads better from JSON and from a 4th line field", () => {
    expect(validateUi("stat", JSON.stringify({ stats: [{ label: "Errors", value: "4", delta: "-2", better: "down" }] }))).toEqual({ name: "stat", stats: [{ label: "Errors", value: "4", delta: "-2", better: "down" }] });
    expect(validateUi("stat", "Churn | 2% | +0.3pt | lower is better")).toEqual({ name: "stat", stats: [{ label: "Churn", value: "2%", delta: "+0.3pt", better: "down" }] });
    expect(validateUi("stat", "Users | 12k | +8%")).toEqual({ name: "stat", stats: [{ label: "Users", value: "12k", delta: "+8%" }] });
  });
});
