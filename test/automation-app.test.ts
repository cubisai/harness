import { describe, expect, it, vi } from "vitest";
import { sendAndWait, sourcesForTemplate, startAutomations } from "../src/main/automations/app";
import { Store } from "../src/main/db";
import { join } from "node:path";
import { closeAfter, tempDir } from "./helpers";
import type { StoredEvent, ThreadEvent } from "../src/shared/types";

const ev = (seq: number, event: ThreadEvent): StoredEvent => ({ seq, event, createdAt: seq });

/** A fake Service whose thread stays busy for `busyPolls` checks after send returns (a check fix round). */
function fake(events: StoredEvent[], busyPolls = 0) {
  let polls = 0;
  return {
    service: { send: async () => {}, isRunning: () => polls++ < busyPolls },
    store: { listEvents: () => events },
    polls: () => polls,
  };
}

describe("sendAndWait", () => {
  it("returns the last answer after the user's message, once the thread stays idle", async () => {
    const f = fake([ev(1, { kind: "user", text: "old" }), ev(2, { kind: "assistant-text", text: "stale" }), ev(3, { kind: "user", text: "go" }), ev(4, { kind: "assistant-text", text: "first" }), ev(5, { kind: "assistant-text", text: "final" })], 3);
    await expect(sendAndWait(f.service as never, f.store as never, "t", "go", 2)).resolves.toEqual({ text: "final" });
    expect(f.polls()).toBeGreaterThanOrEqual(5);
  });

  it("rejects when the turn ended on an error with no answer", async () => {
    const f = fake([ev(1, { kind: "user", text: "go" }), ev(2, { kind: "error", message: "provider down" })]);
    await expect(sendAndWait(f.service as never, f.store as never, "t", "go", 2)).rejects.toThrow("provider down");
  });
});

describe("sourcesForTemplate", () => {
  it("reads git only for the project brief", () => {
    expect(sourcesForTemplate("project-brief")).toEqual(["git"]);
    expect(sourcesForTemplate("repo-health")).toEqual([]);
  });
});

it("Ask automation runs never inherit a Full-access thread default", async () => {
  vi.useFakeTimers();
  const store = new Store(join(tempDir(), "app.db"));
  closeAfter(() => store.close());
  const project = store.addProject(tempDir());
  const service = {
    createThread: (pid: string) => store.createThread(pid, "codex", "default", "full"),
    allDrivers: () => [{ id: "codex" }],
    send: async () => {}, isRunning: () => false, interrupt: () => {},
    pendingState: () => ({ running: [], permissions: [], questions: [], plans: [] }),
  };
  const app = startAutomations({ store, service: service as never, broadcast: () => {} });
  try {
    const a = app.save(project.id, { name: "Brief", template: "custom", prompt: "Read only", schedule: { kind: "interval", everyMinutes: 30 }, missed: "skip", enabled: false, agent: "codex", model: null, budgetUsd: null, permissions: "ask" });
    app.runNow(a.id);
    await vi.advanceTimersByTimeAsync(2000);
    const tid = app.runs(a.id)[0]!.threadId!;
    expect(store.getThread(tid).permissionMode).toBe("ask");
  } finally { app.dispose(); vi.useRealTimers(); }
});
