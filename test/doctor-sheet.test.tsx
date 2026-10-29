import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/shared/doctor";
import { DoctorReportView } from "../src/renderer/src/components/DoctorSheet";

const report: DoctorReport = {
  at: new Date(2026, 9, 20, 15, 4).getTime(),
  findings: [
    {
      id: "claude-ok",
      group: "agents",
      level: "ok",
      title: "Claude is installed",
      detail: "claude 1.2.3",
      fixes: [],
    },
    {
      id: "duplicates",
      group: "agents",
      level: "warn",
      title: "Two Claude installs",
      detail: "/usr/local/bin/claude\n/opt/homebrew/bin/claude",
      fixes: [
        { kind: "pin", label: "Pin Homebrew", agent: "claude", path: "/opt/homebrew/bin/claude" },
        { kind: "copy", label: "Copy paths", text: "/usr/local/bin/claude\n/opt/homebrew/bin/claude" },
      ],
    },
    {
      id: "codex",
      group: "agents",
      level: "error",
      title: "Codex is missing",
      detail: "Install it to use Codex threads.",
      fixes: [{ kind: "run", label: "Install Codex", command: "npm", args: ["install", "-g", "@openai/codex"] }],
    },
    {
      id: "path",
      group: "environment",
      level: "warn",
      title: "PATH is long",
      detail: "",
      fixes: [],
    },
  ],
};

const view = (overrides: Partial<ComponentProps<typeof DoctorReportView>> = {}) => (
  <DoctorReportView
    report={report}
    running={false}
    results={{}}
    onFix={() => {}}
    onCopy={() => {}}
    onRecheck={() => {}}
    confirming={null}
    onConfirm={() => {}}
    onCancel={() => {}}
    {...overrides}
  />
);

describe("DoctorReportView", () => {
  it("groups findings and puts errors before warnings", () => {
    const html = renderToStaticMarkup(view());
    expect(html.indexOf("<h3>Agents</h3>")).toBeGreaterThan(-1);
    expect(html.indexOf("<h3>Agents</h3>")).toBeLessThan(html.indexOf("<h3>Environment</h3>"));
    expect(html.indexOf("Codex is missing")).toBeLessThan(html.indexOf("Two Claude installs"));
    expect(html).toContain("Pin Homebrew");
    expect(html).toContain("Copy paths");
  });

  it("counts problems and warnings in the summary", () => {
    const html = renderToStaticMarkup(view());
    expect(html).toContain("1 problem, 2 warnings");
  });

  it("collapses an ok finding to one line", () => {
    const html = renderToStaticMarkup(view());
    const start = html.indexOf("Claude is installed");
    const row = html.slice(start, html.indexOf("</div>", start));
    expect(row).not.toContain("doctor-detail");
    expect(row).not.toContain("claude 1.2.3");
  });

  it("shows a run fix's exact command line and its result", () => {
    const html = renderToStaticMarkup(view({ results: { "codex:0": { ok: false, message: "Command failed" } } }));
    expect(html).toContain("npm install -g @openai/codex");
    expect(html).toContain("Command failed");
  });

  it("turns a confirmed run fix into Run and Cancel", () => {
    const html = renderToStaticMarkup(view({ confirming: "codex:0" }));
    expect(html).toContain("Run <code>npm install -g @openai/codex</code>?");
    expect(html).toContain(">Cancel</button>");
  });

  it("says Checking… while the first run is still going", () => {
    const html = renderToStaticMarkup(view({ report: null, running: true }));
    expect(html).toContain("Checking…");
  });
});
