import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { AutomationStore, type Automation } from "../src/main/automations/store";
import type { Schedule } from "../src/shared/automations";
import { closeAfter, tempDir } from "./helpers";

const schedule: Schedule = { kind: "interval", everyMinutes: 5 };

type NewAutomation = Omit<Automation, "createdAt" | "updatedAt" | "configVersion">;

const base = (over: Partial<NewAutomation> = {}): NewAutomation => ({
  id: "a1",
  projectId: "p1",
  name: "Nightly",
  template: "review",
  prompt: "review the diff",
  schedule,
  missed: "coalesce",
  enabled: true,
  agent: null,
  model: null,
  budgetUsd: null,
  anchor: 1000,
  ...over,
});

/** A real Store on a temp file, with an injectable clock handed to the automation store. */
function open(file: string, now: () => number = () => Date.now()): { store: Store; db: AutomationStore } {
  const store = new Store(file);
  return { store, db: new AutomationStore(store.sql, now) };
}

describe("AutomationStore", () => {
  it("creates the automation tables and re-opens the file idempotently", () => {
    const file = join(tempDir(), "m.db");
    const first = open(file);
    first.db.create(base());
    const tables = (first.store.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[]).map((r) => r.name);
    for (const t of ["automations", "automation_runs", "automation_cursors", "automation_deliveries"]) expect(tables).toContain(t);
    first.store.close();

    const second = open(file);
    closeAfter(() => second.store.close());
    expect(second.db.get("a1")).not.toBeNull();
    expect(second.store.sql.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'automations'").get()).toEqual({ n: 1 });
  });

  it("creates, reads, lists and updates an automation, bumping configVersion", () => {
    const { store, db } = open(join(tempDir(), "t.db"), () => 10_000);
    closeAfter(() => store.close());

    const a = db.create(base());
    expect(a).toMatchObject({ id: "a1", configVersion: 1, enabled: true, schedule, createdAt: 10_000, updatedAt: 10_000 });

    db.create(base({ id: "a2", projectId: "p2", name: "Other" }));
    expect(db.list().map((x) => x.id)).toEqual(["a1", "a2"]);
    expect(db.list("p2").map((x) => x.id)).toEqual(["a2"]);
    expect(db.get("nope")).toBeNull();

    const updated = db.update("a1", { name: "Renamed", enabled: false, budgetUsd: 12.5 });
    expect(updated).toMatchObject({ name: "Renamed", enabled: false, budgetUsd: 12.5, configVersion: 2, updatedAt: 10_000 });
    expect(db.get("a1")!.configVersion).toBe(2);
  });

  it("claims a run once per key, even across a restart", () => {
    const file = join(tempDir(), "r.db");
    const first = open(file);
    first.db.create(base());

    const run = first.db.claimRun("a1", "a1@1000", 1000);
    expect(run).toMatchObject({ status: "queued", runKey: "a1@1000", scheduledAt: 1000, configVersion: 1 });
    expect(first.db.claimRun("a1", "a1@1000", 1000)).toBeNull();
    first.store.close();

    const second = open(file);
    closeAfter(() => second.store.close());
    expect(second.db.claimRun("a1", "a1@1000", 1000)).toBeNull();
  });

  it("reports the latest scheduled instant", () => {
    const { store, db } = open(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    db.create(base());
    expect(db.lastScheduled("a1")).toBeNull();
    db.claimRun("a1", "k1", 100);
    db.claimRun("a1", "k2", 300);
    expect(db.lastScheduled("a1")).toBe(300);
  });

  it("starts and finishes a run, recording cost, tokens and checkpoint", () => {
    const { store, db } = open(join(tempDir(), "t.db"), () => 10_000);
    closeAfter(() => store.close());
    db.create(base());

    const run = db.claimRun("a1", "k", 5)!;
    const started = db.startRun(run.id, "thread-1", 60_000);
    expect(started).toMatchObject({ status: "running", threadId: "thread-1", startedAt: 10_000, leaseUntil: 70_000 });
    expect(db.renewLease(run.id, 30_000).leaseUntil).toBe(40_000);
    db.checkpoint(run.id, { step: 2 });
    db.setStatus(run.id, "waiting-input");

    const done = db.finishRun(run.id, { status: "succeeded", costUsd: 0.25, inputTokens: 120, outputTokens: 40, result: "ok" });
    expect(done).toMatchObject({ status: "succeeded", costUsd: 0.25, inputTokens: 120, outputTokens: 40, result: "ok", endedAt: 10_000, leaseUntil: null });
    expect(done.checkpoint).toEqual({ step: 2 });
    expect(db.runs("a1").map((r) => r.id)).toEqual([run.id]);
  });

  it("interrupts only running runs whose lease expired", () => {
    let now = 1_000;
    const { store, db } = open(join(tempDir(), "t.db"), () => now);
    closeAfter(() => store.close());
    db.create(base());

    const expired = db.claimRun("a1", "expired", 1)!;
    const held = db.claimRun("a1", "held", 2)!;
    const queued = db.claimRun("a1", "queued", 3)!;
    const noLease = db.claimRun("a1", "nolease", 4)!;
    db.startRun(expired.id, "t1", 100);
    db.startRun(held.id, "t2", 10_000);
    db.setStatus(noLease.id, "running");

    now = 5_000;
    expect(db.interruptStale()).toBe(2);
    expect(db.run(expired.id)!).toMatchObject({ status: "interrupted", endedAt: 5_000 });
    expect(db.run(noLease.id)!.status).toBe("interrupted");
    expect(db.run(held.id)!.status).toBe("running");
    expect(db.run(queued.id)!.status).toBe("queued");
    expect(db.interruptStale()).toBe(0);
  });

  it("defaults cursors to never, keeps the bookmark on failure and advances it on confirm", () => {
    const { store, db } = open(join(tempDir(), "t.db"), () => 10_000);
    closeAfter(() => store.close());
    db.create(base());

    expect(db.cursor("a1", "git")).toMatchObject({ bookmark: null, lastStatus: "never", lastOkAt: null, lastError: null });

    db.confirmSource("a1", "git", "abc");
    expect(db.cursor("a1", "git")).toMatchObject({ bookmark: "abc", lastStatus: "ok", lastOkAt: 10_000, lastError: null });

    db.failSource("a1", "git", "rate limited");
    expect(db.cursor("a1", "git")).toMatchObject({ bookmark: "abc", lastStatus: "unavailable", lastError: "rate limited", lastOkAt: 10_000 });

    db.confirmSource("a1", "git", "def");
    expect(db.cursor("a1", "git")).toMatchObject({ bookmark: "def", lastStatus: "ok", lastError: null });
  });

  it("records deliveries idempotently and walks intent to published to confirmed", () => {
    const { store, db } = open(join(tempDir(), "t.db"), () => 10_000);
    closeAfter(() => store.close());
    db.create(base());
    const run = db.claimRun("a1", "k", 1)!;

    const d1 = db.deliveryIntent("d1", run.id, "slack");
    expect(d1).toMatchObject({ state: "intent", destination: "slack", receipt: null, runId: run.id });
    expect(db.deliveryIntent("d1", run.id, "slack")).toEqual(d1);
    expect(db.pendingDeliveries().map((x) => x.idempotencyKey)).toEqual(["d1"]);

    expect(db.markPublished("d1", "msg-1")).toMatchObject({ state: "published", receipt: "msg-1" });
    expect(db.pendingDeliveries().map((x) => x.idempotencyKey)).toEqual(["d1"]);
    expect(db.confirmDelivery("d1", "msg-1")).toMatchObject({ state: "confirmed", receipt: "msg-1" });

    db.deliveryIntent("d2", run.id, "webhook");
    const unknown = db.markUnknown("d2")!;
    expect(unknown).toMatchObject({ state: "unknown" });
    expect(db.pendingDeliveries().map((x) => x.idempotencyKey)).toEqual(["d2"]);
    expect(db.deliveryIntent("d2", run.id, "webhook")).toEqual(unknown);

    db.confirmDelivery("d2");
    expect(db.pendingDeliveries()).toEqual([]);
    expect(db.delivery("nope")).toBeNull();
  });

  it("removes an automation and everything it owns", () => {
    const { store, db } = open(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    db.create(base());
    db.create(base({ id: "a2", name: "Keep" }));
    const run = db.claimRun("a1", "k", 1)!;
    db.deliveryIntent("d1", run.id, "slack");
    db.confirmSource("a1", "git", "abc");

    db.remove("a1");
    expect(db.get("a1")).toBeNull();
    expect(db.run(run.id)).toBeNull();
    expect(db.delivery("d1")).toBeNull();
    expect(db.pendingDeliveries()).toEqual([]);
    expect(db.cursor("a1", "git").lastStatus).toBe("never");
    expect(db.list().map((x) => x.id)).toEqual(["a2"]);
  });
});
