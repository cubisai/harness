import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/main/db";
import { AutomationStore, type Automation } from "../src/main/automations/store";
import { AutomationRunner, type RunnerDeps } from "../src/main/automations/runner";
import type { DeliveryCheck, DeliveryPayload, Destination, Source } from "../src/main/automations/io";
import type { Schedule } from "../src/shared/automations";
import { closeAfter, tempDir } from "./helpers";

type NewAutomation = Omit<Automation, "createdAt" | "updatedAt" | "configVersion">;

const schedule: Schedule = { kind: "interval", everyMinutes: 5 };

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
  permissions: "unattended",
  anchor: 0,
  ...over,
});

/** A real Store on a temp file, with an injectable clock handed to the automation store. */
function open(now: () => number): { store: Store; db: AutomationStore } {
  const store = new Store(join(tempDir(), "a.db"));
  closeAfter(() => store.close());
  return { store, db: new AutomationStore(store.sql, now) };
}

interface FakeDestination extends Destination {
  payloads: DeliveryPayload[];
}

const MISSING = async (): Promise<DeliveryCheck> => "missing";

function fakeDestination(check: (key: string) => Promise<DeliveryCheck> = MISSING): FakeDestination {
  const payloads: DeliveryPayload[] = [];
  return {
    id: "dest",
    repeatable: true,
    payloads,
    async publish(p) {
      payloads.push(p);
      return `receipt-${payloads.length}`;
    },
    check,
  };
}

function makeDeps(store: AutomationStore, over: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    store,
    createThread: async () => "thread-1",
    send: async () => ({ text: "answer" }),
    totals: () => ({ costUsd: 0.1, inputTokens: 10, outputTokens: 5 }),
    interactiveBusy: () => false,
    waitingInput: () => false,
    sourcesFor: () => [],
    sources: new Map(),
    cwdOf: () => "/work",
    destination: fakeDestination(),
    notify: () => {},
    now: () => 0,
    leaseMs: 60_000,
    pollMs: 1,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AutomationRunner.tick", () => {
  it("keeps manual runs out of the scheduled cursor", () => {
    let now = 0;
    const { db } = open(() => now);
    db.create(base());
    const runner = new AutomationRunner(makeDeps(db, { now: () => now }));
    now = 310_000;
    runner.runNow("a1");
    expect(runner.tick(330_000)).toBe(1);
    expect(runner.tick(330_000)).toBe(0);
    expect(db.lastScheduled("a1")).toBe(300_000);
  });

  it("cancels outdated claims recovered after a settings edit", async () => {
    const { db } = open(() => 1_000);
    db.create(base());
    const run = new AutomationRunner(makeDeps(db)).runNow("a1")!;
    db.update("a1", { prompt: "changed", budgetUsd: 5, permissions: "ask" });
    const runner = new AutomationRunner(makeDeps(db));
    await runner.recover();
    await runner.drain();
    expect(db.run(run.id)).toMatchObject({ threadId: null, status: "cancelled", error: expect.stringMatching(/settings/i) });
  });
  it("blocks scheduled/manual/recovered admission while a plugin owner is Off", async () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base());
    const createThread = async () => { throw new Error("must not start"); };
    const queued = db.claimRun("a1", "a1@manual-before-crash", now)!;
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, createThread, owner: () => ({ key: "g~reviewer", title: "Reviewer", enabled: false, revision: "r1" }) }));
    now = 300_000;
    expect(runner.tick()).toBe(0);
    expect(() => runner.runNow("a1")).toThrow("Off");
    expect((await runner.recover()).requeued).toBe(0);
    await runner.drain();
    expect(db.run(queued.id)?.status).toBe("cancelled");
    expect(db.runs("a1")).toHaveLength(1);
  });
  it("does not execute a cancelled queue entry even after the owner is On again", async () => {
    const { db } = open(() => 1_000);
    db.create(base());
    let sends = 0;
    const runner = new AutomationRunner(makeDeps(db, { send: async () => { sends++; return { text: "late" }; }, owner: () => ({ key: "g~reviewer", title: "Reviewer", enabled: true, revision: "r2" }) }));
    const r = runner.runNow("a1")!;
    db.finishRun(r.id, { status: "cancelled" });
    await runner.drain();
    expect(sends).toBe(0);
    expect(db.run(r.id)?.status).toBe("cancelled");
  });
  it("drops late send results after an owner revision changes, without publishing or overwriting cancellation", async () => {
    const { db } = open(() => 1_000);
    db.create(base());
    const destination = fakeDestination();
    let revision = "r1", interrupts = 0;
    const runner = new AutomationRunner(makeDeps(db, {
      destination, owner: () => ({ key: "g~reviewer", title: "Reviewer", enabled: true, revision }),
      interrupt: () => { interrupts++; },
      send: async () => { revision = "r2"; return { text: "late result" }; },
    }));
    const r = runner.runNow("a1")!;
    await runner.drain();
    expect(db.run(r.id)?.status).toBe("cancelled");
    expect(destination.payloads).toEqual([]);
    expect(interrupts).toBe(1);
  });
  it("does not republish a crash's pending delivery while its owner is unavailable", async () => {
    const { db } = open(() => 1_000);
    db.create(base());
    const r = db.claimRun("a1", "a1@manual-before-crash", 1_000)!;
    db.deliveryIntent("pending", r.id, "dest");
    const destination = fakeDestination();
    const runner = new AutomationRunner(makeDeps(db, { destination, owner: () => ({ key: "g~reviewer", title: "Reviewer", enabled: false }) }));
    expect((await runner.recover()).republished).toBe(0);
    expect(destination.payloads).toEqual([]);
  });
  it("claims one run per due instant, dedupes a re-tick, and never wakes a disabled automation", () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    db.create(base({ id: "a2" }));
    db.create(base({ id: "a3", enabled: false }));
    now = 300_000; // a1 and a2 are both due at 300_000, from createdAt/anchor

    const runner = new AutomationRunner(makeDeps(db, { now: () => now }));
    expect(runner.tick()).toBe(2);
    expect(runner.queued()).toBe(2);
    expect(db.runs("a1")).toHaveLength(1);
    expect(db.runs("a1")[0]!.scheduledAt).toBe(300_000);
    expect(db.runs("a2")).toHaveLength(1);
    expect(db.runs("a3")).toHaveLength(0);

    // Same now: lastScheduled has moved past the instant, so nothing re-claims.
    expect(runner.tick()).toBe(0);
    expect(runner.queued()).toBe(2);
  });

  it("coalesces several missed instants into a single run", () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", schedule: { kind: "interval", everyMinutes: 5 }, missed: "coalesce" }));
    now = 50 * 60_000 + 1_000; // ten intervals missed

    const runner = new AutomationRunner(makeDeps(db, { now: () => now }));
    expect(runner.tick()).toBe(1);
    expect(db.runs("a1")).toHaveLength(1);
    expect(runner.queued()).toBe(1);
  });

  it("queues a manual run now, once per instant", () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    const runner = new AutomationRunner(makeDeps(db, { now: () => now }));

    const run = runner.runNow("a1");
    expect(run).toMatchObject({ status: "queued", runKey: `a1@manual-${new Date(1000).toISOString()}`, scheduledAt: 1_000 });
    expect(runner.queued()).toBe(1);
    expect(runner.runNow("a1")).toBeNull();
    expect(runner.runNow("missing")).toBeNull();
  });
});

describe("AutomationRunner.drain", () => {
  it("runs a queued run through sources, send, delivery and a confirmed cursor advance", async () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", prompt: "summarize", budgetUsd: 5 }));

    const source: Source = {
      id: "git",
      async read() {
        return { items: ["abc123 did a thing", "def456 fixed it"], next: "head-sha" };
      },
    };
    const dest = fakeDestination();
    const created: string[] = [];
    const sent: { threadId: string; text: string }[] = [];
    const notified: number[] = [];
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        sourcesFor: () => ["git"],
        sources: new Map([["git", source]]),
        destination: dest,
        createThread: async (a) => {
          created.push(a.id);
          return "thread-1";
        },
        send: async (threadId, text) => {
          sent.push({ threadId, text });
          return { text: "the answer" };
        },
        totals: () => ({ costUsd: 0.25, inputTokens: 120, outputTokens: 40 }),
        notify: (run) => notified.push(run.id),
      }),
    );

    const run = runner.runNow("a1")!;
    await runner.drain();

    expect(runner.queued()).toBe(0);
    expect(created).toEqual(["a1"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe("thread-1");
    expect(sent[0]!.text).toContain("summarize");
    expect(sent[0]!.text).toContain("## Sources");
    expect(sent[0]!.text).toContain("### git");
    expect(sent[0]!.text).toContain("abc123 did a thing");

    expect(db.run(run.id)).toMatchObject({ status: "succeeded", costUsd: 0.25, inputTokens: 120, outputTokens: 40, result: "the answer" });
    expect(db.delivery(`${run.runKey}:dest`)).toMatchObject({ state: "confirmed" });
    expect(dest.payloads[0]).toMatchObject({ key: `${run.runKey}:dest`, automationId: "a1", runId: run.id, threadId: "thread-1", title: "Nightly", text: "the answer" });
    expect(db.cursor("a1", "git").bookmark).toBe("head-sha");
    expect(notified).toEqual([run.id]);
  });

  it("records a failed source, keeps its bookmark, and still reads the others", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    db.confirmSource("a1", "bad", "old-sha");

    const bad: Source = {
      id: "bad",
      async read() {
        throw new Error("rate limited");
      },
    };
    const good: Source = { id: "good", async read() { return { items: ["ok-item"], next: "good-sha" }; } };
    let prompt = "";
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        sourcesFor: () => ["bad", "good"],
        sources: new Map<string, Source>([["bad", bad], ["good", good]]),
        send: async (_threadId, text) => {
          prompt = text;
          return { text: "done" };
        },
      }),
    );

    runner.runNow("a1");
    await runner.drain();

    expect(db.cursor("a1", "bad")).toMatchObject({ bookmark: "old-sha", lastStatus: "unavailable", lastError: expect.stringContaining("rate limited") });
    expect(prompt).toContain("unavailable: rate limited");
    expect(prompt).not.toContain("### bad\nno new items");
    expect(prompt).toContain("### good");
    expect(prompt).toContain("ok-item");
    expect(db.cursor("a1", "good").bookmark).toBe("good-sha");
  });

  it("fails the run on a send error, leaving cursors and deliveries untouched", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    const source: Source = { id: "git", async read() { return { items: ["one"], next: "sha" }; } };
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        sourcesFor: () => ["git"],
        sources: new Map([["git", source]]),
        send: async () => {
          throw new Error("turn exploded");
        },
      }),
    );

    const run = runner.runNow("a1")!;
    await runner.drain();

    expect(db.run(run.id)).toMatchObject({ status: "failed", error: "turn exploded" });
    expect(db.cursor("a1", "git").bookmark).toBeNull();
    expect(db.delivery(`${run.runKey}:dest`)).toBeNull();
    expect(db.pendingDeliveries()).toEqual([]);
    expect(runner.queued()).toBe(0);
  });

  it("marks a delivery unknown when publish throws and does not advance the cursor", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    const source: Source = { id: "git", async read() { return { items: ["one"], next: "sha" }; } };
    const dest: Destination = { id: "dest", async publish() { throw new Error("offline"); }, async check() { return "missing"; } };
    const runner = new AutomationRunner(
      makeDeps(db, { now: () => now, sourcesFor: () => ["git"], sources: new Map([["git", source]]), destination: dest }),
    );

    const run = runner.runNow("a1")!;
    await runner.drain();

    expect(db.delivery(`${run.runKey}:dest`)).toMatchObject({ state: "unknown" });
    expect(db.cursor("a1", "git").bookmark).toBeNull();
    expect(db.run(run.id)!.status).toBe("partial");
  });

  it("parks a run at paused-budget when the turn costs more than budgetUsd", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", budgetUsd: 0.1 }));
    const source: Source = { id: "git", async read() { return { items: ["one"], next: "sha" }; } };
    const dest = fakeDestination();
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        sourcesFor: () => ["git"],
        sources: new Map([["git", source]]),
        destination: dest,
        totals: () => ({ costUsd: 0.5, inputTokens: 10, outputTokens: 5 }),
      }),
    );

    const run = runner.runNow("a1")!;
    await runner.drain();

    expect(db.run(run.id)).toMatchObject({ status: "paused-budget", costUsd: 0.5 });
    expect(db.delivery(`${run.runKey}:dest`)!.state).toBe("confirmed");
    expect(db.cursor("a1", "git").bookmark).toBe("sha");
  });

  it("interrupts an in-flight turn mid-run when totals exceed budgetUsd and skips empty delivery", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", budgetUsd: 0.2 }));
    const source: Source = { id: "git", async read() { return { items: ["one"], next: "sha" }; } };
    const dest = fakeDestination();
    const interrupted: string[] = [];
    let currentCost = 0.05;
    let releaseSend: (() => void) | null = null;
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        sourcesFor: () => ["git"],
        sources: new Map([["git", source]]),
        destination: dest,
        totals: () => ({ costUsd: currentCost, inputTokens: 500, outputTokens: 200 }),
        interrupt: (tid) => {
          interrupted.push(tid);
          releaseSend?.();
        },
        send: async () => {
          await new Promise<void>((r) => {
            releaseSend = r;
            setTimeout(() => {
              currentCost = 0.35;
            }, 5);
          });
          throw new Error("Interrupted by user");
        },
      }),
    );

    const run = runner.runNow("a1")!;
    await runner.drain();

    expect(interrupted).toEqual(["thread-1"]);
    expect(db.run(run.id)).toMatchObject({ status: "paused-budget", costUsd: 0.35 });
    expect(dest.payloads).toEqual([]);
    expect(db.cursor("a1", "git").bookmark).toBeNull();
  });

  it("pauses subsequent scheduled ticks after paused-budget until config is updated, and never treats null costUsd as over budget", async () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", budgetUsd: 0.1 }));
    db.create(base({ id: "a2", budgetUsd: 0.1 }));
    const dest = fakeDestination();
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        destination: dest,
        createThread: async (a) => `thread-${a.id}`,
        totals: (tid) => (tid === "thread-a1" ? { costUsd: 0.25, inputTokens: 10, outputTokens: 5 } : { costUsd: null, inputTokens: 10, outputTokens: 5 }),
      }),
    );

    now = 300_000;
    expect(runner.tick(now)).toBe(2);
    await runner.drain();

    expect(db.runs("a1")[0]!.status).toBe("paused-budget");
    // Unknown cost (costUsd: null) never masquerades as exceeding a dollar cap.
    expect(db.runs("a2")[0]!.status).toBe("succeeded");
    expect(dest.payloads).toHaveLength(2);

    // Next interval: a1 is parked at paused-budget so tick() skips it; a2 runs normally.
    now = 600_000;
    expect(runner.tick(now)).toBe(1);
    await runner.drain();
    expect(db.runs("a1")).toHaveLength(1);
    expect(db.runs("a2")).toHaveLength(2);
    expect(dest.payloads).toHaveLength(3);

    // Raising the budget bumps configVersion, resuming scheduled runs without duplicate delivery of the old run.
    db.update("a1", { budgetUsd: 1.0 });
    now = 900_000;
    expect(runner.tick(now)).toBe(2);
    await runner.drain();
    expect(db.runs("a1")[0]!.status).toBe("succeeded");
    expect(dest.payloads.filter((p) => p.automationId === "a1")).toHaveLength(2);
  });

  it("resumes scheduled runs once a manual run settles after paused-budget, without piling up cancelled runs", async () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", budgetUsd: 0.1 }));
    let cost = 0.25;
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, totals: () => ({ costUsd: cost, inputTokens: 1, outputTokens: 1 }) }));

    now = 300_000;
    runner.tick(now);
    await runner.drain();
    expect(db.runs("a1")[0]!.status).toBe("paused-budget");

    // Parked: later intervals claim nothing (no cancelled rows per tick).
    now = 600_000;
    expect(runner.tick(now)).toBe(0);
    expect(db.runs("a1")).toHaveLength(1);

    cost = 0.05;
    runner.runNow("a1");
    await runner.drain();
    expect(db.runs("a1")[0]!.status).toBe("succeeded");

    now = 900_000;
    expect(runner.tick(now)).toBe(1);
    await runner.drain();
    expect(db.runs("a1").map((r) => r.status)).toEqual(["succeeded", "succeeded", "paused-budget"]);
  });

  it("waits for an interactive turn and leaves the queue for the next drain", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    let busy = true;
    let sends = 0;
    const runner = new AutomationRunner(
      makeDeps(db, { now: () => now, interactiveBusy: () => busy, send: async () => { sends++; return { text: "ok" }; } }),
    );

    runner.runNow("a1");
    await runner.drain();
    expect(sends).toBe(0);
    expect(runner.queued()).toBe(1);

    busy = false;
    await runner.drain();
    expect(sends).toBe(1);
    expect(runner.queued()).toBe(0);
  });

  it("marks the run waiting-input while the turn is pending and still finishes it", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    let runId = 0;
    let observed = "";
    const runner = new AutomationRunner(
      makeDeps(db, {
        now: () => now,
        waitingInput: () => true,
        send: async () => {
          await sleep(30);
          observed = db.run(runId)!.status;
          return { text: "done" };
        },
      }),
    );

    const run = runner.runNow("a1")!;
    runId = run.id;
    await runner.drain();

    expect(observed).toBe("waiting-input");
    expect(db.run(run.id)!.status).toBe("succeeded");
  });

  it("stops draining once stop() is called", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    let sends = 0;
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, send: async () => { sends++; return { text: "ok" }; } }));

    runner.runNow("a1");
    runner.stop();
    await runner.drain();
    expect(sends).toBe(0);
    expect(runner.queued()).toBe(1);
  });
});

describe("AutomationRunner disabled automations", () => {
  it("runs a manual run of a disabled automation but cancels a scheduled one", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", enabled: false }));
    const sent: string[] = [];
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, send: async (t) => (sent.push(t), { text: "ok" }) }));
    const manual = runner.runNow("a1")!;
    await runner.drain();
    expect(db.run(manual.id)!.status).toBe("succeeded");

    const scheduled = db.claimRun("a1", "a1@2026-01-01T00:00:00.000Z", 2)!;
    (runner as unknown as { queue: number[] }).queue.push(scheduled.id);
    await runner.drain();
    expect(db.run(scheduled.id)!.status).toBe("cancelled");
    expect(sent).toHaveLength(1);
  });
});

describe("AutomationRunner.recover", () => {
  const checkpoint = { text: "saved brief", title: "Original title", advances: [{ source: "git", expected: "f000", next: "e000" }], final: { status: "succeeded", inputTokens: 11, outputTokens: 6, costUsd: 0.4 } };
  function pending(db: AutomationStore, cp: unknown = checkpoint) {
    db.create(base());
    db.confirmSource("a1", "git", "f000");
    const run = db.claimRun("a1", "brief", 1)!;
    db.startRun(run.id, "t", 60_000);
    db.checkpoint(run.id, cp);
    db.deliveryIntent("brief:dest", run.id, "dest");
    return run.id;
  }

  it.each(["check", "publish"])("fences a revoked owner during %s, even after a second startup", async (stage) => {
    const { db } = open(() => 1_000);
    const owner = { key: "g~brief", title: "Brief", revision: "r1", enabled: true };
    const id = pending(db, { ...checkpoint, owner });
    const revoke = () => { owner.revision = "r2"; }; // Off/On while the promise was outstanding
    const destination = fakeDestination(async () => {
      if (stage === "check") { revoke(); return "confirmed"; }
      return "missing";
    });
    const publish = destination.publish;
    destination.publish = async (p) => { const receipt = await publish(p); revoke(); return receipt; };
    const deps = makeDeps(db, { destination, owner: () => owner });
    for (let boot = 0; boot < 2; boot++) {
      await new AutomationRunner(deps).recover();
      expect(db.run(id)).toMatchObject({ status: "cancelled", error: expect.stringMatching(/owning plugin/), result: "saved brief" });
      expect(db.delivery("brief:dest")?.state).not.toBe("confirmed");
      expect(db.cursor("a1", "git").bookmark).toBe("f000");
      expect(destination.payloads).toHaveLength(stage === "publish" ? 1 : 0);
    }
  });

  it("does not revive a run cancelled by someone else during receipt lookup", async () => {
    const { db } = open(() => 1_000);
    const id = pending(db);
    const destination = fakeDestination(async () => { db.finishRun(id, { status: "cancelled", error: "Cancelled elsewhere" }); return "confirmed"; });
    await new AutomationRunner(makeDeps(db, { destination })).recover();
    expect(db.run(id)).toMatchObject({ status: "cancelled", error: "Cancelled elsewhere" });
    expect(db.cursor("a1", "git").bookmark).toBe("f000");
    expect(destination.payloads).toEqual([]);
  });

  it.each(["unknown", "exception", "not repeatable"])("keeps %s delivery uncertainty visible, then accepts positive proof without reposting", async (failure) => {
    let now = 1_000;
    const { db } = open(() => now++);
    const id = pending(db, { ...checkpoint, final: { ...checkpoint.final, status: "paused-budget" } });
    let check: DeliveryCheck = failure === "not repeatable" ? "missing" : "unknown";
    let offline = failure === "exception";
    const destination = fakeDestination(async () => { if (offline) throw Error("offline"); return check; });
    destination.repeatable = failure !== "not repeatable";
    const deps = makeDeps(db, { destination });
    await new AutomationRunner(deps).recover();
    const uncertain = db.run(id);
    expect(uncertain).toMatchObject({ status: "paused-budget", result: "saved brief", inputTokens: 11, error: expect.stringMatching(/could not be confirmed/) });
    expect(db.delivery("brief:dest")?.state).toBe("unknown");
    expect(db.cursor("a1", "git").bookmark).toBe("f000");
    offline = false; check = "missing";
    await new AutomationRunner(deps).recover();
    expect(db.run(id)).toEqual(uncertain);
    db.confirmSource("a1", "git", "0100"); // A newer commit can sort before both earlier SHAs.
    check = { state: "confirmed", receipt: "receipt-9" };
    await new AutomationRunner(deps).recover();
    expect(db.cursor("a1", "git").bookmark).toBe("0100");
    expect(db.run(id)).toMatchObject({ status: "paused-budget", result: "saved brief", costUsd: 0.4, outputTokens: 6, error: null });
    expect(db.delivery("brief:dest")).toMatchObject({ state: "confirmed", receipt: "receipt-9" });
    expect(destination.payloads).toEqual([]);
  });

  it("settles a legacy confirmed receipt once without guessing its outcome or bookmark", async () => {
    let now = 1_000;
    const { db } = open(() => now++);
    const id = pending(db, { text: "legacy brief", advances: [{ source: "git", next: "e000" }] });
    db.confirmDelivery("brief:dest", "old-receipt");
    db.finishRun(id, { status: "partial", costUsd: 0.7, inputTokens: 30 });
    const destination = fakeDestination(async () => { throw Error("already confirmed"); });
    const runner = new AutomationRunner(makeDeps(db, { destination }));
    expect((await runner.recover()).confirmed).toBe(1);
    const first = db.run(id);
    expect(first).toMatchObject({ status: "partial", result: "legacy brief", inputTokens: 30, costUsd: 0.7, error: expect.stringMatching(/confirmed.*uncertain/i) });
    expect(db.cursor("a1", "git").bookmark).toBe("f000");
    expect(db.delivery("brief:dest")?.receipt).toBe("old-receipt");
    expect((await runner.recover()).confirmed).toBe(0);
    expect(db.run(id)).toEqual(first);
    expect(destination.payloads).toEqual([]);
  });

  it("migrates a pre-settlement database, recovering only the unfinished confirmed receipt across two opens", async () => {
    const file = join(tempDir(), "legacy.db");
    const original = new Store(file);
    const old = new AutomationStore(original.sql, () => 100);
    const id = pending(old, { text: "legacy brief", advances: [{ source: "git", next: "e000" }] });
    old.confirmDelivery("brief:dest", "receipt-1");
    const later = old.claimRun("a1", "later", 2)!;
    old.startRun(later.id, "later-thread", 100);
    old.deliveryIntent("later:dest", later.id, "dest");
    old.confirmDelivery("later:dest", "receipt-2");
    old.confirmSource("a1", "git", "0100");
    const completed = old.finishRun(later.id, { status: "succeeded", result: "later brief", inputTokens: 21 });
    // Version 40 predates the settled column. Both receipts looked alike on disk.
    original.sql.exec("ALTER TABLE automation_deliveries DROP COLUMN settled; UPDATE schema_version SET version = 40");
    original.close();

    for (const now of [200, 300]) {
      const reopened = new Store(file);
      try {
        const db = new AutomationStore(reopened.sql, () => now);
        const destination = fakeDestination();
        const result = await new AutomationRunner(makeDeps(db, { destination })).recover();
        expect(result.confirmed).toBe(now === 200 ? 1 : 0);
        expect(db.run(id)).toMatchObject({ status: "partial", endedAt: 200, result: "legacy brief", error: expect.stringMatching(/confirmed.*uncertain/i) });
        expect(db.run(later.id)).toEqual(completed);
        expect(db.delivery("brief:dest")).toMatchObject({ state: "confirmed", receipt: "receipt-1", updatedAt: 200 });
        expect(db.delivery("later:dest")).toMatchObject({ state: "confirmed", receipt: "receipt-2", updatedAt: 100 });
        expect(db.cursor("a1", "git").bookmark).toBe("0100");
        expect(db.pendingDeliveries(true)).toEqual([]);
        expect(destination.payloads).toEqual([]);
      } finally { reopened.close(); }
    }
  });

  it("uses the original payload on a safe retry; a newer bookmark survives the delivery", async () => {
    const { db } = open(() => 1_000);
    const id = pending(db);
    db.update("a1", { name: "Renamed" });
    db.confirmSource("a1", "git", "0100");
    const destination = fakeDestination();
    await new AutomationRunner(makeDeps(db, { destination })).recover();
    expect(destination.payloads).toEqual([{ key: "brief:dest", runId: id, automationId: "a1", threadId: "t", title: "Original title", text: "saved brief" }]);
    expect(db.run(id)).toMatchObject({ status: "succeeded", error: null });
    expect(db.cursor("a1", "git").bookmark).toBe("0100");
  });

  it("keeps an incomplete checkpoint readable without sending an unproven result", async () => {
    const { db } = open(() => 1_000);
    const id = pending(db, { ...checkpoint, advances: [null] });
    const destination = fakeDestination();
    await new AutomationRunner(makeDeps(db, { destination })).recover();
    expect(db.run(id)).toMatchObject({ status: "partial", result: "saved brief", error: expect.stringMatching(/could not be confirmed/) });
    expect(db.cursor("a1", "git").bookmark).toBe("f000");
    expect(destination.payloads).toEqual([]);
  });

  it("interrupts stale runs and reconciles deliveries without blind reposting", async () => {
    let now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));

    const stale = db.claimRun("a1", "stale", 1)!;
    db.startRun(stale.id, "t-stale", 100); // lease expires at 1_100
    const done = db.claimRun("a1", "done", 2)!;
    db.startRun(done.id, "t-done", 60_000);
    db.finishRun(done.id, { status: "succeeded", result: "final answer" });

    db.deliveryIntent("key-intent", done.id, "dest");
    db.deliveryIntent("key-unknown", done.id, "dest");
    db.markUnknown("key-unknown");
    db.deliveryIntent("key-confirmed", done.id, "dest");

    const published: string[] = [];
    const dest: Destination = {
      id: "dest",
      async publish(p) {
        published.push(p.key);
        return "receipt";
      },
      repeatable: true,
      async check(key) {
        return key === "key-confirmed" ? "confirmed" : "missing";
      },
    };
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, destination: dest }));

    now = 5_000;
    const counts = await runner.recover();

    expect(counts).toEqual({ interrupted: 1, requeued: 0, confirmed: 1, republished: 1, unknown: 1 });
    expect(db.run(stale.id)!.status).toBe("interrupted");
    expect(db.delivery("key-confirmed")!.state).toBe("confirmed");
    expect(db.delivery("key-intent")!.state).toBe("confirmed");
    expect(db.delivery("key-unknown")!.state).toBe("unknown");
    expect(published).toEqual(["key-intent"]);
  });

  it("re-publishes a missing intent with the run's result and the automation's name", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1", name: "Repo health" }));
    const done = db.claimRun("a1", "done", 1)!;
    db.startRun(done.id, "t-done", 60_000);
    db.finishRun(done.id, { status: "succeeded", result: "all green" });
    db.deliveryIntent("k", done.id, "dest");

    const dest = fakeDestination();
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, destination: dest }));

    const counts = await runner.recover();
    expect(counts).toEqual({ interrupted: 0, requeued: 0, confirmed: 0, republished: 1, unknown: 0 });
    expect(dest.payloads[0]).toMatchObject({ key: "k", automationId: "a1", runId: done.id, threadId: "t-done", title: "Repo health", text: "all green" });
  });

  it("finishes a delivery a crash cut short: the checkpointed text goes out and the cursor moves", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    const cut = db.claimRun("a1", "cut", 1)!;
    db.startRun(cut.id, "t-cut", 60_000); // lease still live: a quick restart
    db.checkpoint(cut.id, { text: "the brief", advances: [{ source: "git", expected: null, next: "sha2" }], final: { status: "succeeded", costUsd: null, inputTokens: 1, outputTokens: 2 } });
    db.deliveryIntent("k", cut.id, "dest");

    const dest = fakeDestination();
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, destination: dest }));
    const counts = await runner.recover();

    expect(counts).toMatchObject({ interrupted: 1, republished: 1 });
    expect(db.run(cut.id)!.status).toBe("succeeded");
    expect(dest.payloads[0]).toMatchObject({ key: "k", text: "the brief" });
    expect(db.cursor("a1", "git").bookmark).toBe("sha2");
  });

  it("re-queues runs claimed before a quit and interrupts a waiting-input run", async () => {
    const now = 1_000;
    const { db } = open(() => now);
    db.create(base({ id: "a1" }));
    const queued = db.claimRun("a1", "q", 1)!;
    const waiting = db.claimRun("a1", "w", 2)!;
    db.startRun(waiting.id, "t-w", 60_000);
    db.setStatus(waiting.id, "waiting-input");

    const sent: string[] = [];
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, send: async (t) => (sent.push(t), { text: "ok" }) }));
    const counts = await runner.recover();
    expect(counts).toMatchObject({ interrupted: 1, requeued: 1 });
    expect(db.run(waiting.id)!.status).toBe("interrupted");

    await runner.drain();
    expect(sent).toHaveLength(1);
    expect(db.run(queued.id)!.status).toBe("succeeded");
  });
});
