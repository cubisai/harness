// The automation runner: claims due runs, runs them one at a time behind
// interactive turns, and reconciles in-flight deliveries before any retry.

import type { RunStatus } from "../../shared/automations";
import type { DeliveryCheck, Destination, Source } from "./io";
import { dueTimes, runKey } from "./schedule";
import type { Automation, AutomationRun, AutomationStore } from "./store";

export interface RunnerDeps {
  store: AutomationStore;
  /** Start a fresh thread for the run; resolves with its id. */
  createThread(a: Automation): Promise<string>;
  /** Start a turn; resolves with the final answer at turn end, rejects on turn error. */
  send(threadId: string, text: string): Promise<{ text: string }>;
  totals(threadId: string): { costUsd: number | null; inputTokens: number; outputTokens: number };
  /** A user's own turn is running, so background runs wait for it. */
  interactiveBusy(): boolean;
  /** The run's turn is blocked on a user question or approval. */
  waitingInput(threadId: string): boolean;
  /** Source ids for this automation, in the order they appear in the prompt. */
  sourcesFor(a: Automation): string[];
  sources: Map<string, Source>;
  cwdOf(projectId: string): string;
  destination: Destination;
  notify(run: AutomationRun, a: Automation): void;
  now(): number;
  leaseMs: number;
  /** How often a pending run renews its lease and checks waitingInput; default 1000. */
  pollMs?: number;
}

export interface RecoverCounts {
  interrupted: number;
  requeued: number;
  confirmed: number;
  republished: number;
  unknown: number;
}

/** What a run keeps before delivering, so a restart can finish the delivery and the cursor advance. */
interface Checkpoint {
  text: string;
  advances: { source: string; next: string }[];
}

function checkpointOf(run: AutomationRun): Checkpoint {
  const c = run.checkpoint as Partial<Checkpoint> | null;
  return { text: run.result ?? (typeof c?.text === "string" ? c.text : ""), advances: Array.isArray(c?.advances) ? c.advances : [] };
}

/** A reason string safe to show a user. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Claimed-but-not-yet-run run ids, drained one at a time. */
export class AutomationRunner {
  private queue: number[] = [];
  private draining = false;
  private stopped = false;

  constructor(private deps: RunnerDeps) {}

  /**
   * Reconcile what was in flight before anything retries: stale runs are
   * interrupted; a confirmed check confirms; a missing one is re-published
   * only from intent/published; unknown is always left alone, never re-posted.
   * A confirmed delivery moves its run's source cursors. Runs claimed before a
   * quit but never started go back on the queue. Call once, at startup.
   */
  async recover(): Promise<RecoverCounts> {
    const store = this.deps.store;
    const counts: RecoverCounts = { interrupted: store.interruptStale(true), requeued: 0, confirmed: 0, republished: 0, unknown: 0 };
    for (const r of store.queuedRuns()) {
      if (this.queue.includes(r.id)) continue;
      this.queue.push(r.id);
      counts.requeued++;
    }
    for (const d of store.pendingDeliveries()) {
      const key = d.idempotencyKey;
      let check: DeliveryCheck;
      try {
        check = await this.deps.destination.check(key);
      } catch {
        counts.unknown++;
        continue;
      }
      if (check === "confirmed") {
        store.confirmDelivery(key);
        this.advance(d.runId);
        counts.confirmed++;
        continue;
      }
      if (check === "missing" && (d.state === "intent" || d.state === "published")) {
        const run = store.run(d.runId);
        const a = run ? store.get(run.automationId) : null;
        if (!run || !a) {
          counts.unknown++;
          continue;
        }
        try {
          const receipt = await this.deps.destination.publish({
            key,
            automationId: a.id,
            runId: run.id,
            threadId: run.threadId ?? "",
            title: a.name,
            text: checkpointOf(run).text,
          });
          store.markPublished(key, receipt);
          store.confirmDelivery(key, receipt);
          this.advance(run.id);
          counts.republished++;
        } catch {
          store.markUnknown(key);
          counts.unknown++;
        }
        continue;
      }
      counts.unknown++;
    }
    return counts;
  }

  /** Claim every instant due now onto the queue; one bad automation never stops the tick. */
  tick(now = this.deps.now()): number {
    const store = this.deps.store;
    let claimed = 0;
    for (const a of store.list()) {
      if (!a.enabled) continue;
      try {
        const last = store.lastScheduled(a.id) ?? a.createdAt;
        for (const t of dueTimes(a.schedule, last, now, a.missed, a.anchor)) {
          const run = store.claimRun(a.id, runKey(a.id, t), t);
          if (run) {
            this.queue.push(run.id);
            claimed++;
          }
        }
      } catch {
        // A broken schedule or row must not block the others.
      }
    }
    return claimed;
  }

  /** Queue one manual run now, outside the schedule; null if it can't be claimed. */
  runNow(id: string): AutomationRun | null {
    const store = this.deps.store;
    if (!store.get(id)) return null;
    const at = this.deps.now();
    const run = store.claimRun(id, `${id}@manual-${new Date(at).toISOString()}`, at);
    if (!run) return null;
    this.queue.push(run.id);
    return run;
  }

  /** Run queued runs one at a time, only while no interactive turn is running. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        if (this.deps.interactiveBusy()) break;
        await this.runOne(this.queue.shift()!);
      }
    } finally {
      this.draining = false;
    }
  }

  queued(): number {
    return this.queue.length;
  }

  /** Let the current run finish; drain then returns and leaves the rest queued. */
  stop(): void {
    this.stopped = true;
  }

  private async runOne(id: number): Promise<void> {
    const store = this.deps.store;
    const run = store.run(id);
    if (!run) return;
    const a = store.get(run.automationId);
    if (!a || !a.enabled) {
      store.finishRun(id, { status: "cancelled" });
      return;
    }
    let threadId: string | null = null;
    try {
      const sections: string[] = [];
      const advances: { source: string; next: string }[] = [];
      for (const sourceId of this.deps.sourcesFor(a)) {
        const src = this.deps.sources.get(sourceId);
        if (!src) {
          store.failSource(a.id, sourceId, "unknown source");
          sections.push(`### ${sourceId}\nunavailable: unknown source`);
          continue;
        }
        const cur = store.cursor(a.id, sourceId);
        try {
          const read = await src.read(cur.bookmark, { projectId: a.projectId, cwd: this.deps.cwdOf(a.projectId) });
          sections.push(`### ${sourceId}\n${read.items.length === 0 ? "no new items" : read.items.join("\n")}`);
          if (read.next !== null) advances.push({ source: sourceId, next: read.next });
        } catch (err) {
          // A failed read is never "no new items": say so and keep the bookmark.
          const msg = reason(err);
          store.failSource(a.id, sourceId, msg);
          sections.push(`### ${sourceId}\nunavailable: ${msg}`);
        }
      }

      let prompt = a.prompt;
      if (sections.length > 0) prompt += `\n\n## Sources\n${sections.join("\n")}`;

      const tid = await this.deps.createThread(a);
      threadId = tid;
      store.startRun(run.id, tid, this.deps.leaseMs);

      const timer = setInterval(() => {
        store.renewLease(run.id, this.deps.leaseMs);
        const wait = this.deps.waitingInput(tid);
        const status = store.run(run.id)?.status;
        if (wait && status === "running") store.setStatus(run.id, "waiting-input");
        else if (!wait && status === "waiting-input") store.setStatus(run.id, "running");
      }, this.deps.pollMs ?? 1000);

      let text = "";
      try {
        text = (await this.deps.send(tid, prompt)).text;
      } finally {
        clearInterval(timer);
      }
      if (store.run(run.id)?.status === "waiting-input") store.setStatus(run.id, "running");

      const totals = this.deps.totals(tid);
      const overBudget = a.budgetUsd !== null && totals.costUsd !== null && totals.costUsd > a.budgetUsd;
      let status: RunStatus = overBudget ? "paused-budget" : "succeeded";

      const key = `${run.runKey}:${this.deps.destination.id}`;
      store.checkpoint(run.id, { text, advances } satisfies Checkpoint);
      store.deliveryIntent(key, run.id, this.deps.destination.id);
      try {
        const receipt = await this.deps.destination.publish({ key, automationId: a.id, runId: run.id, threadId: tid, title: a.name, text });
        store.markPublished(key, receipt);
        store.confirmDelivery(key, receipt);
        // The bookmark only moves once the delivery is confirmed.
        this.advance(run.id);
      } catch {
        store.markUnknown(key);
        if (status === "succeeded") status = "partial";
      }

      const finished = store.finishRun(run.id, { status, costUsd: totals.costUsd, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, result: text });
      this.notify(finished, a);
    } catch (err) {
      const totals = threadId ? this.totalsOrNull(threadId) : null;
      const failed = store.finishRun(run.id, {
        status: "failed",
        error: reason(err),
        costUsd: totals?.costUsd,
        inputTokens: totals?.inputTokens,
        outputTokens: totals?.outputTokens,
      });
      this.notify(failed, a);
    }
  }

  /** Move the run's source cursors to what it read; only after its delivery is confirmed. */
  private advance(runId: number): void {
    const run = this.deps.store.run(runId);
    if (!run) return;
    for (const adv of checkpointOf(run).advances) this.deps.store.confirmSource(run.automationId, adv.source, adv.next);
  }

  private totalsOrNull(threadId: string): { costUsd: number | null; inputTokens: number; outputTokens: number } | null {
    try {
      return this.deps.totals(threadId);
    } catch {
      return null;
    }
  }

  /** A listener's failure must not corrupt the run it's hearing about. */
  private notify(run: AutomationRun, a: Automation): void {
    try {
      this.deps.notify(run, a);
    } catch {
      /* ignore */
    }
  }
}
