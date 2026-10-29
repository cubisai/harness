import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationNotice, AutomationTemplate, AutomationsOverview } from "../src/shared/automations";

const template: AutomationTemplate = {
  id: "project-brief",
  name: "Project brief",
  description: "Summarise what changed since the last run.",
  prompt: "Summarise what changed since the last run from the commit list. Don't edit any files.",
  schedule: { kind: "daily", at: "09:00", timeZone: "UTC" },
  budgetUsd: 0.25,
};

const notice: AutomationNotice = {
  automationId: "a1",
  name: "Project brief",
  runId: 1,
  threadId: null,
  status: "succeeded",
  costUsd: 0.04,
  endedAt: 1_700_000_000_000,
  error: null,
};

const overview: AutomationsOverview = {
  templates: [template],
  automations: [
    {
      id: "a1",
      projectId: "p1",
      name: "Project brief",
      template: "project-brief",
      prompt: template.prompt,
      schedule: template.schedule,
      missed: "coalesce",
      enabled: true,
      agent: null,
      model: null,
      budgetUsd: 0.25,
      permissions: "unattended",
      scheduleText: "daily at 09:00 (UTC)",
      nextAt: null,
      lastRun: notice,
    },
  ],
};

describe("AutomationsTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  // `renderToStaticMarkup` runs no effects, so the fetch never fires: the
  // overview arrives through the same `overview` prop the app leaves unset.
  // Server rendering reads zustand's initial state, so seed it directly.
  const render = async () => {
    vi.stubGlobal("window", { unskilled: {} });
    const { useStore } = await import("../src/renderer/src/store");
    const { AutomationsTab, inputOf, lastRunText } = await import("../src/renderer/src/components/AutomationsTab");
    return { useStore, AutomationsTab, inputOf, lastRunText };
  };

  it("renders the list with the name, schedule and last run cost", async () => {
    const { useStore, AutomationsTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<AutomationsTab overview={overview} />);
      expect(html).toContain("Project brief");
      expect(html).toContain("daily at 09:00 (UTC)");
      expect(html).toContain("succeeded");
      expect(html).toContain("$0.04");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("asks for a project when none is selected", async () => {
    const { useStore, AutomationsTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = null;
      expect(renderToStaticMarkup(<AutomationsTab overview={overview} />)).toContain("Open a project to schedule automations.");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("offers the template picker when the list is empty", async () => {
    const { useStore, AutomationsTab } = await render();
    const state = useStore.getInitialState();
    const saved = state.selectedProjectId;
    try {
      state.selectedProjectId = "p1";
      const html = renderToStaticMarkup(<AutomationsTab overview={{ ...overview, automations: [] }} />);
      expect(html).toContain("Pick a template to start");
      expect(html).toContain("Project brief");
    } finally {
      state.selectedProjectId = saved;
    }
  });

  it("copies a template's prompt, schedule and budget into a new input", async () => {
    const { inputOf } = await render();
    const input = inputOf(template);
    expect(input.name).toBe("Project brief");
    expect(input.template).toBe("project-brief");
    expect(input.prompt).toBe(template.prompt);
    expect(input.schedule).toEqual(template.schedule);
    expect(input.budgetUsd).toBe(0.25);
    expect(input.enabled).toBe(true);
    expect(input.missed).toBe("coalesce");
    expect(input.agent).toBeNull();
    expect(input.model).toBeNull();
  });

  it("formats a last run as status, time and cost, and handles none", async () => {
    const { lastRunText } = await render();
    const now = notice.endedAt! + 5 * 60_000;
    expect(lastRunText(notice, now)).toBe("succeeded · 5m ago · $0.04");
    expect(lastRunText({ ...notice, costUsd: null }, now)).toBe("succeeded · 5m ago");
    expect(lastRunText(null, now)).toBe("Never run");
  });
});
