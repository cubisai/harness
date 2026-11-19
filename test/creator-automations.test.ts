import { describe, expect, it } from "vitest";
import { prepareAutomation, validateAutomationDraft } from "../src/main/creator/automations";
import type { Thread } from "../src/shared/types";

const thread = { agent: "codex", model: "cheap", permissionMode: "full" } as Thread;
const agents = [{ id: "codex", models: ["cheap", "default"] }];
const config = { title: "Morning brief", prompt: "Summarize project changes. Do not write files.", schedule: { kind: "daily", at: "09:00", days: [1, 2, 3, 4, 5], timeZone: "Asia/Bangkok" }, budgetUsd: 0.25 };

describe("Creator scheduled prompts", () => {
  it("pins the selected engine/model and always produces Off/Ask/custom, independently of Full access", () => {
    const draft = prepareAutomation("morning-brief", config, thread, agents);
    expect(draft.input).toMatchObject({ name: "Morning brief", agent: "codex", model: "cheap", template: "custom", enabled: false, permissions: "ask", budgetUsd: 0.25, missed: "skip" });
    expect(validateAutomationDraft(draft)).toEqual(draft);
  });
  it.each([
    { ...config, enabled: true }, { ...config, permissions: "unattended" }, { ...config, preset: "creator" },
    { ...config, projectId: "other" }, { ...config, prompt: " " }, { ...config, agent: "missing" },
    { ...config, model: "expensive-unknown" }, { ...config, missed: "all" },
    ...[0, -1, Infinity, NaN].map((budgetUsd) => ({ ...config, budgetUsd })),
    ...[{ kind: "other" }, {}, { kind: "interval", everyMinutes: 0 }, { kind: "interval", everyMinutes: 10, command: "run" }, { ...config.schedule, timeZone: "Bad/Zone" }, { ...config.schedule, days: [1, 1] }, { ...config.schedule, days: [] }].map((schedule) => ({ ...config, schedule })),
  ])("rejects malformed or elevated config: %j", (input) => {
    expect(() => prepareAutomation("morning-brief", input, thread, agents)).toThrow();
  });
  it("rejects persisted drafts that request full access, enabled schedules or template sources", () => {
    const draft = prepareAutomation("morning-brief", config, thread, agents);
    for (const change of [{ enabled: true }, { permissions: "unattended" }, { template: "project-brief" }]) expect(() => validateAutomationDraft({ ...draft, input: { ...draft.input, ...change } })).toThrow();
  });
});
