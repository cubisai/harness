import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanLip } from "../src/renderer/src/components/StudioComposer";

const entries = [
  { content: "Read the design system", status: "completed" as const },
  { content: "List the issues in the cycle", status: "in_progress" as const },
  { content: "Check the page", status: "pending" as const },
];

describe("PlanLip", () => {
  it("shows the step, what the agent last said, and how far along it is", () => {
    const html = renderToStaticMarkup(<PlanLip threadId="t1" entries={entries} progress={{ done: 1, total: 3, current: "List the issues in the cycle" }} line="Editing the Cycles screen" />);
    expect(html).toContain('class="composer-plan-step">List the issues in the cycle<');
    expect(html).toContain('class="composer-plan-line">Editing the Cycles screen<');
    expect(html).toContain(">1 of 3<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("todo-item");
  });

  it("drops a line that only repeats the step", () => {
    const html = renderToStaticMarkup(<PlanLip threadId="t2" entries={entries} progress={{ done: 0, total: 3, current: "Read the design system" }} line="Read the design system" />);
    expect(html).not.toContain("composer-plan-line");
  });
});
