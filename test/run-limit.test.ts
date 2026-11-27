import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import { Store } from "../src/main/db";
import { Service } from "../src/main/service";
import type { LiveUpdate } from "../src/shared/types";
import { catalog, closeAfter, tempDir } from "./helpers";

/** A driver whose turns end only when the test releases them, so several can run at once. */
function gatedDriver() {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const driver: AgentDriver = {
    id: "fake",
    label: "Fake",
    defaultModel: "fake-1",
    capabilities: SAFE_DEFAULTS,
    skillsDelivery: { mode: "none" },
    skillCallPrefix: "skilled:",
    models: () => [{ id: "fake-1", label: "Fake 1" }],
    async runTurn(input: TurnInput) {
      started.push(input.threadId);
      await new Promise<void>((resolve) => {
        release.set(input.threadId, resolve);
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
  return { driver, started, release };
}

function setup(limit: number) {
  const store = new Store(join(tempDir(), "t.db"));
  closeAfter(() => store.close());
  const updates: LiveUpdate[] = [];
  const g = gatedDriver();
  const service = new Service(store, () => catalog(), [g.driver], (u) => updates.push(u));
  service.setRunLimit(() => limit);
  const project = store.addProject(tempDir());
  const threads = [0, 1, 2].map(() => service.createThread(project.id));
  return { ...g, service, updates, threads, store };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("Run at once", () => {
  it("settles the running and queued owners before deleting a project", async () => {
    const { service, threads, store, started } = setup(1);
    const a = threads[0]!, b = threads[1]!;
    const first = service.send({ threadId: a.id, text: "run" });
    const queued = service.send({ threadId: b.id, text: "wait", background: true });
    await vi.waitFor(() => expect(started).toEqual([a.id]));
    const deletion = service.deleteProject(a.projectId);
    await expect(service.send({ threadId: a.id, text: "late" })).rejects.toThrow(/delet/);
    expect((await Promise.all([first, queued])).map((o) => o.status)).toEqual(["cancelled", "cancelled"]);
    await deletion;
    expect(started).toEqual([a.id]);
    expect(store.listThreads(a.projectId)).toEqual([]);
    expect(service.pendingState()).toMatchObject({ running: [], queued: [] });
  });
  it("reserves one owner and one slot even for same-tick requests", async () => {
    const { service, threads, started, release } = setup(1);
    const a = threads[0]!.id, b = threads[1]!.id;
    const first = service.send({ threadId: a, text: "first", background: true });
    const duplicate = service.send({ threadId: a, text: "duplicate" }).then(() => false, () => true);
    const second = service.send({ threadId: b, text: "second", background: true });
    await vi.waitFor(() => expect(started).toContain(a));
    expect(started).toEqual([a]);
    expect(await duplicate).toBe(true);
    release.get(a)!();
    await first;
    await vi.waitFor(() => expect(started).toEqual([a, b]));
    release.get(b)!();
    await second;
  });
  it("queues a background send past the limit and starts it when a slot frees, oldest first", async () => {
    const { service, threads, started, release, updates } = setup(1);
    const [a, b, c] = threads as unknown as [{ id: string }, { id: string }, { id: string }];
    const first = service.send({ threadId: a.id, text: "a", background: true });
    await tick();
    const second = service.send({ threadId: b.id, text: "b", background: true });
    const third = service.send({ threadId: c.id, text: "c", background: true });
    await tick();
    expect(started).toEqual([a.id]);
    expect(updates.filter((u) => u.type === "queued" && u.queued).map((u) => (u as { threadId: string }).threadId)).toEqual([b.id, c.id]);
    release.get(a.id)!();
    await first;
    await tick();
    expect(started).toEqual([a.id, b.id]);
    release.get(b.id)!();
    await second;
    await tick();
    expect(started).toEqual([a.id, b.id, c.id]);
    release.get(c.id)!();
    await third;
  });

  it("never queues a foreground send", async () => {
    const { service, threads, started, release } = setup(1);
    const [a, b] = threads as unknown as [{ id: string }, { id: string }];
    const first = service.send({ threadId: a.id, text: "a", background: true });
    await tick();
    const second = service.send({ threadId: b.id, text: "b" });
    await tick();
    expect(started).toEqual([a.id, b.id]);
    release.get(a.id)!();
    release.get(b.id)!();
    await Promise.all([first, second]);
  });

  it("stopping a waiting thread drops it from the queue without running it", async () => {
    const { service, threads, started, release, store } = setup(1);
    const [a, b] = threads as unknown as [{ id: string }, { id: string }];
    const first = service.send({ threadId: a.id, text: "a", background: true });
    await tick();
    const second = service.send({ threadId: b.id, text: "b", background: true });
    await tick();
    service.interrupt(b.id);
    await second;
    release.get(a.id)!();
    await first;
    await tick();
    expect(started).toEqual([a.id]);
    expect(store.listEvents(b.id).map((e) => e.event)).toContainEqual({ kind: "notice", text: "Stopped before it started." });
  });

  it("with no limit runs every background send at once (today's behaviour)", async () => {
    const { service, threads, started, release } = setup(0);
    const sends = threads.map((t) => service.send({ threadId: t.id, text: "x", background: true }));
    await tick();
    expect(started).toHaveLength(3);
    for (const t of threads) release.get(t.id)!();
    await Promise.all(sends);
  });
});
