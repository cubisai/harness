// P5.5b: browser_report — the assertion script, its descriptions, the report
// text, and the runner against a fake backend; plus one real headless run
// through agent-browser when the CLI is on PATH.

import { describe, expect, it } from "vitest";
import { AgentBrowserBackend, resolveAgentBrowser } from "../src/main/browser/agent-browser";
import { NO_LOGS, type BrowserBackend } from "../src/main/browser/backend";
import { assertionScript, describeAssertion, formatReport, runReport, type ReportResult } from "../src/main/browser/report";
import { browserTools } from "../src/main/browser/tools";
import { runs, tempDir } from "./helpers";

/** A backend whose query answers the URL expression and the assertion script from a table. */
function fakeBackend(answers: { url?: unknown; checks?: unknown; logs?: string; shot?: string }, kind: "visible" | "headless" = "headless"): BrowserBackend {
  return {
    kind,
    ensureOpen: async () => {},
    open: async () => "",
    snapshot: async () => "",
    click: async () => "",
    type: async () => "",
    evaluate: async () => "",
    query: async (expression) => (expression === "location.href" ? answers.url : answers.checks),
    logs: async () => answers.logs ?? NO_LOGS,
    screenshot: async () => ({ path: answers.shot ?? "/tmp/shot.png", png: Buffer.from("") }),
  };
}

describe("assertionScript", () => {
  it("builds one script with user strings JSON-escaped", () => {
    const script = assertionScript([{ text: 'say "hi"' }, { selector: "li.item", count: 2 }]);
    expect(script.startsWith("(")).toBe(true);
    expect(script).toContain('\\"hi\\"');
    expect(script).not.toContain('say "hi"');
    expect(script).toContain("li.item");
  });
});

describe("describeAssertion", () => {
  it("names each form, with a label prefix", () => {
    expect(describeAssertion({ text: "Saved" })).toBe('text "Saved"');
    expect(describeAssertion({ url: "/dash" })).toBe('URL contains "/dash"');
    expect(describeAssertion({ selector: "#total", value: "42" })).toBe('"#total" = "42"');
    expect(describeAssertion({ selector: "li.item", count: 3 })).toBe('"li.item" count 3');
    expect(describeAssertion({ selector: "#ok" })).toBe('"#ok" visible');
    expect(describeAssertion({ label: "Total", selector: "#total", value: "42" })).toBe('Total: "#total" = "42"');
  });
});

describe("formatReport", () => {
  const report: ReportResult = {
    url: "http://x/checkout",
    target: "visible pane",
    checks: [
      { assertion: { selector: "#total", value: "42" }, pass: true, actual: "42" },
      { assertion: { text: "Saved" }, pass: false, actual: "not found" },
    ],
    logs: NO_LOGS,
    screenshot: null,
  };

  it("lists each check with its outcome and the tally", () => {
    expect(formatReport(report)).toBe(
      [
        "Browser report",
        "Target: visible pane",
        "URL: http://x/checkout",
        "",
        'PASS  "#total" = "42"',
        'FAIL  text "Saved" — actual: not found',
        "",
        "Logs: none since the page loaded",
        "Result: 1 of 2 checks passed",
      ].join("\n"),
    );
    const titled = formatReport(report, "Checkout");
    expect(titled).toContain("Browser report: Checkout");
    expect(titled).not.toContain("Screenshot:");
  });

  it("shows ten log lines then counts the rest, and reports no checks", () => {
    const logs = Array.from({ length: 12 }, (_, i) => `[error] e${i}`).join("\n");
    const text = formatReport({ ...report, checks: [], logs, screenshot: "/tmp/s.png" });
    expect(text).toContain("[error] e0");
    expect(text).toContain("[error] e9");
    expect(text).not.toContain("[error] e10");
    expect(text).toContain("… 2 more");
    expect(text).toContain("Screenshot: /tmp/s.png");
    expect(text).toContain("Result: no checks given");
  });
});

describe("runReport", () => {
  it("collects the URL, each check's outcome, the logs, and a screenshot", async () => {
    const b = fakeBackend({
      url: "http://x/",
      checks: [
        { pass: true, actual: "42" },
        { pass: false, actual: "not found" },
      ],
      logs: NO_LOGS,
      shot: "/tmp/shot.png",
    });
    const r = await runReport(b, [{ selector: "#total", value: "42" }, { text: "Saved" }], { screenshot: true, target: "visible pane" });
    expect(r).toEqual({
      url: "http://x/",
      target: "visible pane",
      checks: [
        { assertion: { selector: "#total", value: "42" }, pass: true, actual: "42" },
        { assertion: { text: "Saved" }, pass: false, actual: "not found" },
      ],
      logs: NO_LOGS,
      screenshot: "/tmp/shot.png",
    });
  });

  it("fails every check when the page doesn't answer, and skips the screenshot", async () => {
    const b = fakeBackend({ url: "http://x/", checks: "nonsense" });
    const r = await runReport(b, [{ text: "Saved" }, { url: "/dash" }], { target: "headless session" });
    expect(r.checks).toEqual([
      { assertion: { text: "Saved" }, pass: false, actual: "page didn't answer" },
      { assertion: { url: "/dash" }, pass: false, actual: "page didn't answer" },
    ]);
    expect(r.screenshot).toBeNull();
  });
});

describe("browser_report tool", () => {
  const reportTool = () => browserTools(fakeBackend({ url: "http://x/", checks: [{ pass: false, actual: "not found" }] })).find((t) => t.name === "browser_report")!;

  it("refuses a check that sets two of text, url, or selector", async () => {
    const out = await reportTool().run({ checks: [{ text: "a", url: "/b" }] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Check 0");
  });

  it("refuses value without a selector", async () => {
    const out = await reportTool().run({ checks: [{ text: "a", value: "42" }] });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Check 0");
  });

  it("returns the report with isError false even when a check fails", async () => {
    const out = await reportTool().run({ checks: [{ text: "Nope" }], title: "Checkout" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Browser report: Checkout");
    expect(out.text).toContain("Target: headless session");
    expect(out.text).toContain('FAIL  text "Nope" — actual: not found');
    expect(out.text).toContain("Result: 0 of 1 checks passed");
  });

  it("names the visible pane and the calling thread", async () => {
    const tool = browserTools(fakeBackend({ url: "http://x/", checks: [{ pass: true, actual: "found" }] }, "visible")).find((t) => t.name === "browser_report")!;
    const out = await tool.run({ checks: [{ text: "Saved" }] }, { threadId: "t7" });
    expect(out.text).toContain("Target: visible pane · thread t7");
  });
});

const cli = resolveAgentBrowser();

describe.skipIf(!runs(cli) || process.platform === "win32")("browser_report in a real page (agent-browser)", () => {
  it("passes value and count checks and fails text that isn't there", { timeout: 90_000 }, async () => {
    const b = new AgentBrowserBackend({ session: `cubiq-p55b-${process.pid}`, screenshotDir: tempDir() });
    try {
      await b.open("data:text/html,<input id=total value=42><ul><li class=item>A</li><li class=item>B</li></ul>");
      const r = await runReport(b, [{ selector: "#total", value: "42" }, { selector: "li.item", count: 2 }, { text: "Nope" }], { target: "headless session" });
      expect(r.checks.map((c) => c.pass)).toEqual([true, true, false]);
      expect(r.checks[0]!.actual).toBe("42");
      expect(r.checks[1]!.actual).toBe("2 visible");
      expect(r.url).toContain("data:text/html");
    } finally {
      await b.close();
    }
  });
});
