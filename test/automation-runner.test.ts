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

describe("AutomationRunner.recover", () => {
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
    db.checkpoint(cut.id, { text: "the brief", advances: [{ source: "git", next: "sha2" }] });
    db.deliveryIntent("k", cut.id, "dest");

    const dest = fakeDestination();
    const runner = new AutomationRunner(makeDeps(db, { now: () => now, destination: dest }));
    const counts = await runner.recover();

    expect(counts).toMatchObject({ interrupted: 1, republished: 1 });
    expect(db.run(cut.id)!.status).toBe("interrupted");
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
