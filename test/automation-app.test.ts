import { describe, expect, it, vi } from "vitest";
import { sourcesForTemplate, startAutomations } from "../src/main/automations/app";
import { Store } from "../src/main/db";
import { join } from "node:path";
import { closeAfter, tempDir } from "./helpers";

describe("sourcesForTemplate", () => {
  it("reads git only for the project brief", () => {
    expect(sourcesForTemplate("project-brief")).toEqual(["git"]);
    expect(sourcesForTemplate("repo-health")).toEqual([]);
  });
});

it("restores the most recently finished run even with newer live and queued claims", () => {
  const store = new Store(join(tempDir(), "app.db"));
  closeAfter(() => store.close());
  const service = { pendingState: () => ({ running: ["interactive"] }) };
  const app = startAutomations({ store, service: service as never, broadcast: () => {} });
  try {
    const a = app.save("p", { name: "Brief", template: "custom", prompt: "Test", schedule: { kind: "interval", everyMinutes: 30 }, missed: "skip", enabled: false, agent: null, model: null, budgetUsd: null, permissions: "ask" });
    const done = app.store.claimRun(a.id, "done", 10)!;
    app.store.finishRun(done.id, { status: "succeeded", result: "done" });
    const live = app.store.claimRun(a.id, "live", 20)!;
    app.store.startRun(live.id, "t", 60_000);
    for (let i = 0; i < 21; i++) app.store.claimRun(a.id, `waiting-${i}`, 30 + i);
    expect(app.recentNotices().map((n) => n.runId)).toEqual([done.id]);
  } finally { app.dispose(); }
});

it("Ask automation runs never inherit a Full-access thread default", async () => {
  vi.useFakeTimers();
  const store = new Store(join(tempDir(), "app.db"));
  closeAfter(() => store.close());
  const project = store.addProject(tempDir());
  const service = {
    createThread: (pid: string) => store.createThread(pid, "codex", "default", "full"),
    allDrivers: () => [{ id: "codex" }],
    send: async () => ({ status: "failed", text: "partial", reason: "provider down" }), interrupt: () => {},
    pendingState: () => ({ running: [], permissions: [], questions: [], plans: [] }),
  };
  const app = startAutomations({ store, service: service as never, broadcast: () => {} });
  try {
    const a = app.save(project.id, { name: "Brief", template: "custom", prompt: "Read only", schedule: { kind: "interval", everyMinutes: 30 }, missed: "skip", enabled: false, agent: "codex", model: null, budgetUsd: null, permissions: "ask" });
    app.runNow(a.id);
    await vi.advanceTimersByTimeAsync(2000);
    const tid = app.runs(a.id)[0]!.threadId!;
    expect(store.getThread(tid).permissionMode).toBe("ask");
    expect(app.runs(a.id)[0]).toMatchObject({ status: "failed", error: "provider down" });
  } finally { app.dispose(); vi.useRealTimers(); }
});

it("owner-disabled editor/run endpoints refuse work, and independent removal cannot break bundle ownership", () => {
  const store = new Store(join(tempDir(), "app.db"));
  closeAfter(() => store.close());
  const project = store.addProject(tempDir());
  let ownerOn = false;
  const service = { allDrivers: () => [{ id: "codex" }], pendingState: () => ({ running: [], permissions: [], questions: [], plans: [] }) };
  const app = startAutomations({ store, service: service as never, broadcast: () => {}, owner: () => ({ key: "g~reviewer", title: "Reviewer", enabled: ownerOn }) });
  try {
    const input = { name: "Brief", template: "custom", prompt: "Read only", schedule: { kind: "interval" as const, everyMinutes: 30 }, missed: "skip" as const, enabled: false, agent: "codex", model: null, budgetUsd: null, permissions: "ask" as const };
    const a = app.save(project.id, input);
    expect(app.overview(project.id).automations[0]).toMatchObject({ owner: { enabled: false }, nextAt: null, unavailable: expect.stringContaining("Off") });
    expect(() => app.save(project.id, { ...input, enabled: true }, a.id)).toThrow("Off");
    expect(() => app.runNow(a.id)).toThrow("Off");
    expect(() => app.remove(a.id)).toThrow("managed by its plugin");
    ownerOn = true;
    expect(app.save(project.id, input, a.id).owner?.enabled).toBe(true);
    expect(() => app.save("another-project", input, a.id)).toThrow("does not belong");
    expect(app.runs(a.id)).toEqual([]);
  } finally { app.dispose(); }
});
