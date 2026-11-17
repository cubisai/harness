// GU2: run_code scripts show tables and stats from their own data (`show()`),
// carried as a versioned `widget` event and re-checked before it is drawn.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { createCodeServer } from "../src/main/code-mode";
import type { LoopTool } from "../src/main/harness/loop";
import { createCodeTool, SHOW_NOTE, type ShownWidget } from "../src/main/harness/tools/code";
import { createCodeBroker } from "../src/main/harness/tools/code-broker";
import { readEnvelope, scriptEnvelope, TABLE_ROWS_MAX, validateTable, validateWidget, widgetSummary, type TableSpec } from "../src/shared/genui/widget";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";
import { formatCell, WidgetView } from "../src/renderer/src/genui/WidgetView";
import { tableCsv, tableHtml, tableTsv } from "../src/renderer/src/genui/SmartTable";
import { segmentEvents } from "../src/renderer/src/turns";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "genui-gu2-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const html = (node: React.ReactElement): string => renderToStaticMarkup(node).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");

describe("validateTable", () => {
  it("takes columns from the first object row and types a column of numbers", () => {
    const v = validateTable({ title: "Files", rows: [{ path: "a.ts", lines: 120 }, { path: "b.ts", lines: 4 }] });
    if (!v.spec || v.spec.name !== "table") throw new Error("expected a table");
    expect(v.spec.columns).toEqual([
      { key: "path", label: "path", type: "text" },
      { key: "lines", label: "lines", type: "number" },
    ]);
    expect(v.spec.rows).toEqual([["a.ts", 120], ["b.ts", 4]]);
    expect(v.notes).toEqual([]);
  });

  it("keeps declared types and units, fills missing cells with null, shows nested values as JSON", () => {
    const v = validateTable({ columns: ["name", { key: "cost", label: "Cost", type: "currency", unit: "USD" }], rows: [{ name: "x", cost: 1.005 }, { name: { a: 1 } }] });
    if (!v.spec || v.spec.name !== "table") throw new Error("expected a table");
    expect(v.spec.columns[1]).toEqual({ key: "cost", label: "Cost", type: "currency", unit: "USD" });
    expect(v.spec.rows).toEqual([["x", 1.005], ['{"a":1}', null]]);
    expect(v.notes).toEqual(["1 nested value shown as JSON"]);
  });

  it("reads numeric strings in a number column as numbers, and a number column holding text as text", () => {
    const ok = validateTable({ columns: ["f", { key: "n", type: "number" }], rows: [{ f: "a", n: "12" }, { f: "b", n: -3.5 }] });
    expect(ok.spec && ok.spec.name === "table" ? ok.spec.rows : null).toEqual([["a", 12], ["b", -3.5]]);
    const text = validateTable({ columns: ["f", { key: "n", type: "number" }], rows: [{ f: "a", n: "error: Read failed" }] });
    if (!text.spec || text.spec.name !== "table") throw new Error("expected a table");
    expect(text.spec.columns[1]!.type).toBe("text");
    expect(text.notes).toEqual(["1 number column shown as text (it holds text)"]);
  });

  it("names why it refuses", () => {
    const refuse = (props: Record<string, unknown>): string => {
      const v = validateTable(props);
      if (v.spec) throw new Error("expected a refusal");
      return v.reason;
    };
    expect(refuse({})).toBe("no rows");
    expect(refuse({ rows: [] })).toBe("rows is empty");
    expect(refuse({ rows: Array.from({ length: TABLE_ROWS_MAX + 1 }, (_, i) => ({ i })) })).toContain(`max ${TABLE_ROWS_MAX}`);
    expect(refuse({ rows: [{ a: 1 }], columns: ["a", "a"] })).toBe('column "a" is listed twice');
    expect(refuse({ rows: [{ a: 1 }], columns: [{ key: "a", type: "money" }] })).toContain("unknown type");
    expect(refuse({ rows: [{ a: "x".repeat(400) }, ...Array.from({ length: 1999 }, () => ({ a: "x".repeat(400) }))] })).toContain("KB");
  });
});

describe("validateWidget / readEnvelope", () => {
  it("accepts the read-only catalog kinds and refuses taps and forms", () => {
    expect(validateWidget("stat", { stats: [{ label: "Files", value: "12" }] }).spec?.name).toBe("stat");
    expect(validateWidget("choices", { options: ["a", "b"] }).spec).toBeNull();
    expect(validateWidget("form", { fields: [{ id: "a" }] }).spec).toBeNull();
  });

  it("re-checks a stored envelope: a newer version or a tampered spec isn't drawn", () => {
    const spec = validateTable({ rows: [{ a: 1 }] }).spec!;
    const env = scriptEnvelope(spec, "tool-1", 0, true, 5);
    expect(env).toEqual({ schemaVersion: 1, widgetId: "tool-1:w1", ownerId: "tool-1", revision: 1, provenance: { kind: "computed", tool: "run_code", observedAt: 5, complete: true }, spec });
    expect(readEnvelope(env).envelope).not.toBeNull();
    expect(readEnvelope({ ...env, schemaVersion: 2 })).toEqual({ envelope: null, reason: "it was made by a newer CubiQ" });
    expect(readEnvelope({ ...env, spec: { name: "table", rows: "nope" } }).envelope).toBeNull();
    expect(readEnvelope({ ...env, spec: { name: "choices", options: ["a", "b"] } }).envelope).toBeNull();
  });

  it("summarises what was shown for the model", () => {
    expect(widgetSummary(validateTable({ title: "Top", rows: [{ a: 1 }, { a: 2 }] }).spec!)).toBe('table "Top", 2 rows');
    expect(widgetSummary(validateWidget("stat", { stats: [{ label: "x", value: "1" }] }).spec!)).toBe("stat, 1 tile");
  });
});

const tool = (name: string): LoopTool => ({
  definition: { name, description: name, parameters: { type: "object", properties: {} } },
  displayName: name,
  access: "read",
  summarize: () => name,
  run: async () => ({ text: `${name} ok` }),
});
const runCode = (t: LoopTool, code: string) => t.run({ code }, { id: "call-9", signal: new AbortController().signal, onOutput: () => {} });

describe("run_code show()", () => {
  const sandbox = (shown: { widgets: ShownWidget[]; callId: string }[] | null) =>
    createCodeTool({
      tools: () => [tool("read")],
      broker: createCodeBroker({ tools: () => [tool("read")], emit: () => {}, outputDir: tmp() }),
      outputDir: tmp(),
      ...(shown ? { show: (widgets: ShownWidget[], callId: string) => void shown.push({ widgets, callId }) } : {}),
    });

  it("draws what a successful script showed and tells the model not to retype it", async () => {
    const calls: { widgets: ShownWidget[]; callId: string }[] = [];
    const r = await runCode(sandbox(calls), 'show("table", { title: "Sizes", rows: [{ f: "a", n: 1 }, { f: "b", n: 2 }], complete: false }); return "done";');
    expect(r.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.callId).toBe("call-9");
    expect(calls[0]!.widgets[0]!.complete).toBe(false);
    expect((calls[0]!.widgets[0]!.spec as TableSpec).rows).toEqual([["a", 1], ["b", 2]]);
    expect(r.text).toContain('Shown to the user: table "Sizes", 2 rows (partial)');
  });

  it("throws the reason into the script for a bad widget, and shows nothing from a failed script", async () => {
    const calls: { widgets: ShownWidget[]; callId: string }[] = [];
    const bad = await runCode(sandbox(calls), 'show("table", { rows: [] });');
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('show("table"): rows is empty.');
    const failed = await runCode(sandbox(calls), 'show("stat", { stats: [{ label: "a", value: "1" }] }); throw new Error("later");');
    expect(failed.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("caps widgets per script", async () => {
    const calls: { widgets: ShownWidget[]; callId: string }[] = [];
    const r = await runCode(sandbox(calls), 'for (let i = 0; i < 5; i++) show("stat", { stats: [{ label: "a", value: String(i) }] });');
    expect(r.isError).toBe(true);
    expect(r.text).toContain("at most 4 widgets");
  });

  it("has no show, and no show sentence, when inline UI is off", async () => {
    const off = sandbox(null);
    expect(off.definition.description).not.toContain("show(kind");
    expect((await runCode(off, "return typeof show")).text).toContain("=> undefined");
    expect(sandbox([]).definition.description).toContain(SHOW_NOTE);
  });

  it("the MCP code server emits the widget under the agent's run_code row", async () => {
    const events: ThreadEvent[] = [];
    const dir = tmp();
    const server = (uiBlocks: boolean) =>
      createCodeServer({
        cwdOf: () => dir,
        projectOf: () => undefined,
        appTools: () => [],
        parentOf: () => "engine-row-3",
        emit: (_id, e) => events.push(e),
        outputDir: tmp(),
        guardScript: "builtin",
        parentWaitMs: 0,
        uiBlocks: () => uiBlocks,
      });
    const on = server(true);
    expect(on.tool("t").description).toContain(SHOW_NOTE);
    const r = await on.tool("t").run({ code: 'show("stat", { stats: [{ label: "Files", value: "12" }] }); return 1' } as never, undefined);
    expect(r.text).toContain("Shown to the user: stat, 1 tile");
    const widget = events.find((e) => e.kind === "widget");
    expect(widget && widget.kind === "widget" ? widget.envelope.ownerId : null).toBe("engine-row-3");
    expect(server(false).tool("t").description).not.toContain(SHOW_NOTE);
  });
});

describe("copying a table", () => {
  it("copies tab-separated text (cells in a spreadsheet) and an HTML table, both formula-safe", () => {
    expect(tableTsv(["File", "Lines"], [["a\tb.ts", 12], ["=cmd", null]])).toBe("File\tLines\na b.ts\t12\n'=cmd\t");
    expect(tableHtml(["<b>"], [[1], ["x&y"]])).toBe('<table><thead><tr><th>&lt;b&gt;</th></tr></thead><tbody><tr><td style="text-align:right">1</td></tr><tr><td>x&amp;y</td></tr></tbody></table>');
  });
});

describe("drawing a widget", () => {
  const table = validateTable({ title: "Spend", columns: ["team", { key: "usd", label: "Spend", type: "currency", unit: "USD" }, { key: "ms", label: "Latency", type: "number", unit: "ms" }], rows: [{ team: "A", usd: 1234.5, ms: 12.25 }, { team: "B", usd: -3, ms: null }] }).spec as TableSpec;

  it("formats typed cells for the screen but keeps exact values for CSV", () => {
    expect(formatCell(1234.5, table.columns[1]!)).toMatch(/1,234\.5/);
    expect(formatCell(12.5, { key: "p", label: "p", type: "percent" })).toBe("12.5%");
    expect(formatCell(null, table.columns[2]!)).toBe("");
    expect(tableCsv(["team", "usd"], [["=cmd", -3.000001]])).toBe("team,usd\n'=cmd,-3.000001");
  });

  it("draws a table with its units, the source line and a partial mark", () => {
    const out = html(<WidgetView envelope={scriptEnvelope(table, "r1", 0, false)} />);
    expect(out).toContain('data-ui="table"');
    expect(out).toContain("Latency (ms)");
    expect(out).not.toContain("Spend (USD)");
    expect(out).toContain("From a script's data · 2 rows · partial");
    // Number columns align right in the body too, not only the header.
    expect(out).toContain('<td style="text-align:right">');
  });

  it("says why a widget it can't read isn't drawn", () => {
    expect(html(<WidgetView envelope={{ schemaVersion: 9 }} />)).toContain("Couldn't draw this widget: it was made by a newer CubiQ");
  });

  it("shows a widget between two work folds, not inside one", () => {
    const ev = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, threadId: "t", createdAt: seq, event }) as StoredEvent;
    const events = [
      ev(1, { kind: "user", text: "go" }),
      ev(2, { kind: "tool-use", toolUseId: "r1", name: "run_code", summary: "x" }),
      ev(3, { kind: "widget", envelope: scriptEnvelope(table, "r1", 0, true) }),
      ev(4, { kind: "tool-result", toolUseId: "r1", isError: false, summary: "ok" }),
      ev(5, { kind: "tool-use", toolUseId: "r2", name: "Read", summary: "a" }),
      ev(6, { kind: "tool-result", toolUseId: "r2", isError: false, summary: "ok" }),
      ev(7, { kind: "assistant-text", text: "done" }),
    ];
    const kinds = segmentEvents(events, false).map((s) => (s.kind === "event" ? s.stored.event.kind : s.kind));
    expect(kinds).toEqual(["user", "work", "widget", "work", "assistant-text"]);
  });
});
